#!/usr/bin/env node
/**
 * Husky 훅 설치 도구
 * ==============================================================================
 * Claude Code의 settings.json에 이 폴더의 husky-hook.js를 등록한다.
 *
 *   node install.mjs              사용자 전체(~/.claude/settings.json)에 설치
 *   node install.mjs --project    현재 프로젝트(./.claude/settings.json)에만 설치
 *   node install.mjs --check      현재 상태만 확인 (아무것도 바꾸지 않음)
 *   node install.mjs --doctor     --check + 서버 도달성·인증·타임아웃 체인 진단
 *   node install.mjs --remove     등록 해제
 *
 * ⚠️ 읽기 전용 명령(--check / --doctor)은 **프로젝트와 사용자 전역 설정을 모두** 살핀다.
 *    Claude Code가 두 파일의 훅을 합쳐 실행하기 때문이다. 한쪽만 보면 --project 로 설치한
 *    멀쩡한 구성을 "등록되지 않음"으로 오진한다.
 *    --project 를 붙이면 예전처럼 프로젝트 설정만 본다.
 *    쓰기 명령(설치 / --remove)은 지금까지처럼 한쪽에만 작용한다.
 *
 * 훅은 이것만으로 동작한다. 데스크톱 알림까지 쓰려면 agent/ 에서 npm install 이 필요하다
 * (`npm run agent:install`). 에이전트는 선택 사항이라 여기서 자동 설치하지 않는다.
 *
 * 기존 설정은 보존한다. 다른 훅이 등록되어 있어도 건드리지 않으며,
 * 덮어쓰기 전에 settings.json.husky-backup 으로 백업을 남긴다.
 * ==============================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

/** client/ 폴더 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 훅 스크립트는 hook/ 하위에 있다 (의존성 0을 강제하기 위해 패키지를 분리했다) */
const HOOK_PATH = path.join(HERE, 'hook', 'husky-hook.js');

/** 훅이 감시할 도구. 읽기 전용 도구는 제외해야 불필요한 지연이 없다. */
const MATCHER = 'Bash|Write|Edit';

/**
 * 훅 타임아웃 — **초 단위**다 (밀리초 아님).
 * 서버 .env의 HOOK_TIMEOUT_MS(밀리초)보다 커야 서버가 먼저 폴백을 결정할 수 있다.
 * 예: HOOK_TIMEOUT_MS=1740000(1740초) → 1860
 *
 * 서버가 29분으로 줄어든 뒤에도 1860을 유지하는 이유: 2차 리액션 폴백(최대 8분)이
 * 이 예산 안에서 돌기 때문이다. 여기를 줄이면 2차가 함께 줄거나 생략된다.
 *
 * 훅의 HUSKY_TOTAL_BUDGET_MS 기본값 1820000은 이 값 − 40초다 (대기 종료 후
 * 마감 메시지 수정·플러시에 드는 시간).
 * 이 값을 바꾸면 client/.husky.env의 HUSKY_TOTAL_BUDGET_MS도 함께 맞춰야 한다.
 */
const TIMEOUT_SECONDS = 1860;

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);

const log = (msg) => console.log(msg);
const warn = (msg) => console.warn(`⚠️  ${msg}`);
const fail = (msg) => {
  console.error(`❌ ${msg}`);
  process.exit(1);
};

// ------------------------------------------------------------------------------
// 설정 파일 위치
// ------------------------------------------------------------------------------

/** 현재 프로젝트 설정 (./.claude/settings.json) — 쓰기 명령은 항상 cwd 기준이다. */
function projectSettingsPath() {
  return path.resolve(process.cwd(), '.claude', 'settings.json');
}

/**
 * 읽기 전용 명령이 볼 프로젝트 설정 파일을 찾는다.
 *
 * cwd에 없으면 상위로 거슬러 올라간다. `npm run doctor`는 cwd가 client/ 라서
 * 거기만 보면 저장소 루트(.claude/settings.json)의 등록을 놓치고 "등록 안 됨"으로
 * 오진한다. Claude Code 자신도 프로젝트 루트 기준으로 읽는다.
 *
 * 못 찾으면 cwd 기준 경로를 그대로 돌려준다 (표시는 "파일 없음"이 된다).
 */
function discoverProjectSettingsPath() {
  const userFile = path.resolve(userSettingsPath()).toLowerCase();
  let dir = process.cwd();
  for (;;) {
    const candidate = path.join(dir, '.claude', 'settings.json');
    // 홈 디렉터리 아래에서 돌리면 ~/.claude/settings.json 이 걸린다. 그건 '사용자 전역'이지
    // 프로젝트 설정이 아니므로 건너뛴다 (같은 파일을 두 이름으로 보고하면 안 된다).
    if (fs.existsSync(candidate) && path.resolve(candidate).toLowerCase() !== userFile) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return projectSettingsPath();
    dir = parent;
  }
}

/** 사용자 전역 설정 (~/.claude/settings.json) */
function userSettingsPath() {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

/** 쓰기 명령(설치 / --remove)이 작용할 단 하나의 파일. */
function settingsPath() {
  return has('--project') ? projectSettingsPath() : userSettingsPath();
}

function readSettings(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf-8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    fail(
      `${file} 을(를) 읽을 수 없습니다 (JSON 문법 오류).\n` +
        `   직접 고친 뒤 다시 실행하세요: ${err.message}`
    );
  }
}

function writeSettings(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  if (fs.existsSync(file)) {
    const backup = `${file}.husky-backup`;
    fs.copyFileSync(file, backup);
    log(`   백업: ${backup}`);
  }

  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

// ------------------------------------------------------------------------------
// 훅 항목 조작
// ------------------------------------------------------------------------------

/** husky-hook.js를 가리키는 훅인지 판별한다 (경로가 달라도 파일명으로 인식). */
function isHuskyHook(entry) {
  return typeof entry?.command === 'string' && entry.command.includes('husky-hook.js');
}

function buildEntry() {
  // 경로에 공백이 있을 수 있으므로 따옴표로 감싼다.
  const quoted = HOOK_PATH.includes(' ') ? `"${HOOK_PATH}"` : HOOK_PATH;
  return {
    type: 'command',
    command: `node ${quoted.replace(/\\/g, '/')}`,
    timeout: TIMEOUT_SECONDS,
  };
}

function findHusky(settings) {
  const groups = settings?.hooks?.PreToolUse;
  if (!Array.isArray(groups)) return [];

  const found = [];
  for (const group of groups) {
    if (!Array.isArray(group?.hooks)) continue;
    for (const entry of group.hooks) {
      if (isHuskyHook(entry)) found.push({ group, entry });
    }
  }
  return found;
}

/**
 * 읽기 전용 명령이 살펴볼 설정 파일 목록.
 *
 * Claude Code는 프로젝트와 사용자 전역 설정의 훅을 **합쳐서** 실행한다. 그래서 진단은
 * 양쪽을 모두 봐야 한다. 한쪽만 보면 --project 로 설치한 구성을 "등록되지 않음"으로
 * 오진하고, 이어지는 타임아웃 체인 판정까지 엉뚱하게 실패한다.
 *
 * --project 를 붙이면 그 범위만 본다(기존 동작 유지).
 *
 * @returns {{label: string, file: string, exists: boolean, settings: object, registered: Array}[]}
 */
function collectScopes() {
  const candidates = has('--project')
    ? [{ label: '프로젝트', file: discoverProjectSettingsPath() }]
    : [
        { label: '프로젝트', file: discoverProjectSettingsPath() },
        { label: '사용자 전역', file: userSettingsPath() },
      ];

  const seen = new Set();
  const scopes = [];
  for (const c of candidates) {
    // 홈 디렉터리에서 실행하면 두 경로가 같을 수 있다. 같은 파일을 두 번 세면 중복 등록으로 오인한다.
    const key = path.resolve(c.file).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const settings = readSettings(c.file);
    scopes.push({
      ...c,
      exists: fs.existsSync(c.file),
      settings,
      registered: findHusky(settings),
    });
  }
  return scopes;
}

function install(file, settings) {
  settings.hooks ??= {};
  settings.hooks.PreToolUse ??= [];

  const existing = findHusky(settings);

  if (existing.length > 0) {
    // 이미 등록되어 있다면 경로와 타임아웃만 최신으로 맞춘다.
    const fresh = buildEntry();
    for (const { entry } of existing) {
      entry.type = fresh.type;
      entry.command = fresh.command;
      entry.timeout = fresh.timeout;
    }
    writeSettings(file, settings);
    log(`✅ 기존 등록을 갱신했습니다 (${existing.length}건).`);
    return;
  }

  // 같은 matcher를 쓰는 그룹이 있으면 거기에 끼워 넣고, 없으면 새 그룹을 만든다.
  const sameMatcher = settings.hooks.PreToolUse.find((g) => g?.matcher === MATCHER);
  if (sameMatcher) {
    sameMatcher.hooks ??= [];
    sameMatcher.hooks.push(buildEntry());
  } else {
    settings.hooks.PreToolUse.push({ matcher: MATCHER, hooks: [buildEntry()] });
  }

  writeSettings(file, settings);
  log('✅ 훅을 등록했습니다.');
}

function remove(file, settings) {
  const existing = findHusky(settings);
  if (existing.length === 0) {
    log('등록된 Husky 훅이 없습니다. 변경하지 않았습니다.');
    return;
  }

  for (const group of settings.hooks.PreToolUse) {
    if (!Array.isArray(group?.hooks)) continue;
    group.hooks = group.hooks.filter((e) => !isHuskyHook(e));
  }
  // 빈 그룹은 정리한다.
  settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(
    (g) => Array.isArray(g?.hooks) && g.hooks.length > 0
  );
  if (settings.hooks.PreToolUse.length === 0) delete settings.hooks.PreToolUse;
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

  writeSettings(file, settings);
  log(`✅ 훅 등록을 해제했습니다 (${existing.length}건).`);
}

// ------------------------------------------------------------------------------
// 설정 파일(.husky.env) 준비
// ------------------------------------------------------------------------------

function ensureEnvFile() {
  const target = path.join(HERE, '.husky.env');
  const example = path.join(HERE, '.husky.env.example');

  if (fs.existsSync(target)) {
    log(`   설정 파일: ${target} (이미 있음 — 건드리지 않음)`);
    return;
  }
  if (!fs.existsSync(example)) {
    warn('.husky.env.example 이 없어 설정 파일을 만들지 못했습니다.');
    return;
  }

  fs.copyFileSync(example, target);
  log(`   설정 파일 생성: ${target}`);
  warn('HUSKY_URL(또는 HUSKY_HOST) 과 HUSKY_TOKEN 을 채워야 서버에 연결됩니다.');
}

// ------------------------------------------------------------------------------
// 상태 확인
// ------------------------------------------------------------------------------

function check(scopes) {
  log(`훅 스크립트: ${HOOK_PATH}`);
  log(`  존재 여부: ${fs.existsSync(HOOK_PATH) ? '✅ 있음' : '❌ 없음'}`);

  const envFile = path.join(HERE, '.husky.env');
  log(`설정(.husky.env): ${fs.existsSync(envFile) ? '✅ 있음' : '❌ 없음 — install 실행 필요'}`);

  log('');
  log('등록 상태 (Claude Code는 아래 설정들의 훅을 합쳐서 실행합니다)');

  for (const scope of scopes) {
    log(`  [${scope.label}] ${scope.file}`);
    if (!scope.exists) {
      log('    파일 없음');
      continue;
    }
    if (scope.registered.length === 0) {
      log('    등록 안 됨');
      continue;
    }

    log(`    ✅ ${scope.registered.length}건`);
    for (const { group, entry } of scope.registered) {
      log(`      · matcher: ${group.matcher ?? '(없음)'}`);
      log(`        command: ${entry.command}`);
      log(`        timeout: ${entry.timeout ?? '(미지정 — 기본 600초)'} 초`);

      if (typeof entry.timeout === 'number' && entry.timeout > 86400) {
        warn(
          `timeout이 ${entry.timeout}입니다. 이 값은 **초 단위**이므로 ` +
            `밀리초를 잘못 넣은 것으로 보입니다 (${Math.round(entry.timeout / 3600)}시간).`
        );
      }
      if (!entry.command.includes(HOOK_PATH.replace(/\\/g, '/'))) {
        warn(
          `[${scope.label}] 등록된 경로가 이 폴더의 husky-hook.js와 다릅니다. 다른 사본이 등록되어 있습니다.`
        );
      }
    }
  }

  const registeredScopes = scopes.filter((s) => s.registered.length > 0);

  log('');
  if (registeredScopes.length === 0) {
    const where = scopes.length === 1 ? scopes[0].label : '프로젝트·사용자 전역 어디에도';
    log(`요약: ❌ ${where} 등록되지 않았습니다.`);
  } else {
    const total = registeredScopes.reduce((n, s) => n + s.registered.length, 0);
    log(`요약: ✅ ${registeredScopes.map((s) => s.label).join(' + ')} 에 등록됨 (${total}건)`);
  }

  // 양쪽에 모두 있으면 훅이 두 번 실행된다 → 승인 요청이 두 건 생겨 디스코드 알림이 중복된다.
  if (registeredScopes.length > 1) {
    warn(
      '프로젝트와 사용자 전역 **양쪽에** 등록되어 있습니다. 훅이 도구 호출마다 두 번 실행되어\n' +
        '   승인 요청과 디스코드 알림이 중복됩니다. 한쪽을 해제하세요:\n' +
        '     node install.mjs --remove              (사용자 전역)\n' +
        '     node install.mjs --remove --project    (프로젝트)'
    );
  }

  return registeredScopes;
}

// ------------------------------------------------------------------------------
// 진단 (--doctor)
// ------------------------------------------------------------------------------
// ⚠️ 아래 parseEnvFile / loadHookConfig / resolveServer 는 훅(hook/husky-hook.js)의
//    같은 이름 함수와 **동작이 동일해야 한다.** 훅은 CommonJS·의존성 0이고 이 도구는
//    ESM이라 import로 공유할 수 없어 복제했다. 한쪽을 고치면 다른 쪽도 고칠 것.
// ------------------------------------------------------------------------------

/** KEY=VALUE 파일 파서 (훅과 동일). */
function parseEnvFile(filePath) {
  const result = {};
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return result;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();

    if (!/^["']/.test(value)) {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    value = value.replace(/^(["'])(.*)\1$/, '$2');

    if (key) result[key] = value;
  }
  return result;
}

/**
 * 훅과 같은 순서로 설정을 병합하되, **각 값이 어느 출처에서 왔는지**도 함께 남긴다.
 * 분리 배포 직후 가장 흔한 실수가 "셸에 export된 값이 .husky.env를 이기는 것"이라
 * 값보다 출처가 중요하다.
 */
function loadHookConfig() {
  const repoRoot = path.resolve(HERE, '..');
  const insideRepo = fs.existsSync(path.join(repoRoot, 'src', 'backend'));
  const rootEnvPath = path.join(repoRoot, '.env');
  const huskyEnvPath = path.join(HERE, '.husky.env');

  const values = {};
  const sources = {};
  const put = (obj, src) => {
    for (const [k, v] of Object.entries(obj)) {
      values[k] = v;
      sources[k] = src;
    }
  };

  if (insideRepo) put(parseEnvFile(rootEnvPath), '루트 .env');
  put(parseEnvFile(huskyEnvPath), 'client/.husky.env');

  // 환경 변수가 최우선 (훅과 동일)
  for (const key of Object.keys(values)) {
    const fromEnv = (process.env[key] ?? '').trim();
    if (fromEnv) {
      values[key] = fromEnv;
      sources[key] = '프로세스 환경 변수';
    }
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (!(key in values) && value) {
      values[key] = value;
      sources[key] = '프로세스 환경 변수';
    }
  }

  return { values, sources, insideRepo, rootEnvPath, huskyEnvPath };
}

/** 서버 접속 정보 확정 (훅의 resolveServer와 동일 규칙). */
function resolveServer(cfg) {
  const legacy = {
    protocol: 'http:',
    hostname: cfg.HUSKY_HOST || '127.0.0.1',
    port: Number.parseInt(cfg.HUSKY_PORT ?? '', 10) > 0 ? Number.parseInt(cfg.HUSKY_PORT, 10) : 3001,
    basePath: '',
  };

  const raw = (cfg.HUSKY_URL || '').trim();
  if (!raw) return legacy;

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return legacy;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return legacy;
  if (!parsed.hostname) return legacy;

  const defaultPort = parsed.protocol === 'https:' ? 443 : 80;
  const port = parsed.port ? Number.parseInt(parsed.port, 10) : defaultPort;

  let basePath = parsed.pathname || '';
  if (basePath === '/') basePath = '';
  basePath = basePath.replace(/\/+$/, '');

  return {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: Number.isFinite(port) && port > 0 ? port : defaultPort,
    basePath,
  };
}

function serverDisplay(server) {
  const showPort =
    (server.protocol === 'https:' && server.port !== 443) ||
    (server.protocol === 'http:' && server.port !== 80);
  return `${server.protocol}//${server.hostname}${showPort ? `:${server.port}` : ''}${server.basePath}`;
}

/** 비밀값은 앞 4자만 보여준다. 봇 토큰처럼 앞부분도 민감한 값은 setOnly를 쓴다. */
function mask(value) {
  if (!value) return '(비어 있음)';
  return value.length <= 4 ? `${value}…` : `${value.slice(0, 4)}…`;
}

function num(cfg, key, fallback) {
  const parsed = Number.parseInt(cfg[key] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function boolCfg(cfg, key, fallback) {
  const v = (cfg[key] ?? '').trim().toLowerCase();
  if (!v) return fallback;
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/** GET 한 번. 응답 본문은 앞부분만 필요하므로 그대로 모은다. */
function getOnce(server, urlPath, token) {
  return new Promise((resolve) => {
    const transport = server.protocol === 'https:' ? https : http;
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;

    const req = transport.request(
      {
        hostname: server.hostname,
        port: server.port,
        path: server.basePath + urlPath,
        method: 'GET',
        headers,
        timeout: 10000,
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf-8');
        res.on('data', (c) => (raw += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw }));
      }
    );

    req.on('error', (err) => resolve({ error: `${err.code ?? ''} ${err.message}`.trim() }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ error: 'ETIMEDOUT 10초 내에 응답이 없습니다' });
    });
    req.end();
  });
}

function looksHtml(body) {
  const head = (body || '').trimStart().slice(0, 200).toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html');
}

/**
 * @param {ReturnType<typeof collectScopes>} registeredScopes
 *        훅 등록이 실제로 확인된 설정 범위들. 비어 있으면 타임아웃 체인은 판정하지 않는다.
 */
async function doctor(registeredScopes) {
  let failures = 0;
  const ok = (msg) => log(`  OK    ${msg}`);
  const bad = (msg) => {
    failures++;
    log(`  FAIL  ${msg}`);
  };
  const wrn = (msg) => log(`  WARN  ${msg}`);
  // 한글은 터미널에서 두 칸을 차지하므로 그만큼 빼고 채운다 (표가 어긋나 보이지 않도록).
  const width = (s) =>
    [...s].reduce((w, ch) => w + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿＀-｠]/.test(ch) ? 2 : 1), 0);
  const info = (label, value) => log(`  ${label}${' '.repeat(Math.max(1, 25 - width(label)))}= ${value}`);

  const { values: cfg, sources: src } = loadHookConfig();
  const from = (key) => (src[key] ? `(${src[key]})` : '(기본값)');
  const server = resolveServer(cfg);
  const usingUrl = Boolean((cfg.HUSKY_URL || '').trim());

  // ---------------------------------------------------------------- [1/6]
  log('');
  log('[1/6] 설정 출처');
  info('HUSKY_URL', `${cfg.HUSKY_URL ? mask(cfg.HUSKY_URL) : '(비어 있음)'} ${from('HUSKY_URL')}`);
  if (usingUrl) {
    info('HUSKY_HOST/PORT', '(HUSKY_URL이 있어 무시됨)');
  } else {
    info('HUSKY_HOST/PORT', `${cfg.HUSKY_HOST || '127.0.0.1'}:${num(cfg, 'HUSKY_PORT', 3001)} ${from('HUSKY_HOST')}`);
  }
  info('→ 최종 서버 주소', serverDisplay(server));
  info('HUSKY_TOKEN', `${mask(cfg.HUSKY_TOKEN)} ${from('HUSKY_TOKEN')}`);
  info('HUSKY_DIRECT_FALLBACK', `${boolCfg(cfg, 'HUSKY_DIRECT_FALLBACK', true) ? '1' : '0'} ${from('HUSKY_DIRECT_FALLBACK')}`);
  info('DISCORD_BOT_TOKEN', `${cfg.DISCORD_BOT_TOKEN ? '설정됨' : '비어 있음'} ${from('DISCORD_BOT_TOKEN')}`);
  info('DISCORD_CHANNEL_ID', `${mask(cfg.DISCORD_CHANNEL_ID)} ${from('DISCORD_CHANNEL_ID')}`);
  const approvers = (cfg.DISCORD_ALLOWED_USER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => s !== 'your_discord_user_id_here');
  info('DISCORD_ALLOWED_USER_IDS', `${approvers.length}건 ${from('DISCORD_ALLOWED_USER_IDS')}`);

  for (const key of ['HUSKY_URL', 'HUSKY_HOST', 'HUSKY_PORT', 'HUSKY_TOKEN']) {
    if (src[key] === '프로세스 환경 변수') {
      wrn(`${key} 이(가) '프로세스 환경 변수'에서 왔습니다. .husky.env 값이 무시됩니다.`);
    }
  }
  if (!cfg.HUSKY_TOKEN) {
    wrn('HUSKY_TOKEN 이 비어 있습니다. 서버가 인증을 켰다면 모든 요청이 401입니다.');
  }
  if (!usingUrl && server.hostname !== '127.0.0.1' && server.hostname !== 'localhost') {
    wrn('HUSKY_URL 없이 원격 HUSKY_HOST 를 씁니다 — 평문 HTTP입니다. 터널을 쓴다면 HUSKY_URL 에 https:// 주소를 적으세요.');
  }

  // ---------------------------------------------------------------- [2/6]
  log('');
  log('[2/6] 도달성  GET /health');
  const health = await getOnce(server, '/health', '');
  let authEnabled = null;
  if (health.error) {
    bad(`${health.error}`);
  } else if (looksHtml(health.body)) {
    bad('응답이 JSON이 아닙니다 (HTML) — ngrok 경고 페이지이거나 프록시 설정 오류');
  } else {
    try {
      const parsed = JSON.parse(health.body);
      authEnabled = parsed.authEnabled === true;
      ok(`${health.status} · authEnabled=${parsed.authEnabled} · pending=${parsed.pendingRequests ?? '?'}`);
      if (parsed.authEnabled === false) {
        wrn('authEnabled=false — 서버가 인증 없이 떠 있습니다. 터널·프록시 뒤라면 위험합니다.');
      }
    } catch {
      bad(`응답이 JSON이 아닙니다 (${health.status}) — ${health.body.slice(0, 80)}`);
    }
  }

  // ---------------------------------------------------------------- [3/6]
  log('');
  log('[3/6] 인증  GET /api/v1/requests/pending (토큰 포함)');
  if (!cfg.HUSKY_TOKEN) {
    wrn('HUSKY_TOKEN 이 비어 있어 토큰 없이 호출합니다 — [4/6]과 같은 요청입니다.');
  }
  const withToken = await getOnce(server, '/api/v1/requests/pending', cfg.HUSKY_TOKEN || '');
  if (withToken.error) {
    bad(`${withToken.error}`);
  } else if (withToken.status === 200) {
    ok('200');
  } else if (withToken.status === 401 || withToken.status === 403) {
    bad(`${withToken.status} — HUSKY_TOKEN 이 서버 API_SECRET_KEY 와 다릅니다`);
  } else if (looksHtml(withToken.body)) {
    bad(`${withToken.status} — 응답이 HTML입니다 (프록시가 API를 서버로 넘기지 않습니다)`);
  } else {
    bad(`${withToken.status} — ${withToken.body.slice(0, 80)}`);
  }

  // ---------------------------------------------------------------- [4/6]
  log('');
  log('[4/6] 인증 강제  GET /api/v1/requests/pending (토큰 없이)');
  const noToken = await getOnce(server, '/api/v1/requests/pending', '');
  if (noToken.error) {
    bad(`${noToken.error}`);
  } else if (noToken.status === 401 || noToken.status === 403) {
    ok(`${noToken.status} — 인증이 실제로 걸려 있습니다`);
  } else if (noToken.status === 200) {
    bad('200 — 토큰 없이도 통과합니다. 서버 API_SECRET_KEY 가 비어 있습니다');
  } else {
    bad(`${noToken.status} — 예상하지 못한 응답입니다`);
  }
  if (authEnabled === false) {
    log('  참고  /health 가 authEnabled=false 를 보고했습니다. 위 결과와 일치해야 정상입니다.');
  }

  // ---------------------------------------------------------------- [5/6]
  log('');
  log('[5/6] 타임아웃 체인');
  const hookTimeoutMs = num(cfg, 'HUSKY_HOOK_TIMEOUT_MS', 1750000);
  const budgetMs = num(cfg, 'HUSKY_TOTAL_BUDGET_MS', 1820000);

  // 등록된 훅이 여럿이면 가장 짧은 timeout이 먼저 훅을 죽인다 — 가장 빡빡한 값으로 판정한다.
  const registeredEntries = registeredScopes.flatMap((s) =>
    s.registered.map(({ entry }) => ({ scope: s.label, entry }))
  );
  const timeouts = registeredEntries.map(({ entry }) =>
    typeof entry.timeout === 'number' ? entry.timeout : 600
  );
  const settingsTimeout = timeouts.length > 0 ? Math.min(...timeouts) : null;
  const hasUnspecified = registeredEntries.some(({ entry }) => typeof entry.timeout !== 'number');

  if (settingsTimeout === null) {
    // ⚠️ 등록을 못 찾았을 때 "기본 600초"로 가정하고 FAIL을 내던 버그가 있었다.
    //    근거가 없는 판정이라 멀쩡한 구성을 타임아웃 문제로 오진한다. 판정하지 않는다.
    info('settings.json timeout', '판정 불가 — 등록을 찾지 못했습니다');
    info('HUSKY_HOOK_TIMEOUT_MS', `${hookTimeoutMs} ${from('HUSKY_HOOK_TIMEOUT_MS')}`);
    info('HUSKY_TOTAL_BUDGET_MS', `${budgetMs} ${from('HUSKY_TOTAL_BUDGET_MS')}`);
    wrn(
      '등록을 찾지 못해 타임아웃 체인을 판정할 수 없습니다. ' +
        '먼저 훅을 등록하세요: node install.mjs (또는 --project)'
    );
  } else {
    const where = [...new Set(registeredEntries.map((e) => e.scope))].join(' + ');
    info(
      'settings.json timeout',
      `${settingsTimeout} 초 (${where}${hasUnspecified ? ' · timeout 미지정 항목은 기본 600으로 계산' : ''})`
    );
    info('HUSKY_HOOK_TIMEOUT_MS', `${hookTimeoutMs} ${from('HUSKY_HOOK_TIMEOUT_MS')}`);
    info('HUSKY_TOTAL_BUDGET_MS', `${budgetMs} ${from('HUSKY_TOTAL_BUDGET_MS')}`);

    const settingsMs = settingsTimeout * 1000;
    if (settingsMs > budgetMs && budgetMs > hookTimeoutMs) {
      ok(`${settingsTimeout}s > ${budgetMs}ms > ${hookTimeoutMs}ms`);
    } else {
      bad(
        `순서가 뒤집혔습니다 — settings.json timeout(${settingsMs}ms) > HUSKY_TOTAL_BUDGET_MS(${budgetMs}) > ` +
          `HUSKY_HOOK_TIMEOUT_MS(${hookTimeoutMs}) 이어야 합니다`
      );
    }

    // ④ 마무리 예비분 — 대기가 끝난 뒤의 마감 처리(마지막 폴링 3초 + 리액션 조회 15초 +
    //    마감 메시지 수정 15초 + 출력 플러시 2초 = 35초)에 쓸 시간이 남아 있어야 한다.
    const finishReserveMs = settingsMs - budgetMs;
    if (finishReserveMs >= 40000) {
      ok(`마무리 예비분 ${settingsMs} − ${budgetMs} = ${finishReserveMs}ms ≥ 40000ms`);
    } else {
      bad(
        `마무리 예비분이 부족합니다 — settings.json timeout(${settingsMs}ms) − HUSKY_TOTAL_BUDGET_MS(${budgetMs}ms) = ` +
          `${finishReserveMs}ms < 40000ms. Claude Code가 훅을 먼저 죽여 ` +
          '마감 문구 없는 승인 메시지가 디스코드에 남습니다'
      );
    }

    // ② 2차 폴백 여유 — 1차(서버 대기)가 예산을 다 쓰면 2차에 남는 시간이 사라진다.
    //    30초 미만이면 훅은 고아 메시지를 막기 위해 2차를 조용히 생략한다
    //    (husky-hook.js 의 MIN_DIRECT_WAIT_MS 판정).
    if (boolCfg(cfg, 'HUSKY_DIRECT_FALLBACK', true)) {
      const directSpareMs = budgetMs - hookTimeoutMs;
      if (directSpareMs >= 30000) {
        ok(`2차 폴백 여유 ${budgetMs} − ${hookTimeoutMs} = ${directSpareMs}ms ≥ 30000ms`);
      } else {
        bad(
          `2차 폴백 여유가 부족합니다 — HUSKY_TOTAL_BUDGET_MS(${budgetMs}ms) − ` +
            `HUSKY_HOOK_TIMEOUT_MS(${hookTimeoutMs}ms) = ${directSpareMs}ms < 30000ms. ` +
            '미만이면 2차 리액션 폴백이 경고 없이 꺼집니다'
        );
      }
    } else {
      info('2차 폴백 여유', 'HUSKY_DIRECT_FALLBACK=0 — 2차 폴백 off · 판정 생략');
    }
  }
  log('  참고  서버 HOOK_TIMEOUT_MS 는 여기서 알 수 없습니다. ' + `${hookTimeoutMs} 보다 작아야 합니다.`);

  // ---------------------------------------------------------------- [6/6]
  log('');
  log('[6/6] 2차 폴백 준비');
  const fallbackOn = boolCfg(cfg, 'HUSKY_DIRECT_FALLBACK', true);
  if (!fallbackOn) {
    ok('DIRECT_FALLBACK=0 — 서버에 닿지 못하면 곧바로 로컬 권한 프롬프트로 갑니다');
  } else if (!cfg.DISCORD_BOT_TOKEN || !cfg.DISCORD_CHANNEL_ID) {
    wrn('DIRECT_FALLBACK=1 인데 봇 토큰 또는 채널 ID 가 없습니다 — 폴백이 동작하지 않습니다');
  } else if (approvers.length === 0) {
    wrn('DIRECT_FALLBACK=1 인데 승인자 목록이 비어 있습니다 — 폴백이 동작하지 않습니다 (fail-closed)');
  } else {
    ok(`DIRECT_FALLBACK=1 · 봇 토큰 있음 · 채널 있음 · 승인자 ${approvers.length}건`);
  }

  log('');
  if (failures > 0) {
    log(`❌ FAIL ${failures}건 — 위 항목을 확인하세요.`);
    process.exit(1);
  }
  log('✅ 모든 항목 통과');
}

// ------------------------------------------------------------------------------

async function main() {
  if (!fs.existsSync(HOOK_PATH)) {
    fail(`husky-hook.js 를 찾을 수 없습니다: ${HOOK_PATH}`);
  }

  // 읽기 전용 명령은 프로젝트·사용자 전역을 함께 살핀다 (--project 면 그 범위만).
  if (has('--doctor')) {
    const registeredScopes = check(collectScopes());
    await doctor(registeredScopes);
    return;
  }

  if (has('--check')) {
    check(collectScopes());
    return;
  }

  // 아래부터는 설정 파일을 쓰는 명령 — 예전처럼 한쪽에만 작용한다.
  const file = settingsPath();
  const settings = readSettings(file);

  if (has('--remove')) {
    remove(file, settings);
    return;
  }

  log(`Husky 훅을 설치합니다 → ${file}`);
  install(file, settings);
  ensureEnvFile();

  log('');
  log('다음 단계:');
  log(`  1) ${path.join(HERE, '.husky.env')} 에서 HUSKY_URL(또는 HUSKY_HOST) / HUSKY_TOKEN 을 채우세요.`);
  log('  2) 연결·인증·타임아웃 체인 진단:');
  log('     node install.mjs --doctor');
  log('  3) 훅 단독 실행 (서버 미연결 시 무출력 exit 0이 정상):');
  log(`     echo '{"tool_name":"Bash","tool_input":{"command":"ls"}}' | node "${HOOK_PATH}"`);
  log('');
  log('선택: 데스크톱 토스트 알림으로도 승인하려면');
  log('  npm run agent:install   그리고   npm run agent:dev');
}

main().catch((err) => fail(err && err.message ? err.message : String(err)));
