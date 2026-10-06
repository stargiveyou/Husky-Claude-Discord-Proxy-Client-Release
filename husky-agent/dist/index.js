/**
 * Husky Windows 에이전트
 * ==============================================================================
 * UI가 없는 상주 프로세스다. 하는 일:
 *   · 서버 /ws 구독 → 새 권한 요청이 오면 Windows 토스트 알림
 *   · 토스트의 [승인] / [거부] 버튼으로 즉시 처리
 *   · 알림 본문 클릭 → 웹 대시보드 열기
 *   · 세션 하트비트 (PTY 래퍼 연동 시 본격 동작)
 *   · Claude transcript 토큰 사용량 수집·보고 (usageCollector.ts)
 *
 * 실행:
 *   npm run dev      (개발)
 *   npm start        (빌드 후)
 * ==============================================================================
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { api } from './api.js';
import { RealtimeClient } from './realtime.js';
import { notifyRequest, notifyResult, openUrl, summarize } from './notifier.js';
import { createTray } from './tray.js';
import { UsageCollector } from './usageCollector.js';
/** 이미 알림을 띄운 요청 — 중복 알림 방지 */
const notified = new Set();
/** 처리 중인 요청 — 중복 결정 방지 */
const inFlight = new Set();
const log = (msg) => console.log(`[husky-agent] ${msg}`);
const warn = (msg) => console.warn(`[husky-agent] ${msg}`);
// ------------------------------------------------------------------------------
// 권한 요청 처리
// ------------------------------------------------------------------------------
async function handleRequest(req) {
    // 다른 PC의 요청은 띄우지 않는다. 띄우면 이 PC 앞에서 남의 PC 작업을 승인하게 되고,
    // 토스트에는 도구·명령만 보여 어느 PC의 작업인지 확인할 수단이 없다.
    // hostname이 없는 요청(구버전 훅)은 귀속시킬 호스트가 없으므로 그대로 띄운다 —
    // 막으면 훅을 아직 갱신하지 않은 PC에서 토스트가 조용히 사라진다.
    if (req.hostname && req.hostname !== config.hostLabel)
        return;
    if (notified.has(req.id) || inFlight.has(req.id))
        return;
    notified.add(req.id);
    log(`권한 요청: ${req.toolName} · ${summarize(req)}`);
    const choice = await notifyRequest(req);
    if (choice === 'open') {
        const url = config.dashboardUrl;
        openUrl(url);
        return;
    }
    if (choice !== 'allow' && choice !== 'deny') {
        // 무시하거나 시간이 지난 경우 — 디스코드나 웹에서 계속 처리할 수 있다.
        return;
    }
    if (inFlight.has(req.id))
        return;
    inFlight.add(req.id);
    try {
        await api.decide(req.id, choice, `Windows 에이전트 토스트에서 처리 (${config.hostLabel})`);
        log(`${choice === 'allow' ? '승인' : '거부'} 완료: ${req.id}`);
        notifyResult(choice === 'allow' ? '✅ 승인했습니다' : '❌ 거부했습니다', summarize(req));
    }
    catch (err) {
        // 이미 디스코드나 웹에서 처리되었을 수 있다.
        warn(`결정 전송 실패 (${req.id}): ${err instanceof Error ? err.message : String(err)}`);
        notifyResult('⚠️ 처리하지 못했습니다', '이미 다른 곳에서 처리되었을 수 있습니다.');
    }
    finally {
        inFlight.delete(req.id);
    }
}
// ------------------------------------------------------------------------------
// 하트비트
// ------------------------------------------------------------------------------
/**
 * 에이전트가 관리하는 세션 목록.
 *
 * ⚠️ 현재는 비어 있다. PTY 래퍼(A3)가 `husky-run claude`로 세션을 띄우면
 * 그 래퍼가 여기에 세션을 등록하고, 프로세스 종료 시 제거한다.
 * 그때 비로소 "유령 세션" 문제가 해결된다.
 */
export const managedSessions = new Map();
function startHeartbeat() {
    const timer = setInterval(() => {
        for (const [sessionId, info] of managedSessions) {
            api.registerSession(sessionId, info.cwd, info.pid).catch(() => {
                /* 서버가 잠시 끊겨도 다음 주기에 재시도 */
            });
        }
    }, config.heartbeatIntervalMs);
    // 하트비트는 프로세스 수명에 관여하지 않는다. 살아 있는 동안 주기적으로 돌 뿐이다.
    // 수명은 RealtimeClient의 keep-alive 핸들이 단독으로 결정한다 (realtime.ts 주석 참고).
    timer.unref?.();
    return timer;
}
// ------------------------------------------------------------------------------
// PID 파일
// ------------------------------------------------------------------------------
/**
 * 실행 중인 에이전트를 가리키는 PID 파일.
 *
 * ⚠️ **설치 디렉터리 밖**에 둔다. 안에 두면 install-agent.mjs의 교체 대상
 *    (agent/ 통째 rename)에 포함되어, 업데이트가 종료 대상을 찾으려 읽는 시점에
 *    이미 사라진 뒤가 된다.
 *
 * 파일로 남기는 이유: 에이전트 프로세스의 CommandLine은
 * `"...\node.exe" dist/index.js` 뿐이라 **cwd가 드러나지 않는다.**
 * CommandLine 패턴 매칭으로는 어느 설치본인지 식별할 수 없다.
 */
const PID_FILE = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'husky-agent', 'agent.pid');
/**
 * PID 파일을 기록한다.
 *
 * ⚠️ **동기 fs 호출만** 쓴다. 타이머·watcher·스트림을 추가하면 "프로세스 수명은
 *    RealtimeClient의 keep-alive가 단독으로 결정한다"는 불변식이 깨진다.
 *    실패는 warn 한 줄로 끝낸다 — PID 파일은 업데이트 편의를 위한 것이지 동작 조건이 아니다.
 */
function writePidFile() {
    try {
        fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
        fs.writeFileSync(PID_FILE, JSON.stringify({
            pid: process.pid,
            installDir: config.agentDir,
            startedAt: new Date().toISOString(),
        }), 'utf-8');
    }
    catch (err) {
        warn(`PID 파일을 기록하지 못했습니다: ${err instanceof Error ? err.message : String(err)}`);
    }
}
/**
 * PID 파일을 지운다. **적힌 pid가 자기 자신일 때만** 지운다 —
 * 나중에 뜬 다른 인스턴스가 덮어썼다면 그쪽 기록을 없애면 안 된다.
 */
function removePidFile() {
    try {
        const parsed = JSON.parse(fs.readFileSync(PID_FILE, 'utf-8'));
        if (parsed.pid !== process.pid)
            return;
        fs.unlinkSync(PID_FILE);
    }
    catch {
        /* 없거나 읽히지 않으면 지울 것도 없다 */
    }
}
// ------------------------------------------------------------------------------
// 기동
// ------------------------------------------------------------------------------
async function main() {
    log(`서버: ${config.baseUrl}`);
    log(`호스트 라벨: ${config.hostLabel}`);
    log(`알림: ${config.notifications ? '켜짐' : '꺼짐'}`);
    // 서버 연결 확인 (실패해도 계속 시도한다)
    try {
        const health = await api.health();
        log(`서버 연결 확인 · authEnabled=${health.authEnabled}`);
        if (health.authEnabled && !config.token) {
            warn('서버가 인증을 요구하지만 HUSKY_TOKEN이 비어 있습니다. 승인 요청이 401로 거부됩니다.');
        }
    }
    catch (err) {
        warn(`서버에 연결할 수 없습니다: ${err instanceof Error ? err.message : String(err)}`);
        warn('연결될 때까지 자동으로 재시도합니다.');
    }
    // 실행 중임을 파일로 남긴다 (설치기가 업데이트 전에 이 프로세스를 찾아 종료한다).
    writePidFile();
    const heartbeat = startHeartbeat();
    // Claude 토큰 사용량 수집 — 서버 세션 목록에서 이 호스트의 세션만 골라 transcript를
    // 증분으로 읽고 30초마다 절대 총계를 보고한다. 기동 직후 전량 재독은 비동기로 돌며
    // 트레이·토스트를 막지 않는다.
    const usageCollector = new UsageCollector();
    usageCollector.start();
    // 트레이는 shutdown이 정의된 뒤에 만든다 (메뉴에서 종료를 부르기 때문).
    let tray = null;
    const realtime = new RealtimeClient({
        onOpen: () => {
            log('실시간 연결됨');
            tray?.updateStatus('connected');
            // 끊겨 있던 동안 생긴 요청을 놓치지 않도록 한 번 훑는다.
            api
                .pending()
                .then(({ requests }) => {
                for (const req of requests) {
                    if (req.status === 'PENDING')
                        void handleRequest(req);
                }
            })
                .catch(() => {
                /* 다음 이벤트에서 처리 */
            });
        },
        onClose: () => {
            warn('실시간 연결이 끊겼습니다. 재연결을 시도합니다.');
            tray?.updateStatus('disconnected');
        },
        onEvent: (event, data) => {
            if (event === 'REQUEST_CREATED') {
                void handleRequest(data);
            }
            else {
                // 결정·만료된 요청은 추적 목록에서 제거한다.
                notified.delete(data.id);
            }
        },
    });
    realtime.start();
    log('대기 중입니다. 종료하려면 Ctrl-C.');
    // Ctrl-C / 서비스 정지. realtime.stop()이 keep-alive까지 해제하므로
    // 생존 핸들이 종료를 붙잡지 않는다.
    const shutdown = () => {
        log('종료합니다.');
        clearInterval(heartbeat);
        usageCollector.stop();
        realtime.stop();
        removePidFile();
        tray?.dispose();
        process.exit(0);
    };
    tray = createTray({
        onOpenDashboard: () => openUrl(config.dashboardUrl),
        onQuit: () => shutdown(),
    });
    // shutdown()을 거치지 않는 종료 경로(예외·process.exit)에서도 PID 파일을 남기지 않는다.
    // 동기 호출이라 exit 핸들러에서 안전하다.
    process.on('exit', removePidFile);
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
main().catch((err) => {
    console.error('[husky-agent] 치명적 오류:', err);
    process.exit(1);
});
