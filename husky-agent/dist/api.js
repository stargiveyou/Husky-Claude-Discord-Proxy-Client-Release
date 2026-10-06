/**
 * 서버 REST 클라이언트 (에이전트용)
 *
 * 타입 정의는 shared/ 의 공용 선언 파일 한 곳에 있다. 선언 전용이라 빌드 산출물이
 * 생기지 않으므로, 이 패키지는 여전히 독립적으로 빌드·배포된다.
 */
import http from 'node:http';
import https from 'node:https';
import { config } from './config.js';
function call(method, path, body) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const headers = {};
        if (data) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = String(Buffer.byteLength(data));
        }
        if (config.token)
            headers.Authorization = `Bearer ${config.token}`;
        // baseUrl의 스킴에 따라 모듈을 고른다. HUSKY_URL이 https면 여기도 TLS로 간다.
        // TLS 검증 옵션은 기본값 그대로 둔다 (rejectUnauthorized를 끄면 터널 구간이 무방비).
        const base = new URL(config.baseUrl);
        const transport = base.protocol === 'https:' ? https : http;
        const defaultPort = base.protocol === 'https:' ? 443 : 80;
        // 경로 접두사(리버스 프록시가 하위 경로에 붙인 경우)를 보존한다.
        const prefix = base.pathname === '/' ? '' : base.pathname.replace(/\/+$/, '');
        const req = transport.request({
            hostname: base.hostname,
            port: base.port ? Number(base.port) : defaultPort,
            path: prefix + path,
            method,
            headers,
            timeout: 15000,
        }, (res) => {
            let raw = '';
            res.setEncoding('utf-8');
            res.on('data', (c) => (raw += c));
            res.on('end', () => {
                if (!res.statusCode || res.statusCode >= 400) {
                    reject(new Error(`${method} ${path} → ${res.statusCode} ${raw.slice(0, 200)}`));
                    return;
                }
                try {
                    resolve((raw ? JSON.parse(raw) : {}));
                }
                catch (err) {
                    reject(err);
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error(`${method} ${path} 시간 초과`));
        });
        if (data)
            req.write(data);
        req.end();
    });
}
export const api = {
    health: () => call('GET', '/health'),
    pending: () => call('GET', '/api/v1/requests/pending'),
    decide: (id, decision, reason) => call('POST', `/api/v1/requests/${encodeURIComponent(id)}/decision`, {
        decision,
        reason,
        decidedBy: `agent:${config.hostLabel}`,
    }),
    /**
     * 세션 등록 / 하트비트 갱신.
     *
     * ⚠️ 현재 에이전트는 자신이 관리하는 세션을 알지 못한다.
     * PTY 래퍼(A3)가 붙으면 래퍼가 세션 단위로 이 API를 호출하게 되며,
     * 그때 비로소 유령 세션 문제가 해결된다.
     */
    registerSession: (sessionId, cwd, pid) => call('POST', '/api/v1/sessions/register', {
        sessionId,
        cwd,
        hostname: config.hostLabel,
        pid,
    }),
    /** 서버가 알고 있는 세션 전체. 사용량 수집기가 이 목록에서 자기 호스트 세션만 고른다 */
    sessions: () => call('GET', '/api/v1/sessions'),
    /**
     * Claude 토큰 사용량 보고 (API_SPECIFICATION.md 2.7).
     *
     * ⚠️ **절대 총계**를 보낸다. 델타를 보내면 안 된다 — 서버는 필드별 max로 단조 병합하므로
     *    같은 값을 몇 번 보내도 결과가 같고(멱등), 재시작 후 처음부터 다시 읽어도 안전하다.
     * ⚠️ entries는 최대 5,000개다. 넘으면 400이므로 호출 전에 나눠야 한다.
     */
    reportUsage: (body) => call('POST', '/api/v1/usage/report', body),
};
