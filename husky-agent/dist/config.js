/**
 * 에이전트 설정 로더
 * ==============================================================================
 * 훅(../hook/husky-hook.js)과 **같은 설정 파일**을 읽는다. 둘은 언제나 client/ 아래
 * 나란히 배포되므로 경로를 찾아 헤맬 필요가 없다.
 *
 *   1) 프로세스 환경 변수
 *   2) client/.husky.env   ← 훅과 공유하는 기본 설정 위치
 *   3) 저장소 루트 .env    ← 서버 소스가 옆에 있을 때만 (서버와 같은 PC인 경우)
 * ==============================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** agent 패키지 폴더 (agent/src 또는 agent/dist의 상위) */
const agentDir = path.resolve(__dirname, '..');
/** 훅과 설정을 공유하는 client/ 폴더 */
const clientDir = path.resolve(agentDir, '..');
/** 저장소 루트 후보 */
const repoRoot = path.resolve(clientDir, '..');
/**
 * 서버 소스가 실제로 옆에 있을 때만 저장소 .env를 읽는다.
 * client/ 를 홈 디렉터리 등으로 복사한 경우 무관한 .env를 주워 오면 안 된다.
 */
const insideRepo = fs.existsSync(path.join(repoRoot, 'src', 'backend'));
function parseEnvFile(filePath) {
    const result = {};
    let raw;
    try {
        raw = fs.readFileSync(filePath, 'utf-8');
    }
    catch {
        return result;
    }
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#'))
            continue;
        const eq = trimmed.indexOf('=');
        if (eq < 0)
            continue;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if (!/^["']/.test(value)) {
            const hash = value.indexOf(' #');
            if (hash >= 0)
                value = value.slice(0, hash).trim();
        }
        value = value.replace(/^(["'])(.*)\1$/, '$2');
        if (key)
            result[key] = value;
    }
    return result;
}
// 뒤에 오는 것이 높은 우선순위가 되도록 낮은 것부터 펼친다.
const merged = {
    ...(insideRepo ? parseEnvFile(path.join(repoRoot, '.env')) : {}),
    ...parseEnvFile(path.join(clientDir, '.husky.env')),
};
// 환경 변수가 최우선
for (const key of Object.keys(merged)) {
    const fromEnv = (process.env[key] ?? '').trim();
    if (fromEnv)
        merged[key] = fromEnv;
}
for (const [key, value] of Object.entries(process.env)) {
    if (!(key in merged) && value)
        merged[key] = value;
}
function num(key, fallback) {
    const parsed = Number.parseInt(merged[key] ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function bool(key, fallback) {
    const v = (merged[key] ?? '').trim().toLowerCase();
    if (!v)
        return fallback;
    return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}
/**
 * HUSKY_URL을 서버 기본 URL로 정규화한다. 훅(hook/husky-hook.js의 resolveServer)과
 * 같은 규칙이다 — 빈 값·파싱 실패·http/https 아닌 스킴이면 null을 돌려 HOST/PORT로 되돌아간다.
 */
function normalizeHuskyUrl() {
    const raw = (merged.HUSKY_URL ?? '').trim();
    if (!raw)
        return null;
    let parsed;
    try {
        parsed = new URL(raw);
    }
    catch {
        return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        return null;
    if (!parsed.hostname)
        return null;
    // 끝의 '/'만 떼고 나머지(경로 접두사 포함)는 그대로 둔다.
    return raw.replace(/\/+$/, '');
}
const huskyUrl = normalizeHuskyUrl();
export const config = {
    /** 저장소 안에서 돌고 있으면 그 루트, 단독 배포면 null */
    projectRoot: insideRepo ? repoRoot : null,
    /** 이 패키지의 폴더 */
    agentDir,
    /** 훅과 설정을 공유하는 폴더 */
    clientDir,
    /** 서버 접속 정보 */
    host: merged.HUSKY_HOST || '127.0.0.1',
    port: num('HUSKY_PORT', 3001),
    token: merged.HUSKY_TOKEN || merged.API_SECRET_KEY || '',
    /** 이 PC를 식별할 이름 */
    hostLabel: merged.HUSKY_HOST_LABEL || os.hostname(),
    /** 토스트 알림 사용 여부 */
    notifications: bool('HUSKY_AGENT_NOTIFICATIONS', true),
    /** 세션 하트비트 주기 (ms) */
    heartbeatIntervalMs: num('HUSKY_AGENT_HEARTBEAT_MS', 30000),
    /**
     * 웹 대시보드 주소 — 토스트 본문 클릭·트레이 메뉴 '대시보드 열기'가 여는 주소.
     *
     * HUSKY_DASHBOARD_URL이 비면 **서버 origin의 `/proxyDashboard/`** 로 간다.
     * baseUrl 뒤에 이어 붙이지 않는 이유: nginx 구성에서 baseUrl은 `/claudeProxy`
     * 서브패스를 포함하지만(API·WS용), 대시보드 location은 origin 루트에 따로 있다
     * (MAC_SERVER_GUIDE의 `location ^~ /proxyDashboard/`). 서버가 @fastify/static으로
     * 서빙하는 prefix도 `/proxyDashboard/`다 (src/backend/server.ts).
     */
    get dashboardUrl() {
        const explicit = (merged.HUSKY_DASHBOARD_URL ?? '').trim();
        if (explicit)
            return explicit;
        try {
            return `${new URL(this.baseUrl).origin}/proxyDashboard/`;
        }
        catch {
            // baseUrl이 파싱되지 않는 구성이면 서버 주소라도 연다.
            return this.baseUrl;
        }
    },
    /**
     * 서버 기본 URL.
     * HUSKY_URL이 있으면 그것을 쓰고(ngrok 등 HTTPS 터널), 없으면 HOST/PORT로 평문 http.
     */
    get baseUrl() {
        return huskyUrl ?? `http://${this.host}:${this.port}`;
    },
    /** WebSocket 주소. baseUrl의 스킴을 그대로 따라간다 (https → wss). */
    get wsUrl() {
        const base = this.baseUrl;
        const ws = base.startsWith('https://')
            ? `wss://${base.slice('https://'.length)}`
            : `ws://${base.replace(/^http:\/\//, '')}`;
        return `${ws}/ws`;
    },
};
