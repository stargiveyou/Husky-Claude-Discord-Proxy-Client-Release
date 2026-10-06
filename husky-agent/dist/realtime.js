/**
 * 서버 WebSocket 구독 (자동 재연결)
 * ==============================================================================
 * 서버가 인증을 켠 경우 'husky-bearer' 서브프로토콜로 토큰을 전달한다.
 * (백엔드 src/backend/server.ts의 WS_AUTH_PROTOCOL과 일치해야 한다)
 * ==============================================================================
 */
import WebSocket from 'ws';
import { config } from './config.js';
const WS_AUTH_PROTOCOL = 'husky-bearer';
/**
 * 프로세스 생존용 타이머 주기 (ms).
 *
 * 하는 일이 없는 no-op 타이머다. 값 자체에는 의미가 없고 "ref된 핸들이 하나 떠 있다"는
 * 사실만 중요하다. 주기가 짧을 이유가 없으므로 깨어나는 횟수를 줄여 잡는다.
 */
const KEEP_ALIVE_INTERVAL_MS = 60_000;
/**
 * 서버 /ws 구독 클라이언트.
 *
 * ⚠️ 이 클래스가 **에이전트 프로세스의 생존 기간을 결정한다.**
 * start()와 stop() 사이에는 ref된 keep-alive 타이머를 하나 띄워 둔다. 이유:
 *
 *   · 에이전트에는 UI도 리스닝 서버도 없어서, 이벤트 루프를 붙잡는 핸들이
 *     WS 소켓 하나뿐이었다. 소켓이 닫히는 순간 ref된 핸들이 0이 되어
 *     "재연결을 시도합니다"를 찍자마자 Node가 exit 0으로 조용히 죽었다.
 *     (재연결 setTimeout은 unref되어 있어 프로세스를 붙잡지 못한다.)
 *   · process.on('SIGINT'/'SIGTERM') 핸들러는 이벤트 루프를 붙잡지 않는다.
 *     시그널 대기만으로는 프로세스가 살아남지 못한다.
 *
 * 타이머마다 unref를 떼는 대신 생존 핸들을 하나로 모은 이유는, "언제까지 살아 있나"를
 * 한 곳에서만 결정하기 위해서다. 하트비트·재연결 타이머는 계속 unref로 두어
 * 자기들이 프로세스 수명에 끼어들지 않게 한다. 수명은 오직 start()/stop()이 정한다.
 *
 * stop()은 keep-alive를 해제하므로, 종료 경로에서 이 핸들이 프로세스를 붙잡지 않는다.
 */
export class RealtimeClient {
    handlers;
    socket = null;
    retryDelay = 1000;
    stopped = false;
    timer = null;
    /** 프로세스 생존용 핸들 — start()에서 켜고 stop()에서 끈다 */
    keepAlive = null;
    constructor(handlers) {
        this.handlers = handlers;
    }
    start() {
        this.stopped = false;
        if (!this.keepAlive) {
            // 일부러 unref하지 않는다. 이 핸들 하나가 프로세스를 붙잡는다.
            this.keepAlive = setInterval(() => {
                /* 아무것도 하지 않는다 — 이벤트 루프를 붙잡는 것이 목적이다 */
            }, KEEP_ALIVE_INTERVAL_MS);
        }
        this.connect();
    }
    stop() {
        this.stopped = true;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.keepAlive) {
            clearInterval(this.keepAlive);
            this.keepAlive = null;
        }
        this.socket?.close();
        this.socket = null;
    }
    connect() {
        if (this.stopped)
            return;
        try {
            // 에이전트는 Node 환경이라 헤더도 쓸 수 있지만,
            // 서버와 브라우저가 공유하는 서브프로토콜 방식으로 통일한다.
            this.socket = config.token
                ? new WebSocket(config.wsUrl, [WS_AUTH_PROTOCOL, config.token])
                : new WebSocket(config.wsUrl);
        }
        catch {
            this.scheduleReconnect();
            return;
        }
        this.socket.on('open', () => {
            this.retryDelay = 1000;
            this.handlers.onOpen?.();
        });
        this.socket.on('message', (raw) => {
            try {
                const parsed = JSON.parse(raw.toString());
                if (parsed?.event)
                    this.handlers.onEvent(parsed.event, parsed.data);
            }
            catch {
                /* 형식이 다른 메시지는 무시 */
            }
        });
        this.socket.on('close', () => {
            this.handlers.onClose?.();
            this.scheduleReconnect();
        });
        this.socket.on('error', () => {
            // close 이벤트가 이어서 발생하므로 여기서는 재연결을 예약하지 않는다.
            this.socket?.close();
        });
    }
    scheduleReconnect() {
        if (this.stopped)
            return;
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            this.connect();
        }, this.retryDelay);
        this.timer.unref?.();
        this.retryDelay = Math.min(this.retryDelay * 2, 15000);
    }
}
