/**
 * Windows 토스트 알림
 * ==============================================================================
 * Windows 10/11 토스트는 액션 버튼을 지원한다. node-notifier가 번들한 SnoreToast를
 * 통해 [승인] / [거부] 버튼을 붙이면, 알림에서 바로 처리할 수 있다.
 * PC 앞에 있을 때는 디스코드보다 빠른 경로가 된다.
 *
 * ⚠️ 버튼 콜백의 신뢰성은 환경에 따라 다르다.
 *    동작하지 않으면 알림 클릭 → 대시보드 열기로 자연스럽게 축소된다(폴백 내장).
 * ==============================================================================
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import notifier from 'node-notifier';
import { config } from './config.js';
const ALLOW_LABEL = '승인';
const DENY_LABEL = '거부';
/**
 * 토스트에 붙일 아이콘 경로. 트레이와 같은 아트워크를 쓴다.
 *
 * 경로는 트레이와 마찬가지로 config.agentDir 기준이다 — `build`가 src/만 dist/로 옮기므로
 * __dirname 기준으로 찾으면 dist/ 실행 시 assets/를 놓친다.
 *
 * 파일이 없으면 undefined를 돌려 **아이콘 없이** 알림을 띄운다. SnoreToast는 존재하지 않는
 * 경로를 받으면 알림 자체를 띄우지 못하므로, 아트워크 누락이 승인 흐름을 막지 않게 한다.
 */
function iconPath(state) {
    const file = path.join(config.agentDir, 'assets', `husky-${state}.png`);
    return fs.existsSync(file) ? file : undefined;
}
/** 권한 요청·결과 토스트는 에이전트가 살아 있을 때만 뜬다 — 늘 컬러(연결됨) 아트워크다. */
const TOAST_ICON = iconPath('connected');
/** 명령어/파일 경로를 알림 본문용으로 한 줄 요약한다. */
export function summarize(req) {
    const ti = req.toolInput;
    const raw = typeof ti.command === 'string'
        ? ti.command
        : typeof ti.file_path === 'string'
            ? ti.file_path
            : JSON.stringify(ti);
    const oneLine = raw.replace(/\s+/g, ' ').trim();
    return oneLine.length > 110 ? `${oneLine.slice(0, 110)}…` : oneLine;
}
/** 기본 브라우저로 URL을 연다. */
export function openUrl(url) {
    if (!url)
        return;
    try {
        if (process.platform === 'win32') {
            // start의 첫 인자는 창 제목이라 빈 문자열을 넣어야 한다.
            spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
        }
        else if (process.platform === 'darwin') {
            spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
        }
        else {
            spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
        }
    }
    catch {
        /* 브라우저를 못 열어도 알림 흐름은 계속된다 */
    }
}
/**
 * 권한 요청 토스트를 띄우고 사용자의 선택을 반환한다.
 * 알림을 띄울 수 없으면 'dismissed'를 반환한다.
 */
export function notifyRequest(req) {
    if (!config.notifications)
        return Promise.resolve('dismissed');
    return new Promise((resolve) => {
        let settled = false;
        const finish = (choice) => {
            if (settled)
                return;
            settled = true;
            resolve(choice);
        };
        try {
            notifier.notify({
                title: `🔐 권한 요청 · ${req.hostname || '(PC 미상)'} · ${req.toolName}`,
                message: summarize(req),
                icon: TOAST_ICON,
                // Windows(SnoreToast)에서 액션 버튼으로 렌더링된다.
                actions: [ALLOW_LABEL, DENY_LABEL],
                wait: true,
                timeout: 60,
            }, (err, response, metadata) => {
                if (err) {
                    finish('dismissed');
                    return;
                }
                // 버튼을 눌렀다면 activationValue에 버튼 라벨이 담긴다.
                const activation = String(metadata?.activationValue ?? '').trim();
                if (activation === ALLOW_LABEL)
                    return finish('allow');
                if (activation === DENY_LABEL)
                    return finish('deny');
                // 버튼이 아니라 알림 본문을 클릭한 경우 → 대시보드 열기
                const res = String(response ?? '').toLowerCase();
                if (res.includes('activate') || res.includes('clicked')) {
                    return finish('open');
                }
                finish('dismissed');
            });
        }
        catch {
            finish('dismissed');
        }
    });
}
/** 처리 결과를 간단히 알린다 (버튼 없음). */
export function notifyResult(title, message) {
    if (!config.notifications)
        return;
    try {
        notifier.notify({ title, message, icon: TOAST_ICON, timeout: 5 });
    }
    catch {
        /* 무시 */
    }
}
