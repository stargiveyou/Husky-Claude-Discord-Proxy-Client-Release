#!/usr/bin/env node
/**
 * Husky Windows 에이전트 설치기
 * ==============================================================================
 * **묶음(release/husky-agent) 안에서 실행한다.** 이 파일 옆의 dist/·assets/·node_modules/를
 * 대상 `client/agent/`로 통째 옮긴다.
 *
 *   node install-agent.mjs                  설치 / 업데이트
 *   node install-agent.mjs --check          1~5번 항목만 점검 (아무것도 바꾸지 않음)
 *   node install-agent.mjs --doctor         1~9번 전부 점검 (아무것도 바꾸지 않음)
 *   node install-agent.mjs --force          다이제스트가 같아도 다시 설치
 *   node install-agent.mjs --target <path>  대상 client/ 폴더를 직접 지정
 *
 * 하지 않는 일 — 의도된 것이므로 추가하지 마라:
 *   ⛔ `client/.husky.env` 생성·수정. 그 파일의 주체는 `client/install.mjs`의
 *      `ensureEnvFile()` 하나뿐이다. 없으면 안내만 한다.
 *   ⛔ `~/.claude/settings.json`·레지스트리·시작 프로그램 등록.
 *   ⛔ 관리자 권한 요구, 외부 다운로드, Node 런타임 동봉.
 *
 * 의존성은 Node 내장 모듈뿐이다. 선례는 `client/install.mjs`(무의존 ESM)다.
 * ==============================================================================
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 이 스크립트가 들어 있는 폴더 = 묶음 루트 */
const BUNDLE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 최소 Node 버전 — 승인된 값(20 LTS). 런타임은 동봉하지 않는다. */
export const MIN_NODE = [20, 0, 0];

/**
 * 실행 중인 에이전트를 가리키는 PID 파일.
 *
 * `src/index.ts`의 `PID_FILE`과 **같은 경로여야 한다.** 한쪽을 고치면 다른 쪽도 고칠 것.
 * (에이전트는 TypeScript, 설치기는 무의존 ESM이라 import로 공유할 수 없다.)
 */
export const PID_FILE = path.join(
  process.env.LOCALAPPDATA || os.tmpdir(),
  'husky-agent',
  'agent.pid'
);

/** 다이제스트 대상 — 이 두 폴더가 "설치된 내용"이다. */
const DIGEST_DIRS = ['dist', 'assets'];

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
function flagValue(name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

export const log = (msg) => console.log(msg);
export const warn = (msg) => console.warn(`⚠️  ${msg}`);
export const fail = (msg) => {
  console.error(`❌ ${msg}`);
  process.exit(1);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Windows 파일 락은 바로 풀리지 않는 경우가 있어 재시도를 둔다. */
export function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

// ------------------------------------------------------------------------------
// 4-1. 대상 client/ 경로 결정
// ------------------------------------------------------------------------------

/** `<dir>/hook/husky-hook.js`가 있으면 그 디렉터리를 client/로 본다. */
function looksLikeClientDir(dir) {
  return fs.existsSync(path.join(dir, 'hook', 'husky-hook.js'));
}

/**
 * 설치 대상 client/ 폴더를 찾는다.
 *   1) --target <path>
 *   2) 환경 변수 HUSKY_CLIENT_DIR
 *   3) cwd에서 위로 올라가며 hook/husky-hook.js 탐색
 * 못 찾으면 사용법을 출력하고 종료한다.
 */
export function resolveClientDir() {
  const explicit = flagValue('--target') || (process.env.HUSKY_CLIENT_DIR || '').trim();
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!fs.existsSync(resolved)) fail(`지정한 경로가 없습니다: ${resolved}`);
    if (!fs.statSync(resolved).isDirectory()) fail(`디렉터리가 아닙니다: ${resolved}`);
    // 훅이 없어도 막지는 않는다 — 에이전트만 먼저 넣는 구성을 허용한다.
    if (!looksLikeClientDir(resolved)) {
      warn(`${resolved} 에 hook/husky-hook.js 가 없습니다. client/ 폴더가 맞는지 확인하세요.`);
    }
    return resolved;
  }

  let dir = process.cwd();
  for (;;) {
    if (looksLikeClientDir(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  fail(
    'client/ 폴더를 찾지 못했습니다 (hook/husky-hook.js 기준).\n' +
      '   경로를 직접 지정하세요:\n' +
      '     node install-agent.mjs --target C:\\path\\to\\client\n' +
      '   또는 환경 변수 HUSKY_CLIENT_DIR 를 설정하세요.'
  );
}

/** 설치 위치는 언제나 `<client>/agent/` 다. */
export function agentDirOf(clientDir) {
  return path.join(clientDir, 'agent');
}

/**
 * 안전 가드 — 대상이 저장소 소스 트리면 중단한다.
 *
 * 교체는 `agent/` 폴더를 통째로 rename하는 방식이라, 저장소에서 실행하면
 * `src/`·`scripts/`가 통째로 사라진다. **--force 로도 통과시키지 않는다.**
 */
export function assertNotSourceTree(agentDir) {
  if (fs.existsSync(path.join(agentDir, 'src'))) {
    fail(
      `${agentDir} 에 src/ 가 있습니다 — 저장소 소스 트리로 보입니다.\n` +
        '   이 설치기는 폴더를 통째로 교체하므로 소스가 사라집니다. 배포용 client/ 를 지정하세요:\n' +
        '     node install-agent.mjs --target C:\\path\\to\\client'
    );
  }
}

/** cwd가 대상 폴더 안이면 Windows가 폴더를 잠가 rename·삭제가 막힌다. 미리 잡아 준다. */
export function assertCwdOutside(agentDir) {
  const cwd = path.resolve(process.cwd());
  const target = path.resolve(agentDir);
  if (cwd === target || cwd.startsWith(target + path.sep)) {
    fail(
      `현재 작업 폴더가 대상 안에 있습니다: ${cwd}\n` +
        '   Windows가 폴더를 잠가 교체·삭제에 실패합니다. 다른 폴더에서 실행하세요.'
    );
  }
}

// ------------------------------------------------------------------------------
// 4-2. 다이제스트 비교 (버전 비교 아님)
// ------------------------------------------------------------------------------

/** dist/·assets/ 아래 모든 파일의 상대 경로를 모은다 (posix 구분자로 정규화). */
function collectFiles(rootDir) {
  const found = [];
  for (const sub of DIGEST_DIRS) {
    const base = path.join(rootDir, sub);
    if (!fs.existsSync(base)) continue;
    const stack = [base];
    while (stack.length > 0) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile()) found.push(path.relative(rootDir, full).split(path.sep).join('/'));
      }
    }
  }
  return found;
}

/**
 * dist/·assets/ 내용으로 sha256 하나를 만든다.
 *
 * `package.json`의 `version`은 `0.1.0` 고정이라 비교 기준이 되지 못한다.
 * 상대 경로 오름차순으로 정렬한 뒤 `상대경로 + "\0" + 파일바이트`를 순서대로 흘려 넣는다.
 * 경로까지 섞어 넣어야 내용은 그대로인데 파일 이름만 바뀐 변경도 잡힌다.
 *
 * @returns {string|null} 대상 파일이 하나도 없으면 null (= 설치되지 않음)
 */
export function computeDigest(rootDir) {
  const files = collectFiles(rootDir).sort();
  if (files.length === 0) return null;

  const hash = crypto.createHash('sha256');
  for (const rel of files) {
    hash.update(rel, 'utf-8');
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(rootDir, rel)));
  }
  return hash.digest('hex');
}

// ------------------------------------------------------------------------------
// 4-3. 실행 중인 에이전트 종료
// ------------------------------------------------------------------------------

/** PID 파일을 읽는다. 없거나 깨졌으면 null. */
export function readPidFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PID_FILE, 'utf-8'));
    if (!parsed || typeof parsed.pid !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM은 "있지만 신호를 못 보낸다"는 뜻이므로 살아 있는 것으로 본다.
    return Boolean(err && err.code === 'EPERM');
  }
}

/**
 * PID 재사용 방어 — 그 PID의 이미지 이름이 node.exe인지 확인한다.
 * OS가 PID를 재활용해 무관한 프로세스를 죽이는 사고를 막는다.
 */
function isNodeProcess(pid) {
  if (process.platform !== 'win32') return true;
  const res = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV'], {
    encoding: 'utf-8',
    windowsHide: true,
  });
  if (res.error || typeof res.stdout !== 'string') return false;
  return res.stdout.toLowerCase().includes('node.exe');
}

/** PowerShell 한 줄을 돌리고 stdout을 돌려준다. 실패하면 null. */
function runPowerShell(script) {
  if (process.platform !== 'win32') return null;
  const res = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf-8', windowsHide: true, cwd: os.tmpdir() }
  );
  if (res.error || typeof res.stdout !== 'string') return null;
  return res.stdout;
}

/**
 * 남아 있는 트레이 PowerShell을 정리한다.
 *
 * `tray.ts`가 `child.unref()`로 띄우고 Windows에는 job object가 없어, 부모가
 * `taskkill /F`로 죽으면 고아 PS가 남는다. `cwd: os.tmpdir()` 수정으로 CWD 락은
 * 사라졌지만 고스트 아이콘은 여전히 남으므로 여기서 함께 정리한다.
 */
function killOrphanTrays() {
  runPowerShell(
    'Get-CimInstance Win32_Process -Filter "Name=\'powershell.exe\'" | ' +
      // $PID 제외가 **필수**다. 이 명령 문자열 자체에 'tray.ps1'이 들어 있어서,
      // 빼면 명령을 수행하는 PowerShell이 자기 자신을 먼저 죽이고 정작 고아는 살아남는다.
      "Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*tray.ps1*' } | " +
      'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'
  );
}

/**
 * 실행 중인 에이전트를 종료한다.
 *
 * ⚠️ **우아한 종료를 기대하지 않는다.** Node의 SIGTERM은 Windows에서 강제 종료와 같아
 *    `shutdown()`이 돌지 않는다. 그래서 `taskkill /T /F`로 트리를 끊고 잔여 PS를 따로 정리한다.
 *
 * @returns {Promise<boolean>} 실제로 실행 중인 프로세스를 죽였으면 true
 */
export async function stopRunningAgent() {
  const info = readPidFile();
  if (!info) {
    log('  실행 중인 에이전트가 없습니다 (PID 파일 없음).');
    killOrphanTrays(); // 고아 트레이만 남아 있을 수 있다
    return false;
  }

  const { pid } = info;
  if (!pidAlive(pid) || !isNodeProcess(pid)) {
    log(`  실행 중이 아닙니다 (PID ${pid} — 기록만 남아 있음).`);
    killOrphanTrays();
    try {
      fs.unlinkSync(PID_FILE);
    } catch {
      /* 지우지 못해도 무해하다 */
    }
    return false;
  }

  log(`  실행 중인 에이전트를 종료합니다 (PID ${pid}).`);
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
    encoding: 'utf-8',
    windowsHide: true,
  });
  killOrphanTrays();

  // 최대 5초 동안 100ms 간격으로 소멸을 확인한다.
  for (let i = 0; i < 50; i += 1) {
    if (!pidAlive(pid)) {
      log('  종료되었습니다.');
      try {
        fs.unlinkSync(PID_FILE);
      } catch {
        /* 에이전트가 이미 지웠을 수 있다 */
      }
      return true;
    }
    await sleep(100);
  }

  fail(
    `PID ${pid} 가 5초 안에 종료되지 않았습니다.\n` +
      '   트레이 아이콘 → 종료 후 다시 실행하세요.'
  );
  return false; // 도달하지 않는다 (fail이 exit한다)
}

// ------------------------------------------------------------------------------
// 4-4. 교체 — 파일별 복사 금지
// ------------------------------------------------------------------------------

/**
 * 묶음을 대상에 통째로 옮긴다.
 *
 * ⚠️ **"임시 폴더로 전부 복사 → 전체 rename"** 순서를 지킨다. 파일별로 덮어쓰면
 *    중간에 실패했을 때 새 파일과 옛 파일이 섞인 "반쯤 남은 설치"가 된다(위험 V1).
 *
 * 설정은 `<client>/.husky.env`에 있어 교체 대상 밖이므로 자동으로 보존된다.
 */
function replaceInstall(clientDir, agentDir) {
  const staging = path.join(clientDir, `agent.new-${process.pid}`);
  const backup = path.join(clientDir, `agent.old-${process.pid}`);

  rmrf(staging);
  rmrf(backup);

  log(`  묶음을 복사합니다 → ${staging}`);
  fs.cpSync(BUNDLE_DIR, staging, { recursive: true });

  const hadPrevious = fs.existsSync(agentDir);
  if (hadPrevious) fs.renameSync(agentDir, backup);

  try {
    fs.renameSync(staging, agentDir);
  } catch (err) {
    // 되돌린다 — 옛 설치가 사라진 채로 끝나면 안 된다.
    if (hadPrevious && !fs.existsSync(agentDir)) {
      try {
        fs.renameSync(backup, agentDir);
      } catch {
        warn(`되돌리기에도 실패했습니다. 수동으로 확인하세요: ${backup} → ${agentDir}`);
      }
    }
    rmrf(staging);
    fail(`교체에 실패했습니다: ${err && err.message ? err.message : String(err)}`);
  }

  if (hadPrevious) rmrf(backup);
}

// ------------------------------------------------------------------------------
// 5. 점검 (--check / --doctor)
// ------------------------------------------------------------------------------

/** 비밀값은 앞 4자만 보여준다 (client/install.mjs:474-478의 mask와 같은 방식). */
function mask(value) {
  if (!value) return '(비어 있음)';
  return value.length <= 4 ? `${value}…` : `${value.slice(0, 4)}…`;
}

function nodeVersionOk() {
  const parts = process.versions.node.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < MIN_NODE.length; i += 1) {
    const mine = parts[i] || 0;
    if (mine > MIN_NODE[i]) return true;
    if (mine < MIN_NODE[i]) return false;
  }
  return true;
}

/**
 * 에이전트 고유 항목만 본다.
 *
 * ⛔ 서버 도달성·인증·타임아웃 체인은 검사하지 않는다. 그쪽은
 *    `node ../install.mjs --doctor`의 몫이고, 그 도구는 훅이 없으면 즉시 종료하므로
 *    (client/install.mjs:714-716) 한 도구로 합치는 것이 구조적으로 불가능하다.
 *    마지막에 안내만 한다.
 *
 * @param {boolean} full  true면 1~9 전부, false면 1~5만
 */
async function diagnose(clientDir, agentDir, full) {
  let failures = 0;
  const ok = (msg) => log(`  OK    ${msg}`);
  const bad = (msg) => {
    failures += 1;
    log(`  FAIL  ${msg}`);
  };
  const wrn = (msg) => log(`  WARN  ${msg}`);

  log('');
  log(`[1] Node 버전 (>= ${MIN_NODE.join('.')})`);
  if (nodeVersionOk()) ok(`node ${process.versions.node}`);
  else {
    bad(
      `node ${process.versions.node} — ${MIN_NODE.join('.')} 이상이 필요합니다. ` +
        'https://nodejs.org 에서 LTS를 설치하세요.'
    );
  }

  log('');
  log('[2] 설치 경로');
  if (fs.existsSync(agentDir)) ok(agentDir);
  else bad(`${agentDir} 가 없습니다 — 먼저 설치하세요: node install-agent.mjs --target "${clientDir}"`);

  log('');
  log('[3] 빌드 산출물');
  for (const rel of ['dist/index.js', 'dist/config.js']) {
    if (fs.existsSync(path.join(agentDir, rel))) ok(rel);
    else bad(`${rel} 이 없습니다.`);
  }

  log('');
  log('[4] 트레이 자원 (없으면 트레이만 꺼지고 알림·승인은 계속 동작)');
  if (fs.existsSync(path.join(agentDir, 'assets', 'tray.ps1'))) ok('assets/tray.ps1');
  else wrn('assets/tray.ps1 이 없습니다 — 트레이 아이콘이 표시되지 않습니다.');
  // 아이콘은 상태별 두 장(연결됨/끊김)이다. src/tray.ts 가 참조하는 파일명과 같아야 한다.
  for (const rel of ['assets/husky-connected.ico', 'assets/husky-disconnected.ico']) {
    if (fs.existsSync(path.join(agentDir, rel))) ok(rel);
    else wrn(`${rel} 이 없습니다 — 시스템 기본 아이콘으로 대체됩니다.`);
  }

  log('');
  log('[5] 의존성');
  for (const dep of ['ws', 'node-notifier']) {
    if (fs.existsSync(path.join(agentDir, 'node_modules', dep))) ok(`node_modules/${dep}`);
    else bad(`node_modules/${dep} 이 없습니다 — 묶음이 손상되었습니다. 다시 설치하세요.`);
  }

  if (full) {
    log('');
    log('[6] 설정 해석 (client/.husky.env)');
    const configPath = path.join(agentDir, 'dist', 'config.js');
    if (!fs.existsSync(configPath)) {
      bad('dist/config.js 가 없어 설정을 읽을 수 없습니다.');
    } else {
      try {
        // ⚠️ parseEnvFile 을 여기에 복제하지 않는다. client/install.mjs:354-357 이 이미
        //    복제 2개(훅·install.mjs)를 경고하고 있고, 3개가 되면 드리프트가 확정된다.
        //    **설치된 dist/config.js 를 그대로 import** 해 에이전트와 같은 값을 본다.
        const mod = await import(pathToFileURL(configPath).href);
        const cfg = mod.config;
        ok(`baseUrl      = ${cfg.baseUrl}`);
        ok(`hostLabel    = ${cfg.hostLabel}`);
        ok(`dashboardUrl = ${cfg.dashboardUrl}`);
        ok(`알림         = ${cfg.notifications ? '켜짐' : '꺼짐'}`);
        if (cfg.token) ok(`HUSKY_TOKEN  = ${mask(cfg.token)}`);
        else wrn('HUSKY_TOKEN 이 비어 있습니다 — 서버가 인증을 요구하면 승인이 401로 거부됩니다.');
        if (!fs.existsSync(path.join(clientDir, '.husky.env'))) {
          wrn(`${path.join(clientDir, '.husky.env')} 가 없습니다 — node ../install.mjs 로 만드세요.`);
        }
      } catch (err) {
        bad(`설정을 읽지 못했습니다: ${err && err.message ? err.message : String(err)}`);
      }
    }

    // --------------------------------------------------------------------------
    // 7~9. PowerShell 차단 진단 — 트레이가 "조용히" 안 뜨는 원인 셋.
    //      전부 WARN이다. 트레이는 부가 기능이므로 이것 때문에 FAIL로 떨어뜨리지 않는다.
    // --------------------------------------------------------------------------
    log('');
    log('[7] 실행 정책 (그룹 정책)');
    if (process.platform !== 'win32') {
      wrn('Windows가 아니어서 확인하지 않았습니다.');
    } else {
      const out = runPowerShell(
        'Get-ExecutionPolicy -List | ForEach-Object { "$($_.Scope)=$($_.ExecutionPolicy)" }'
      );
      if (out === null) {
        wrn('powershell.exe 를 실행하지 못했습니다.');
      } else {
        const policies = {};
        for (const line of out.split(/\r?\n/)) {
          const eq = line.indexOf('=');
          if (eq > 0) policies[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
        }
        const blocked = ['MachinePolicy', 'UserPolicy'].filter(
          (scope) => policies[scope] && policies[scope] !== 'Undefined'
        );
        if (blocked.length === 0) {
          ok('MachinePolicy / UserPolicy 모두 Undefined');
        } else {
          wrn(
            `그룹 정책이 실행 정책을 고정했습니다 (${blocked
              .map((s) => `${s}=${policies[s]}`)
              .join(', ')}).\n` +
              '        -ExecutionPolicy Bypass 가 무시되어 트레이가 뜨지 않을 수 있습니다.'
          );
        }
      }
    }

    log('');
    log('[8] MOTW (다른 PC에서 받은 파일 표시)');
    const trayPs1 = path.join(agentDir, 'assets', 'tray.ps1');
    if (process.platform !== 'win32') {
      wrn('Windows가 아니어서 확인하지 않았습니다.');
    } else if (!fs.existsSync(trayPs1)) {
      wrn('assets/tray.ps1 이 없어 확인을 건너뜁니다.');
    } else {
      const out = runPowerShell(
        `if (Get-Item -LiteralPath '${trayPs1}' -Stream Zone.Identifier -ErrorAction SilentlyContinue) ` +
          "{ 'MOTW' } else { 'CLEAN' }"
      );
      if (out === null) {
        wrn('powershell.exe 를 실행하지 못했습니다.');
      } else if (out.includes('MOTW')) {
        wrn(
          'Zone.Identifier 스트림이 붙어 있습니다 (인터넷에서 받은 파일로 표시됨).\n' +
            '        PowerShell이 스크립트 실행을 거부할 수 있습니다. 해제:\n' +
            `          Get-ChildItem -Recurse "${agentDir}" | Unblock-File`
        );
      } else {
        ok('차단 표시 없음');
      }
    }

    log('');
    log('[9] 언어 모드');
    if (process.platform !== 'win32') {
      wrn('Windows가 아니어서 확인하지 않았습니다.');
    } else {
      const out = runPowerShell('$ExecutionContext.SessionState.LanguageMode');
      if (out === null) wrn('powershell.exe 를 실행하지 못했습니다.');
      else if (out.trim() === 'ConstrainedLanguage') {
        wrn('ConstrainedLanguage 입니다 — .NET 타입을 못 써서 트레이 아이콘을 만들 수 없습니다.');
      } else ok(out.trim() || '(확인하지 못함)');
    }
  }

  log('');
  if (failures > 0) {
    log(`❌ FAIL ${failures}건 — 위 항목을 확인하세요.`);
    process.exit(1);
  }
  log('✅ 에이전트 항목 통과');
  log('');
  log('서버 도달성·인증·타임아웃 체인은 훅 쪽 도구가 봅니다:');
  log(`  node "${path.join(clientDir, 'install.mjs')}" --doctor`);
}

// ------------------------------------------------------------------------------

async function main() {
  const clientDir = resolveClientDir();
  const agentDir = agentDirOf(clientDir);

  if (has('--check') || has('--doctor')) {
    log(`대상: ${agentDir}`);
    await diagnose(clientDir, agentDir, has('--doctor'));
    return;
  }

  if (!nodeVersionOk()) {
    fail(
      `Node ${MIN_NODE.join('.')} 이상이 필요합니다 (현재 ${process.versions.node}).\n` +
        '   https://nodejs.org 에서 LTS를 설치한 뒤 다시 실행하세요.\n' +
        '   (이 설치기는 Node 런타임을 동봉하지 않습니다.)'
    );
  }

  assertNotSourceTree(agentDir);
  assertCwdOutside(agentDir);

  log('Husky Windows 에이전트를 설치합니다.');
  log(`  묶음: ${BUNDLE_DIR}`);
  log(`  대상: ${agentDir}`);

  const bundleDigest = computeDigest(BUNDLE_DIR);
  if (!bundleDigest) fail(`묶음에 dist/·assets/ 가 없습니다: ${BUNDLE_DIR}`);
  const installedDigest = fs.existsSync(agentDir) ? computeDigest(agentDir) : null;

  if (installedDigest && installedDigest === bundleDigest && !has('--force')) {
    log('');
    log(`변경 없음 — 이미 같은 내용이 설치되어 있습니다 (sha256 ${bundleDigest.slice(0, 12)}).`);
    log('다시 설치하려면 --force 를 붙이세요.');
    return;
  }

  log('');
  log('실행 중인 에이전트를 확인합니다.');
  await stopRunningAgent();

  log('');
  log(installedDigest ? '업데이트합니다.' : '새로 설치합니다.');
  replaceInstall(clientDir, agentDir);

  log('');
  log('✅ 설치 완료');
  log(`  경로       : ${agentDir}`);
  log(`  다이제스트 : ${bundleDigest.slice(0, 12)}`);
  log('');
  if (!fs.existsSync(path.join(clientDir, '.husky.env'))) {
    warn(
      `${path.join(clientDir, '.husky.env')} 가 아직 없습니다.\n` +
        '   에이전트는 이 파일을 훅과 공유합니다. 설치기는 이 파일을 만들지 않습니다:\n' +
        `     node "${path.join(clientDir, 'install.mjs')}"`
    );
    log('');
  }
  log('기동:');
  log(`  cd "${agentDir}"`);
  log('  node dist/index.js');
  log('');
  log('정상이면 아래 로그가 나옵니다 (알림 줄은 설정에 따라 켜짐/꺼짐):');
  log('  [husky-agent] 서버: http://...');
  log('  [husky-agent] 호스트 라벨: ...');
  log('  [husky-agent] 알림: 켜짐');
  log('  [husky-agent] 대기 중입니다. 종료하려면 Ctrl-C.');
  log('  [husky-agent] 트레이 아이콘을 표시했습니다.');
  log('');
  log('서버가 꺼져 있으면 아래가 나오고 계속 재시도합니다 (설치 실패가 아닙니다):');
  log('  [husky-agent] 서버에 연결할 수 없습니다: ...');
  log('  [husky-agent] 연결될 때까지 자동으로 재시도합니다.');
  log('');
  log('점검: node install-agent.mjs --doctor');
  log('자동 시작은 지원하지 않습니다 — 로그인할 때마다 직접 실행하세요.');
}

// uninstall-agent.mjs 가 이 파일을 import 할 때는 main을 돌리지 않는다.
const isEntry =
  Boolean(process.argv[1]) &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isEntry) {
  main().catch((err) => fail(err && err.message ? err.message : String(err)));
}
