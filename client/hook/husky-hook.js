#!/usr/bin/env node
/**
 * Husky Claude Code 훅 클라이언트 (무의존성 단독 실행판)
 * ==============================================================================
 * Claude Code가 도구 실행 직전에 자식 프로세스로 실행하며, stdin으로 요청 JSON을 전달한다.
 *
 * 결정 경로는 두 단계다:
 *   1차) Husky 중앙 서버에 물어본다 (버튼 UI, 다중 세션 관제, 룰 엔진).
 *   2차) 서버에 닿지 못하면 디스코드 REST API로 **직접** 승인 메시지를 올리고
 *        ✅/❌ 리액션을 폴링한다. 서버가 꺼져 있어도 원격 승인이 가능하다.
 *   3차) 둘 다 불가하면 결정을 내리지 않고 Claude Code 기본 권한 흐름으로 넘긴다.
 *
 * 반환 규약 (docs/CLAUDE_CODE_INTEGRATION.md §2.2)
 *   - 승인: permissionDecision = "allow" + exit 0
 *   - 거부: permissionDecision = "deny"  + exit 2
 *   - 폴백: 아무것도 출력하지 않고 exit 0
 *
 * ⚠️ Claude Code 훅 API에는 "ask"라는 permissionDecision이 없다.
 *    공식 사양: "Exit code 0 with no output means the hook has no decision to report,
 *    so the tool call continues through the normal permission flow."
 *
 * client/ 폴더만 개발 PC에 복사하면 동작한다. 서버 소스도 node_modules도 필요 없다
 * (Node.js 내장 모듈만 사용). 같은 폴더의 agent/ 와 설정 파일을 공유한다.
 *
 * 설정 — 다음 순서로 탐색한다 (먼저 찾은 값이 이긴다):
 *   1) 프로세스 환경 변수
 *   2) client/.husky.env   (KEY=VALUE 한 줄씩) ← 기본 설정 위치. 에이전트와 공유한다
 *   3) 저장소 루트 .env    (서버 소스가 옆에 있을 때만. 서버와 같은 PC일 때 편하다)
 *
 *   HUSKY_URL                  서버 기본 URL. 스킴으로 http/https를 고른다.
 *                              예) https://xxxx.ngrok-free.app  ·  http://127.0.0.1:3001
 *                                  https://example.com/husky  (경로 접두사도 허용)
 *                              ⚠️ 이 값이 있으면 아래 HUSKY_HOST / HUSKY_PORT는 무시된다.
 *   HUSKY_HOST                 중앙 서버 주소 (기본 127.0.0.1). **HUSKY_URL이 없을 때만** 쓴다
 *   HUSKY_PORT                 중앙 서버 포트 (기본 3001). **HUSKY_URL이 없을 때만** 쓴다
 *   HUSKY_TOKEN                서버의 API_SECRET_KEY와 같은 값 (인증을 켠 경우)
 *   HUSKY_HOOK_TIMEOUT_MS      서버 응답 대기 (기본 1750000)
 *   HUSKY_TOTAL_BUDGET_MS      훅 전체 예산 (기본 1820000). 1차+2차가 이를 넘지 않도록 2차 대기를 줄인다
 *
 *   HUSKY_DIRECT_FALLBACK      디스코드 직접 폴백 사용 여부 (기본 on. "0"/"false"로 끄기)
 *   DISCORD_BOT_TOKEN          봇 토큰 (서버와 동일한 값을 쓰면 된다)
 *   DISCORD_CHANNEL_ID         승인 메시지를 올릴 채널 ID
 *   DISCORD_ALLOWED_USER_IDS   승인 권한을 가진 유저 ID (콤마 구분). 비면 아무도 승인 불가
 *   HUSKY_DIRECT_TIMEOUT_MS    리액션 대기 시간 (기본 480000 = 8분)
 *   HUSKY_HOST_LABEL           메시지에 표시할 PC 이름 (기본 hostname)
 *
 * 외부 의존성 없이 Node.js 내장 모듈만 사용한다.
 * ==============================================================================
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ALLOW_EMOJI = '✅';
const DENY_EMOJI = '❌';
const POLL_INTERVAL_MS = 3000;
const DISCORD_API_TIMEOUT_MS = 15000;
const FLUSH_GUARD_MS = 2000;

/**
 * 훅 전체 예산 기본값 (ms).
 * install.mjs의 TIMEOUT_SECONDS(1860초) − 40초. Claude Code가 훅을 죽이기 전에
 * 2차 폴백이 스스로 마무리할 수 있도록 여유를 둔 값이다.
 * 40초 내역: 마지막 폴링 주기 3초 + 리액션 조회 15초 + 마감 메시지 수정 15초 + 출력 플러시 2초.
 */
const DEFAULT_TOTAL_BUDGET_MS = 1820000;
/** 2차 폴백에 이만큼도 남지 않았으면 메시지를 올리지 않고 3차로 간다 (고아 메시지 방지) */
const MIN_DIRECT_WAIT_MS = 30000;

// 작업 전/후 비교 관련 상한값
/** 이 크기를 넘는 파일은 비교하지 않는다 (훅이 느려지면 Claude Code가 멈춘 것처럼 보인다) */
const PREVIEW_MAX_FILE_BYTES = 2 * 1024 * 1024;
/** 서버·디스코드로 보낼 diff 본문 상한 */
const PREVIEW_DIFF_MAX_CHARS = 12000;
/** 변경 줄 앞뒤로 함께 보여줄 동일 줄 수 */
const PREVIEW_CONTEXT_LINES = 3;
/** LCS 계산량 상한. 이를 넘으면 정밀 비교를 포기하고 통째 교체로 표시한다 */
const PREVIEW_LCS_CELL_LIMIT = 1200 * 1200;

// ==============================================================================
// 설정 로더
// ==============================================================================

/** KEY=VALUE 형식 파일을 파싱한다. 따옴표와 주석을 처리한다. */
function parseEnvFile(filePath) {
  const result = {};
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    return result;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();

    // 줄 끝 주석 제거 (따옴표로 감싸지 않은 경우에만)
    if (!/^["']/.test(value)) {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    // 감싼 따옴표 제거
    value = value.replace(/^(["'])(.*)\1$/, '$2');

    if (key) result[key] = value;
  }
  return result;
}

/**
 * 환경 변수 → client/.husky.env → 저장소 루트 .env 순으로 설정을 병합한다.
 *
 * 3단계는 **서버 소스가 실제로 옆에 있을 때만** 읽는다. client/ 를 홈 디렉터리 등으로
 * 복사한 경우 상위 폴더의 무관한 .env를 주워 오면 안 되기 때문이다.
 */
function loadConfig() {
  // client/hook/husky-hook.js → clientDir = client/
  const clientDir = path.resolve(__dirname, '..');
  const repoRoot = path.resolve(clientDir, '..');

  // 서버 소스가 옆에 있을 때만 저장소 .env를 후보로 삼는다.
  const insideRepo = fs.existsSync(path.join(repoRoot, 'src', 'backend'));

  // 뒤에 병합되는 것이 낮은 우선순위가 되도록 역순으로 쌓는다.
  const merged = Object.assign(
    {},
    insideRepo ? parseEnvFile(path.join(repoRoot, '.env')) : {},
    parseEnvFile(path.join(clientDir, '.husky.env'))
  );

  // 환경 변수가 최우선
  for (const key of Object.keys(merged)) {
    const fromEnv = (process.env[key] || '').trim();
    if (fromEnv) merged[key] = fromEnv;
  }
  // 파일에 없고 환경 변수에만 있는 값도 흡수
  for (const key of Object.keys(process.env)) {
    if (!(key in merged) && process.env[key]) merged[key] = process.env[key];
  }

  return merged;
}

function num(cfg, key, fallback) {
  const parsed = parseInt(cfg[key], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function bool(cfg, key, fallback) {
  const v = (cfg[key] || '').trim().toLowerCase();
  if (!v) return fallback;
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

function list(cfg, key) {
  return (cfg[key] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => s !== 'your_discord_user_id_here');
}

/**
 * 서버 접속 정보를 확정한다.
 *
 * HUSKY_URL이 있으면 그것만 쓰고 HUSKY_HOST/HUSKY_PORT는 무시한다. 스킴으로 http/https를
 * 고르므로 ngrok 같은 HTTPS 터널에 그대로 붙는다. 빈 문자열은 "미설정"으로 본다.
 *
 * 어떤 입력에도 예외를 던지지 않는다 — 파싱에 실패하면 HOST/PORT로 조용히 되돌아간다.
 * 훅이 여기서 죽으면 Claude Code가 멈춘다.
 *
 * @returns {{protocol: string, hostname: string, port: number, basePath: string}}
 */
function resolveServer(cfg) {
  const legacy = {
    protocol: 'http:',
    hostname: cfg.HUSKY_HOST || '127.0.0.1',
    port: num(cfg, 'HUSKY_PORT', 3001),
    basePath: '',
  };

  const raw = (cfg.HUSKY_URL || '').trim();
  if (!raw) return legacy;

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (e) {
    return legacy;
  }

  // http/https 외의 스킴(ws://, file:// 등)은 이 경로로 쓸 수 없다.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return legacy;
  if (!parsed.hostname) return legacy;

  const defaultPort = parsed.protocol === 'https:' ? 443 : 80;
  const port = parsed.port ? parseInt(parsed.port, 10) : defaultPort;

  // 경로 접두사(리버스 프록시가 하위 경로로 붙인 경우)를 보존하되 끝 '/'는 뗀다.
  let basePath = parsed.pathname || '';
  if (basePath === '/') basePath = '';
  basePath = basePath.replace(/\/+$/, '');

  return {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: Number.isFinite(port) && port > 0 ? port : defaultPort,
    basePath: basePath,
  };
}

// ==============================================================================
// 출력 규약
// ==============================================================================

/** stdout 플러시를 기다렸다가 종료한다 (출력 잘림 방지). */
function exitWith(json, code) {
  const guard = setTimeout(() => process.exit(code), FLUSH_GUARD_MS);
  if (guard.unref) guard.unref();

  if (json === null) {
    clearTimeout(guard);
    process.exit(code);
    return;
  }

  process.stdout.write(json, () => {
    clearTimeout(guard);
    process.exit(code);
  });
}

/** 승인/거부 결정을 Claude Code에 전달한다. */
function respondDecision(eventName, decision, reason) {
  const output = {
    hookSpecificOutput: {
      hookEventName: eventName,
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
  // 거부는 종료 코드 2로 도구 실행을 차단한다 (1은 일반 에러로 처리되어 차단되지 않는다).
  exitWith(JSON.stringify(output) + '\n', decision === 'deny' ? 2 : 0);
}

/** 결정하지 않고 Claude Code 기본 권한 흐름으로 넘긴다. */
function deferToNormalFlow() {
  exitWith(null, 0);
}

// ==============================================================================
// 작업 전/후 비교 (diff)
// ==============================================================================
// 서버는 다른 기기(예: Mac mini)에 있을 수 있어 대상 파일을 읽지 못한다.
// 따라서 "작업 전" 내용은 파일이 실제로 존재하는 이 PC에서, 즉 훅이 직접 읽어
// 비교 결과까지 만들어 보낸다. 서버와 봇은 결과를 렌더링만 한다.
// ==============================================================================

/** 텍스트를 줄 배열로 나눈다. 끝의 개행 하나는 줄 수에 포함하지 않는다. */
function splitLines(text) {
  if (!text) return [];
  const t = text.endsWith('\n') ? text.slice(0, -1) : text;
  return t.split('\n');
}

/** NUL 바이트가 있으면 바이너리로 본다. */
function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function formatBytes(n) {
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'KB';
  return (n / 1024 / 1024).toFixed(1) + 'MB';
}

/**
 * 두 줄 배열을 비교해 [기호, 내용] 연산 목록을 만든다.
 * 기호는 ' '(동일) / '-'(삭제) / '+'(추가).
 *
 * 공통 앞·뒤 구간을 먼저 떼어내므로, 큰 파일의 일부만 바뀐 흔한 경우에
 * LCS 대상이 크게 줄어든다.
 */
function diffOps(before, after) {
  const ops = [];
  let added = 0;
  let removed = 0;
  let coarse = false;

  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;

  let tb = before.length;
  let ta = after.length;
  while (tb > head && ta > head && before[tb - 1] === after[ta - 1]) {
    tb--;
    ta--;
  }

  for (let i = 0; i < head; i++) ops.push([' ', before[i]]);

  const mb = before.slice(head, tb);
  const ma = after.slice(head, ta);

  if (mb.length * ma.length > PREVIEW_LCS_CELL_LIMIT) {
    // 변경 범위가 너무 넓다. 정밀 비교를 포기하고 통째로 교체된 것으로 표시한다.
    coarse = true;
    for (let i = 0; i < mb.length; i++) {
      ops.push(['-', mb[i]]);
      removed++;
    }
    for (let i = 0; i < ma.length; i++) {
      ops.push(['+', ma[i]]);
      added++;
    }
  } else {
    const n = mb.length;
    const m = ma.length;
    const w = m + 1;
    const dp = new Int32Array((n + 1) * w);

    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        if (mb[i] === ma[j]) {
          dp[i * w + j] = dp[(i + 1) * w + (j + 1)] + 1;
        } else {
          const down = dp[(i + 1) * w + j];
          const right = dp[i * w + (j + 1)];
          dp[i * w + j] = down >= right ? down : right;
        }
      }
    }

    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (mb[i] === ma[j]) {
        ops.push([' ', mb[i]]);
        i++;
        j++;
      } else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) {
        ops.push(['-', mb[i]]);
        i++;
        removed++;
      } else {
        ops.push(['+', ma[j]]);
        j++;
        added++;
      }
    }
    while (i < n) {
      ops.push(['-', mb[i++]]);
      removed++;
    }
    while (j < m) {
      ops.push(['+', ma[j++]]);
      added++;
    }
  }

  for (let i = tb; i < before.length; i++) ops.push([' ', before[i]]);

  return { ops: ops, added: added, removed: removed, coarse: coarse };
}

/**
 * 연산 목록을 unified diff 본문으로 렌더링한다.
 * 변경이 없는 구간은 접고, 변경 줄 주변 context만 남긴다.
 */
function renderDiff(ops, maxChars) {
  const keep = new Array(ops.length).fill(false);
  for (let i = 0; i < ops.length; i++) {
    if (ops[i][0] === ' ') continue;
    const from = Math.max(0, i - PREVIEW_CONTEXT_LINES);
    const to = Math.min(ops.length - 1, i + PREVIEW_CONTEXT_LINES);
    for (let k = from; k <= to; k++) keep[k] = true;
  }

  const out = [];
  let beforeNo = 0;
  let afterNo = 0;
  let i = 0;

  while (i < ops.length) {
    if (!keep[i]) {
      // 접히는 구간 — 줄 번호만 앞으로 감는다.
      while (i < ops.length && !keep[i]) {
        if (ops[i][0] !== '+') beforeNo++;
        if (ops[i][0] !== '-') afterNo++;
        i++;
      }
      continue;
    }

    const startBefore = beforeNo + 1;
    const startAfter = afterNo + 1;
    let countBefore = 0;
    let countAfter = 0;
    const body = [];

    while (i < ops.length && keep[i]) {
      const sign = ops[i][0];
      if (sign !== '+') {
        beforeNo++;
        countBefore++;
      }
      if (sign !== '-') {
        afterNo++;
        countAfter++;
      }
      body.push(sign + ' ' + ops[i][1]);
      i++;
    }

    // 표준 unified 헤더. 디스코드의 diff 문법 강조가 이 형식을 인식한다.
    out.push('@@ -' + startBefore + ',' + countBefore + ' +' + startAfter + ',' + countAfter + ' @@');
    out.push(body.join('\n'));
  }

  const text = out.join('\n');
  if (text.length <= maxChars) return { diff: text, truncated: false };
  return { diff: text.slice(0, maxChars), truncated: true };
}

/** 비교 불가 결과를 만든다. */
function unavailablePreview(filePath, note) {
  return {
    kind: 'unavailable',
    filePath: filePath,
    existed: false,
    beforeLines: 0,
    afterLines: 0,
    beforeBytes: 0,
    afterBytes: 0,
    added: 0,
    removed: 0,
    diff: '',
    truncated: false,
    note: note,
  };
}

/**
 * Edit / Write 요청의 작업 전/후 비교 정보를 만든다.
 * 비교 대상이 아니거나 경로가 없으면 null을 반환한다.
 * 어떤 경우에도 예외를 던지지 않는다 — 비교 실패가 승인 흐름을 막으면 안 된다.
 */
function buildChangePreview(payload) {
  const tool = payload.tool_name;
  if (tool !== 'Edit' && tool !== 'Write') return null;

  const ti = payload.tool_input || {};
  const filePath = typeof ti.file_path === 'string' ? ti.file_path : '';
  if (!filePath) return null;

  try {
    let existed = false;
    let beforeText = '';
    let beforeBytes = 0;

    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return unavailablePreview(filePath, '파일이 아닙니다.');
      if (stat.size > PREVIEW_MAX_FILE_BYTES) {
        return unavailablePreview(
          filePath,
          '파일이 너무 큽니다 (' + formatBytes(stat.size) + '). 비교를 생략했습니다.'
        );
      }
      const buf = fs.readFileSync(filePath);
      if (looksBinary(buf)) {
        return unavailablePreview(filePath, '바이너리 파일이라 비교할 수 없습니다.');
      }
      existed = true;
      beforeText = buf.toString('utf-8');
      beforeBytes = buf.length;
    } catch (e) {
      if (!e || e.code !== 'ENOENT') {
        return unavailablePreview(filePath, '원본을 읽지 못했습니다: ' + ((e && e.code) || 'unknown'));
      }
      // ENOENT — 새로 만드는 파일이다.
    }

    let afterText;
    let kind;
    let note;

    if (tool === 'Write') {
      afterText = typeof ti.content === 'string' ? ti.content : typeof ti.text === 'string' ? ti.text : '';
      kind = existed ? 'overwrite' : 'create';
    } else {
      const oldStr = typeof ti.old_string === 'string' ? ti.old_string : '';
      const newStr = typeof ti.new_string === 'string' ? ti.new_string : '';
      kind = 'edit';

      if (!existed) {
        return unavailablePreview(filePath, '원본 파일이 없어 비교할 수 없습니다.');
      }
      if (!oldStr) {
        return unavailablePreview(filePath, 'old_string이 비어 있어 비교할 수 없습니다.');
      }

      const at = beforeText.indexOf(oldStr);
      if (at < 0) {
        // 원본과 맞지 않는 수정이다. 그 자체로 중요한 경고이므로 알려준다.
        note = '⚠️ 원본에서 변경 대상 문자열을 찾지 못했습니다. 아래는 요청된 치환 내용만 표시한 것입니다.';
        const r = diffOps(splitLines(oldStr), splitLines(newStr));
        const rendered = renderDiff(r.ops, PREVIEW_DIFF_MAX_CHARS);
        return {
          kind: 'edit',
          filePath: filePath,
          existed: true,
          beforeLines: splitLines(beforeText).length,
          afterLines: splitLines(beforeText).length,
          beforeBytes: beforeBytes,
          afterBytes: beforeBytes,
          added: r.added,
          removed: r.removed,
          diff: rendered.diff,
          truncated: rendered.truncated,
          note: note,
        };
      }

      if (ti.replace_all === true) {
        afterText = beforeText.split(oldStr).join(newStr);
        const times = beforeText.split(oldStr).length - 1;
        note = '`replace_all` — ' + times + '곳을 치환합니다.';
      } else {
        afterText = beforeText.slice(0, at) + newStr + beforeText.slice(at + oldStr.length);
      }
    }

    const beforeLines = splitLines(beforeText);
    const afterLines = splitLines(afterText);
    const r = diffOps(beforeLines, afterLines);
    const rendered = renderDiff(r.ops, PREVIEW_DIFF_MAX_CHARS);

    if (r.coarse) {
      note = (note ? note + ' ' : '') + '변경 범위가 넓어 정밀 비교 대신 전체 교체로 표시합니다.';
    }

    return {
      kind: kind,
      filePath: filePath,
      existed: existed,
      beforeLines: beforeLines.length,
      afterLines: afterLines.length,
      beforeBytes: beforeBytes,
      afterBytes: Buffer.byteLength(afterText, 'utf-8'),
      added: r.added,
      removed: r.removed,
      diff: rendered.diff,
      truncated: rendered.truncated,
      note: note,
    };
  } catch (e) {
    return unavailablePreview(filePath, '비교 중 오류가 발생했습니다: ' + ((e && e.message) || 'unknown'));
  }
}

/** 디스코드 메시지에 넣을 한 줄짜리 변경 요약. */
function previewSummary(p) {
  const labels = {
    create: '🆕 새 파일 생성',
    overwrite: '♻️ 기존 파일 덮어쓰기',
    edit: '✏️ 부분 수정',
    unavailable: '❔ 비교 불가',
  };
  const label = labels[p.kind] || p.kind;

  if (p.kind === 'unavailable') {
    return label + (p.note ? ' — ' + p.note : '');
  }

  return (
    label +
    ' · `+' + p.added + ' / -' + p.removed + '` 줄 · ' +
    p.beforeLines + '줄 → ' + p.afterLines + '줄 · ' +
    formatBytes(p.beforeBytes) + ' → ' + formatBytes(p.afterBytes)
  );
}

// ==============================================================================
// 1차 경로 — Husky 중앙 서버
// ==============================================================================

/**
 * 중앙 서버에 결정을 요청한다.
 * @returns {Promise<{decision: string, reason: string}|null>} 서버에 닿지 못하면 null
 */
function askServer(payload, cfg, preview) {
  return new Promise((resolve) => {
    const timeoutMs = num(cfg, 'HUSKY_HOOK_TIMEOUT_MS', 1750000);

    const postData = JSON.stringify({
      sessionId: payload.session_id || fallbackSessionId(cfg),
      toolName: payload.tool_name || 'Unknown',
      toolInput: payload.tool_input || {},
      cwd: payload.cwd || process.cwd(),
      hostname: hostLabel(cfg),
      toolUseId: payload.tool_use_id,
      permissionMode: payload.permission_mode,
      timeoutMs: timeoutMs,
      // 작업 전/후 비교는 파일이 있는 이 PC에서만 만들 수 있다.
      changePreview: preview || undefined,
    });

    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
    };
    if (cfg.HUSKY_TOKEN) headers.Authorization = 'Bearer ' + cfg.HUSKY_TOKEN;

    // 스킴에 따라 모듈을 고른다. https 옵션은 http와 같은 의미로 동작한다
    // (TLS 검증은 기본값 그대로 — rejectUnauthorized를 끄면 터널 구간이 무방비가 된다).
    const server = resolveServer(cfg);
    const transport = server.protocol === 'https:' ? https : http;

    const req = transport.request(
      {
        hostname: server.hostname,
        port: server.port,
        path: server.basePath + '/api/v1/hooks/request',
        method: 'POST',
        headers: headers,
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          // 401/403은 "서버에 닿지 못함"이 아니라 "서버는 살아 있고 토큰이 틀림"이다.
          // 서버가 살아 있는데 디스코드 직접 폴백까지 가면 중복·오인 알림이 되므로
          // 서버의 'ask'와 같은 취급으로 2차를 건너뛰고 로컬 권한 흐름에 넘긴다.
          // 진단은 `node install.mjs --doctor`.
          if (res.statusCode === 401 || res.statusCode === 403) {
            resolve({ decision: 'ask', reason: '서버 인증 실패 (' + res.statusCode + ')' });
            return;
          }
          // 그 밖의 비정상 응답은 서버에 닿지 못한 것으로 보고 디스코드 직접 폴백을 시도한다.
          if (!res.statusCode || res.statusCode >= 400) {
            resolve(null);
            return;
          }
          try {
            const parsed = JSON.parse(body);
            resolve({
              decision: parsed.decision || 'ask',
              reason: parsed.reason || 'Husky Proxy 결정',
            });
          } catch (e) {
            resolve(null);
          }
        });
      }
    );

    // 10분 long-poll 동안 양방향 0바이트라 중간 장비(NAT·방화벽·프록시)가 유휴 연결을 끊을 수 있다.
    // TCP keep-alive로 60초마다 conntrack을 갱신한다. 서버 응답 대기 자체(timeout)와는 별개다.
    req.on('socket', (s) => s.setKeepAlive(true, 60000));

    // 서버가 꺼져 있음(ECONNREFUSED) 또는 네트워크 도달 불가
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });

    req.write(postData);
    req.end();
  });
}

// ==============================================================================
// 2차 경로 — 디스코드 직접 승인 (리액션 폴링)
// ==============================================================================

function hostLabel(cfg) {
  if (cfg.HUSKY_HOST_LABEL) return cfg.HUSKY_HOST_LABEL;
  try {
    return os.hostname();
  } catch (e) {
    return 'unknown-host';
  }
}

/**
 * Claude Code가 session_id를 주지 않았을 때 쓸 대체 세션 ID.
 *
 * 'default-session' 한 값을 쓰면 여러 PC의 요청이 서버에서 세션 레코드 하나를
 * 덮어쓰며 합쳐진다(sessionManager는 id 단독 키다). PC 이름을 섞어 PC별로 갈라 놓는다.
 *
 * 문자셋·길이는 Windows 에이전트가 이 값을 파일명으로 쓰는 제약을 따른다 —
 * client/agent/src/usageCollector.ts:62 SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/,
 * client/agent/src/usageAggregate.ts:88 MAX_SESSION_ID_LENGTH = 255.
 * 벗어나면 토큰 사용량 수집이 예외 없이 0이 된다.
 */
function fallbackSessionId(cfg) {
  const safe = hostLabel(cfg).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64);
  return 'nosession-' + (safe || 'unknown-host');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 디스코드 REST API 호출. 429를 만나면 retry_after만큼 기다렸다가 한 번 재시도한다. */
function discordApi(method, apiPath, token, body, retried) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {
      Authorization: 'Bot ' + token,
      'User-Agent': 'husky-claude-discord-proxy/1.0',
    };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }

    const req = https.request(
      {
        hostname: 'discord.com',
        path: '/api/v10' + apiPath,
        method: method,
        headers: headers,
        timeout: DISCORD_API_TIMEOUT_MS,
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf-8');
        res.on('data', (c) => {
          raw += c;
        });
        res.on('end', () => {
          // rate limit — 지정된 시간만큼 쉬고 한 번만 재시도
          if (res.statusCode === 429 && !retried) {
            let waitMs = 1000;
            try {
              const parsed = JSON.parse(raw);
              if (parsed.retry_after) waitMs = Math.ceil(parsed.retry_after * 1000);
            } catch (e) {
              /* 기본값 사용 */
            }
            setTimeout(() => {
              discordApi(method, apiPath, token, body, true).then(resolve, reject);
            }, Math.min(waitMs, 10000));
            return;
          }

          if (!res.statusCode || res.statusCode >= 400) {
            reject(new Error('Discord API ' + res.statusCode + ': ' + raw.slice(0, 200)));
            return;
          }

          try {
            resolve(raw ? JSON.parse(raw) : {});
          } catch (e) {
            reject(e);
          }
        });
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Discord API 요청 시간 초과'));
    });

    if (data) req.write(data);
    req.end();
  });
}

/** 승인 메시지 본문을 만든다. */
function buildMessage(payload, cfg, preview) {
  const tool = payload.tool_name || 'Unknown';
  const ti = payload.tool_input || {};
  const cwd = payload.cwd || '';

  let detail = '';

  if (tool === 'Bash') {
    const cmd = String(ti.command || '(명령어 없음)');
    detail = '\n**실행할 명령**\n```bash\n' + truncate(cmd, 900) + '\n```';
  } else if (tool === 'Edit' || tool === 'Write') {
    const file = String(ti.file_path || '(경로 없음)');
    detail = '\n**대상 파일**\n`' + file + '`';

    if (preview) {
      detail += '\n**변경 요약:** ' + previewSummary(preview);
      if (preview.diff) {
        detail += '\n**작업 전/후 비교**\n```diff\n' + truncate(preview.diff, 700) + '\n```';
        if (preview.truncated) {
          detail += '\n_diff가 길어 일부만 표시했습니다._';
        }
      }
      if (preview.note && preview.kind !== 'unavailable') {
        detail += '\n_' + preview.note + '_';
      }
    } else {
      // 비교를 만들지 못한 경우(경로 없음 등)의 최소 표시
      const oldStr = String(ti.old_string || '');
      const newStr = String(ti.new_string || ti.content || ti.text || '');
      if (oldStr || newStr) {
        let fallback = '';
        for (const l of oldStr.split('\n').slice(0, 8)) fallback += '- ' + l + '\n';
        for (const l of newStr.split('\n').slice(0, 8)) fallback += '+ ' + l + '\n';
        detail += '\n**변경 내용**\n```diff\n' + truncate(fallback, 700) + '\n```';
      }
    }
  } else {
    detail = '\n```json\n' + truncate(JSON.stringify(ti, null, 2), 700) + '\n```';
  }

  const lines = [
    '🔐 **Claude Code 권한 요청** · 💻 `' + hostLabel(cfg) + '`',
    '⚠️ _Husky 서버에 연결할 수 없어 훅이 직접 요청합니다 (직접 승인 모드)_',
    '',
    '**도구:** `' + tool + '`',
  ];
  if (cwd) lines.push('**작업 경로:** `' + truncate(cwd, 200) + '`');
  lines.push(detail);
  lines.push('');
  lines.push(ALLOW_EMOJI + ' 허용   /   ' + DENY_EMOJI + ' 거부');

  return truncate(lines.join('\n'), 1950);
}

function truncate(value, limit) {
  const s = String(value);
  if (s.length <= limit) return s;
  return s.slice(0, limit) + '\n... (생략)';
}

/**
 * 특정 이모지에 리액션을 단 사람 중 승인 권한자를 찾는다.
 *
 * py 버전은 리액션 개수만 세어 "채널의 아무나 누르면 승인"되는 문제가 있었다.
 * 여기서는 실제 유저 목록을 조회하여 허용 목록에 있는 사람인지 검증한다.
 * 봇이 단 리액션은 bot 플래그로 걸러진다.
 */
async function findAuthorizedReactor(channelId, messageId, emoji, token, allowedIds) {
  const users = await discordApi(
    'GET',
    '/channels/' + channelId + '/messages/' + messageId + '/reactions/' + encodeURIComponent(emoji) + '?limit=100',
    token
  );

  if (!Array.isArray(users)) return null;

  for (const u of users) {
    if (!u || u.bot) continue;
    if (allowedIds.includes(String(u.id))) {
      return u;
    }
  }
  return null;
}

/**
 * 디스코드에 직접 승인 메시지를 올리고 리액션으로 결정을 받는다.
 *
 * @param {number} timeoutMs 리액션 대기 시간. 남은 예산을 호출부가 계산해 넘긴다
 *                           (1차가 오래 끌었으면 짧아진다 — C6).
 * @returns {Promise<{decision: string, reason: string}|null>} 실패하면 null
 */
async function askDiscordDirect(payload, cfg, preview, timeoutMs) {
  const token = cfg.DISCORD_BOT_TOKEN;
  const channelId = cfg.DISCORD_CHANNEL_ID;
  const allowedIds = list(cfg, 'DISCORD_ALLOWED_USER_IDS');

  if (!token || !channelId) return null;

  // 승인자 목록이 없으면 아무도 승인할 수 없다. 메시지를 올려봐야 의미가 없다.
  if (allowedIds.length === 0) return null;

  const content = buildMessage(payload, cfg, preview);

  // 1) 메시지 게시
  let messageId;
  try {
    const msg = await discordApi('POST', '/channels/' + channelId + '/messages', token, {
      content: content,
    });
    messageId = msg.id;
  } catch (e) {
    return null;
  }
  if (!messageId) return null;

  // 2) ✅/❌ 리액션 부착 (사용자가 탭하기 쉽도록)
  let reactionAttached = true;
  for (const emoji of [ALLOW_EMOJI, DENY_EMOJI]) {
    try {
      await discordApi(
        'PUT',
        '/channels/' + channelId + '/messages/' + messageId + '/reactions/' + encodeURIComponent(emoji) + '/@me',
        token
      );
    } catch (e) {
      reactionAttached = false;
    }
  }

  // 봇이 리액션을 달았으면 기본 개수가 1이므로, 사용자가 추가하면 2가 된다.
  const threshold = reactionAttached ? 2 : 1;
  const deadline = Date.now() + timeoutMs;

  // 3) 리액션 폴링
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    let msg;
    try {
      msg = await discordApi('GET', '/channels/' + channelId + '/messages/' + messageId, token);
    } catch (e) {
      continue; // 일시적 오류는 다음 주기에 재시도
    }

    const counts = {};
    for (const r of msg.reactions || []) {
      if (r && r.emoji && r.emoji.name) counts[r.emoji.name] = r.count || 0;
    }

    // 개수가 늘어난 경우에만 유저 목록을 조회하여 권한을 검증한다 (호출 절약).
    if ((counts[ALLOW_EMOJI] || 0) >= threshold) {
      try {
        const user = await findAuthorizedReactor(channelId, messageId, ALLOW_EMOJI, token, allowedIds);
        if (user) {
          await finalizeMessage(channelId, messageId, token, content, '✅ **' + (user.username || user.id) + ' 님이 승인함**');
          return { decision: 'allow', reason: '디스코드 직접 승인 (' + (user.username || user.id) + ')' };
        }
      } catch (e) {
        /* 다음 주기에 재시도 */
      }
    }

    if ((counts[DENY_EMOJI] || 0) >= threshold) {
      try {
        const user = await findAuthorizedReactor(channelId, messageId, DENY_EMOJI, token, allowedIds);
        if (user) {
          await finalizeMessage(channelId, messageId, token, content, '❌ **' + (user.username || user.id) + ' 님이 거부함**');
          return { decision: 'deny', reason: '디스코드 직접 거부 (' + (user.username || user.id) + ')' };
        }
      } catch (e) {
        /* 다음 주기에 재시도 */
      }
    }
  }

  // 4) 타임아웃 — 로컬 권한 프롬프트로 넘어간다는 사실을 메시지에 남긴다.
  await finalizeMessage(
    channelId,
    messageId,
    token,
    content,
    '⏰ **' + Math.round(timeoutMs / 1000) + '초 무응답 → 로컬 권한 프롬프트로 전환됨**'
  );
  return null;
}

/** 결과를 원본 메시지에 덧붙인다. 실패해도 결정 흐름에는 영향을 주지 않는다. */
async function finalizeMessage(channelId, messageId, token, original, suffix) {
  try {
    await discordApi('PATCH', '/channels/' + channelId + '/messages/' + messageId, token, {
      content: truncate(original + '\n\n' + suffix, 1990),
    });
  } catch (e) {
    /* 무시 */
  }
}

// ==============================================================================
// 진입점
// ==============================================================================

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('{}');
      return;
    }
    // Windows 로케일(CP949)로 디코딩되지 않도록 바이너리로 읽어 UTF-8로 해석한다.
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', () => resolve(''));
  });
}

async function main() {
  // 훅 전체 예산의 기준점. stdin을 읽기 전에 잡아야 실제 경과와 어긋나지 않는다.
  const startedAt = Date.now();
  const rawInput = await readStdin();

  let payload;
  try {
    payload = JSON.parse(rawInput || '{}');
  } catch (e) {
    deferToNormalFlow();
    return;
  }

  const cfg = loadConfig();
  const eventName = payload.hook_event_name || 'PreToolUse';

  // 작업 전/후 비교는 파일을 읽어야 하므로 한 번만 계산해 두 경로에서 재사용한다.
  const preview = buildChangePreview(payload);

  // 1차: 중앙 서버
  const serverResult = await askServer(payload, cfg, preview);
  if (serverResult) {
    if (serverResult.decision === 'allow' || serverResult.decision === 'deny') {
      respondDecision(eventName, serverResult.decision, serverResult.reason);
      return;
    }
    // 서버가 'ask'를 돌려줬다 = 서버는 살아있으나 시간 내 결정이 없었다.
    // 중복 알림을 막기 위해 디스코드 직접 폴백을 시도하지 않는다.
    deferToNormalFlow();
    return;
  }

  // 2차: 디스코드 직접 승인 (서버에 닿지 못한 경우에만)
  //
  // 1차가 예산을 대부분 써 버린 경우(서버가 TCP는 받았으나 응답하지 않는 등)에 2차를
  // 그대로 시작하면 settings.json의 timeout을 넘겨 Claude Code가 훅을 죽인다. 그러면
  // 디스코드에는 **아무도 기다리지 않는 고아 승인 메시지**가 남는다.
  // 그래서 남은 예산만큼만 기다리고, 의미 있게 기다릴 수 없으면 아예 올리지 않는다.
  if (bool(cfg, 'HUSKY_DIRECT_FALLBACK', true)) {
    const remaining = num(cfg, 'HUSKY_TOTAL_BUDGET_MS', DEFAULT_TOTAL_BUDGET_MS) - (Date.now() - startedAt);
    const directTimeoutMs = Math.min(num(cfg, 'HUSKY_DIRECT_TIMEOUT_MS', 480000), remaining);

    if (directTimeoutMs < MIN_DIRECT_WAIT_MS) {
      deferToNormalFlow();
      return;
    }

    try {
      const directResult = await askDiscordDirect(payload, cfg, preview, directTimeoutMs);
      if (directResult) {
        respondDecision(eventName, directResult.decision, directResult.reason);
        return;
      }
    } catch (e) {
      /* 폴백 실패 — 아래 기본 흐름으로 */
    }
  }

  // 3차: 결정 없음 → Claude Code 기본 권한 흐름
  deferToNormalFlow();
}

main().catch(() => deferToNormalFlow());
