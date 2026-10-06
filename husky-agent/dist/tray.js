/**
 * 트레이 아이콘 컨트롤러
 * ==============================================================================
 * PowerShell(assets/tray.ps1)을 stdio 파이프로 띄워 알림 영역에 아이콘을 올린다.
 * npm 의존성을 늘리지 않으려고 네이티브 트레이 모듈 대신 이 방식을 쓴다.
 *
 * ⚠️ 트레이는 있으면 좋은 부가 기능이다. **생성 실패가 WebSocket·토스트를 막으면 안 된다.**
 *    어떤 실패든 warn 한 줄을 남기고 null을 돌려주며, 예외를 던지지 않는다.
 *
 * 상태는 Node → PS 단방향(push)이다. PS에서 상태를 되읽지 않으므로 getStatus는 두지 않는다.
 * ==============================================================================
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { config } from './config.js';
const warn = (msg) => console.warn(`[husky-agent] ${msg}`);
const log = (msg) => console.log(`[husky-agent] ${msg}`);
/**
 * 파이프 스트림의 unref.
 *
 * 런타임에는 net.Socket이라 unref()가 있지만, @types/node가 선언한
 * ChildProcess.stdin/stdout/stderr 타입은 Writable/Readable이라 이 메서드가 없다.
 * **동작을 빼지 않고 타입만 좁힌다** — 트레이가 생존 핸들을 붙잡으면
 * "프로세스 수명은 RealtimeClient의 keep-alive가 단독으로 결정한다"는 불변식
 * (20260913-05)이 깨져 에이전트가 종료되지 않는 회귀가 난다.
 */
function unrefStream(stream) {
    stream?.unref?.();
}
export function createTray(opts) {
    // 트레이는 Windows 전용이다. 다른 OS에서는 조용히 넘어간다.
    if (process.platform !== 'win32')
        return null;
    // 경로는 config.agentDir 기준이다. `build`가 src/만 dist/로 옮기므로
    // __dirname 기준으로 찾으면 dist/ 실행 시 assets/를 놓친다.
    const scriptPath = path.join(config.agentDir, 'assets', 'tray.ps1');
    if (!fs.existsSync(scriptPath)) {
        warn(`트레이 스크립트를 찾을 수 없습니다: ${scriptPath} — 트레이 없이 계속합니다.`);
        return null;
    }
    // 상태별 아이콘 두 장 — 컬러(연결됨) / 흑백(연결 끊김).
    // scripts/make-icon.mjs가 assets/husky-*.png에서 만들어 두는 산출물이다.
    const iconConnected = path.join(config.agentDir, 'assets', 'husky-connected.ico');
    const iconDisconnected = path.join(config.agentDir, 'assets', 'husky-disconnected.ico');
    const args = [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
    ];
    // 아이콘 인자는 위치로 구분된다(1=연결됨, 2=끊김). 한쪽만 있으면 나머지는 빈 문자열로
    // 자리를 채워 순서를 지킨다. 둘 다 없으면 인자를 아예 넘기지 않고 PS가 시스템 아이콘을 쓴다.
    const hasConnected = fs.existsSync(iconConnected);
    const hasDisconnected = fs.existsSync(iconDisconnected);
    if (hasConnected || hasDisconnected) {
        args.push(hasConnected ? iconConnected : '', hasDisconnected ? iconDisconnected : '');
    }
    let child;
    try {
        child = spawn('powershell.exe', args, {
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            // cwd를 임시 폴더로 고정한다. 지정하지 않으면 PowerShell이 부모의 cwd
            // (= 에이전트 설치 디렉터리)를 상속한다. 아래 child.unref()와 Windows job object
            // 부재 때문에 강제 종료(taskkill /F)·크래시에서는 고아 PS가 남고, 그 고아가 잡고 있는
            // CWD 락이 설치 디렉터리 rename을 막아 업데이트가 실패한다.
            // (뒤쪽 process.on('exit') 정리는 /F·크래시에서 실행되지 않는다.)
            cwd: os.tmpdir(),
        });
    }
    catch (err) {
        warn(`트레이를 띄우지 못했습니다: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
    /** 자식이 죽었거나 오류가 난 뒤에는 모든 조작이 무해한 no-op이 된다. */
    let dead = false;
    let disposed = false;
    // stdout·stderr 양쪽을 반드시 배수한다. 읽지 않으면 파이프가 64KB에서 막혀
    // PowerShell이 블로킹되고 트레이가 정지한 것처럼 보인다.
    let buffer = '';
    child.stdout?.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index).replace(/\r$/, '').trim();
            buffer = buffer.slice(index + 1);
            if (!line)
                continue;
            let msg;
            try {
                msg = JSON.parse(line);
            }
            catch {
                continue; // 알 수 없는 줄은 버린다
            }
            if (msg.ready) {
                log('트레이 아이콘을 표시했습니다.');
                continue;
            }
            if (msg.menu === 'open') {
                try {
                    opts.onOpenDashboard();
                }
                catch {
                    /* 메뉴 처리 실패가 트레이를 죽이지 않는다 */
                }
            }
            else if (msg.menu === 'quit') {
                try {
                    opts.onQuit();
                }
                catch {
                    /* 위와 같다 */
                }
            }
        }
    });
    child.stderr?.on('data', (chunk) => {
        const text = chunk.toString('utf8').trim();
        if (text)
            warn(`트레이: ${text}`);
    });
    child.on('error', (err) => {
        dead = true;
        warn(`트레이 프로세스 오류: ${err.message}`);
    });
    child.on('exit', () => {
        dead = true;
    });
    // 프로세스 수명은 RealtimeClient의 keep-alive가 단독으로 결정한다는 불변식
    // (src/index.ts의 하트비트 주석 참고)을 트레이가 깨지 않게 한다.
    // detached는 쓰지 않는다 — 부모가 죽으면 트레이도 같이 정리되어야 한다.
    child.unref();
    unrefStream(child.stdin);
    unrefStream(child.stdout);
    unrefStream(child.stderr);
    // 비정상 종료 시에도 고스트 아이콘이 남지 않도록 동기적으로 정리한다.
    process.on('exit', () => {
        try {
            child.kill();
        }
        catch {
            /* 무시 */
        }
    });
    return {
        updateStatus(status) {
            if (dead || disposed)
                return;
            const stdin = child.stdin;
            if (!stdin || stdin.destroyed || !stdin.writable)
                return;
            try {
                stdin.write(`${JSON.stringify({ type: 'status', value: status })}\n`);
            }
            catch {
                /* 트레이가 사라져도 에이전트는 계속 돈다 */
            }
        },
        dispose() {
            if (disposed)
                return;
            disposed = true;
            try {
                // 종료 신호는 stdin EOF 하나뿐이다.
                child.stdin?.end();
            }
            catch {
                /* 무시 */
            }
            const timer = setTimeout(() => {
                try {
                    child.kill();
                }
                catch {
                    /* 무시 */
                }
            }, 300);
            timer.unref?.();
        },
    };
}
