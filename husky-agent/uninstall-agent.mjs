#!/usr/bin/env node
/**
 * Husky Windows 에이전트 제거기
 * ==============================================================================
 *   node uninstall-agent.mjs                  제거
 *   node uninstall-agent.mjs --check          지울 대상만 보여준다 (아무것도 바꾸지 않음)
 *   node uninstall-agent.mjs --target <path>  대상 client/ 폴더를 직접 지정
 *
 * 지우는 것은 `<client>/agent/` 하나뿐이다. **아래는 보존한다:**
 *   · `<client>/.husky.env`  — 훅과 공유하는 설정. 주체는 client/install.mjs 의 ensureEnvFile()
 *   · `<client>/hook/`       — 훅 본체
 *   · `~/.claude/settings.json` 의 훅 등록 — 해제는 `node ../install.mjs --remove`
 *
 * 경로 결정·프로세스 종료 로직은 install-agent.mjs 와 **같은 구현을 쓴다.**
 * 복제하면 한쪽만 고쳐져 드리프트가 난다.
 * ==============================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  resolveClientDir,
  agentDirOf,
  assertCwdOutside,
  stopRunningAgent,
  readPidFile,
  rmrf,
  log,
  fail,
} from './install-agent.mjs';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);

async function main() {
  const clientDir = resolveClientDir();
  const agentDir = agentDirOf(clientDir);

  if (!fs.existsSync(agentDir)) {
    log(`설치되어 있지 않습니다: ${agentDir}`);
    return;
  }

  if (has('--check')) {
    const info = readPidFile();
    log('제거하면 아래가 지워집니다:');
    log(`  ${agentDir}`);
    log('');
    log('보존되는 것:');
    log(`  ${path.join(clientDir, '.husky.env')}  (설정 — 훅과 공유)`);
    log(`  ${path.join(clientDir, 'hook')}  (훅 본체)`);
    log('  ~/.claude/settings.json 의 훅 등록');
    log('');
    log(info ? `실행 중인 에이전트: PID ${info.pid}` : '실행 중인 에이전트: 없음 (PID 파일 없음)');
    log('');
    log('실제로 지우려면 --check 없이 다시 실행하세요.');
    return;
  }

  // 제거 대상 안에서 실행하면 Windows가 폴더를 잠가 삭제가 실패한다.
  assertCwdOutside(agentDir);

  log(`Husky Windows 에이전트를 제거합니다 → ${agentDir}`);
  log('');
  log('실행 중인 에이전트를 확인합니다.');
  await stopRunningAgent();

  log('');
  try {
    rmrf(agentDir);
  } catch (err) {
    fail(
      `삭제에 실패했습니다: ${err && err.message ? err.message : String(err)}\n` +
        '   해당 폴더를 쓰는 창(탐색기·터미널·편집기)을 닫고 다시 실행하세요.'
    );
  }

  if (fs.existsSync(agentDir)) {
    fail(`삭제했지만 폴더가 남아 있습니다: ${agentDir}`);
  }

  log('✅ 제거 완료');
  log('');
  log('보존된 것:');
  log(`  ${path.join(clientDir, '.husky.env')}  (설정 — 훅이 계속 씁니다)`);
  log(`  ${path.join(clientDir, 'hook')}  (훅 본체)`);
  log('  ~/.claude/settings.json 의 훅 등록');
  log('');
  log('훅까지 해제하려면:');
  log(`  node "${path.join(clientDir, 'install.mjs')}" --remove`);
}

main().catch((err) => fail(err && err.message ? err.message : String(err)));
