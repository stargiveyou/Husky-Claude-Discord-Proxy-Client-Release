/**
 * Claude transcript 사용량 수집기
 * ==============================================================================
 * 서버 세션 목록에서 **이 호스트의 세션만** 골라, 그 세션의 transcript 파일만 증분으로
 * 읽어 토큰 사용량을 집계하고 30초마다 서버에 **절대 총계**로 보고한다.
 *
 *   ~/.claude/projects/<cwd 인코딩>/<sessionId>.jsonl              ← 부모
 *   ~/.claude/projects/<cwd 인코딩>/<sessionId>/subagents/*.jsonl  ← 서브에이전트
 *
 * 지켜야 할 것:
 *   · ⚠️ **projects/ 전체를 훑지 않는다.** 폴더 이름만 나열해 대상 파일의 존재를 확인할 뿐,
 *     다른 대화 파일은 열지 않는다 (확정안 R1).
 *   · ⚠️ 신규 의존성 0 (★7). 감시는 chokidar 같은 라이브러리가 아니라 **주기 재검사**다.
 *   · ⚠️ 타이머는 unref한다. 이 프로세스의 수명은 RealtimeClient의 keep-alive 핸들이
 *     단독으로 결정한다 (realtime.ts·index.ts 주석 참고). 수집기가 수명을 붙잡으면 안 된다.
 *   · ⚠️ 오프셋·집계 상태를 **디스크에 저장하지 않는다.** 재시작하면 파일을 처음부터 다시
 *     읽어 복원한다. 절대 총계 보고라 멱등하다.
 *   · ⚠️ transcript는 **읽기만** 한다. 수정·삭제·이동하지 않는다.
 *   · ⚠️ 프롬프트·응답 본문은 메모리에 남기지 않는다. 집계에 쓰는 키만 뽑아 버린다.
 *   · ⚠️ 서버는 세션 소유권을 검증하지 않는다 (에이전트 전용 토큰이 아직 없다).
 *     여기서 hostname을 붙이는 것은 귀속 표시일 뿐 신원 증명이 아니다.
 *
 * 실패는 전부 삼킨다. 토스트 알림이 이 에이전트의 본업이고, 수집이 그것을 멈추면 안 된다.
 * ==============================================================================
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { api } from './api.js';
import { addUsageStats, applyRawTranscriptLines, buildUsageEntries, chunkUsageEntries, createUsageFileState, createUsageStats, isSafeReportKey, mergeMonotonic, sameUsageEntries, } from './usageAggregate.js';
/** 보고 주기 (지시서 3-3) */
const REPORT_INTERVAL_MS = 30000;
/** 서버 스키마 상한. 넘으면 400이므로 나눠 보낸다 (API 2.7) */
const MAX_ENTRIES_PER_REPORT = 5000;
/** 한 번에 읽는 바이트 수. 실측 최대 파일이 33MB라 통째로 들지 않는다 */
const READ_CHUNK_BYTES = 1024 * 1024;
/**
 * 개행 없이 이어지는 조각의 허용 상한. 이보다 길어지면 그 구간을 포기하고 건너뛴다.
 * (정상 transcript의 한 줄은 이보다 훨씬 짧다. 무한히 누적되는 것을 막는 안전장치다.)
 */
const MAX_PENDING_BYTES = 8 * 1024 * 1024;
/** 파일명으로 쓸 수 있는 세션 ID인지. 경로 조작(../)을 막는다 */
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;
const log = (msg) => console.log(`[husky-agent] ${msg}`);
const warn = (msg) => console.warn(`[husky-agent] ${msg}`);
export class UsageCollector {
    intervalMs;
    projectsDir;
    /** 파일 경로 → 오프셋·dedup 상태 */
    files = new Map();
    /** 세션 ID → transcript가 있는 프로젝트 폴더 (한 번 찾으면 재사용) */
    sessionDirs = new Map();
    /** 직전에 서버가 받아들인 엔트리. 단조 병합의 기준이자 '값이 같으면 보내지 않기' 비교 대상 */
    lastReported = [];
    timer = null;
    running = false;
    stopped = false;
    firstScanDone = false;
    /** 같은 경고를 주기마다 반복하지 않기 위한 표시 */
    warnedNoProjects = false;
    /** 직전 주기 실패 메시지 — 서버가 꺼져 있는 동안 30초마다 같은 줄을 찍지 않기 위함 */
    lastCycleError = null;
    constructor(options = {}) {
        this.intervalMs = options.intervalMs ?? REPORT_INTERVAL_MS;
        this.projectsDir = options.projectsDir ?? path.join(os.homedir(), '.claude', 'projects');
    }
    /**
     * 수집을 시작한다. 기동 직후 전량 재독은 **비동기로** 돌며 트레이·토스트를 막지 않는다.
     */
    start() {
        if (this.timer)
            return;
        if (!isSafeReportKey(config.hostLabel) || !config.hostLabel || config.hostLabel.length > 255) {
            warn(`호스트 라벨 "${config.hostLabel}"은 사용량 보고에 쓸 수 없습니다. 수집을 끕니다.`);
            return;
        }
        log(`사용량 수집 시작 · ${this.projectsDir} · 주기 ${Math.round(this.intervalMs / 1000)}초`);
        // 첫 주기는 즉시 (await하지 않는다 — 기동을 막으면 안 된다)
        void this.runCycle();
        this.timer = setInterval(() => void this.runCycle(), this.intervalMs);
        // 수집기는 프로세스 수명에 관여하지 않는다.
        this.timer.unref?.();
    }
    stop() {
        this.stopped = true;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    /** 한 주기: 세션 목록 → 증분 읽기 → 집계 → 변화가 있으면 보고 */
    async runCycle() {
        // 앞 주기가 아직 돌고 있으면 건너뛴다 (첫 전량 재독이 30초를 넘을 수 있다).
        if (this.running || this.stopped)
            return;
        this.running = true;
        const startedAt = Date.now();
        try {
            const sessions = await this.listOwnSessions();
            if (!sessions.length)
                return;
            const inputs = [];
            const stats = createUsageStats();
            for (const session of sessions) {
                if (this.stopped)
                    return;
                const states = await this.collectSession(session.id, stats);
                if (!states.length)
                    continue;
                inputs.push({ sessionId: session.id, cwd: session.cwd || undefined, states });
            }
            const { entries, dropped } = buildUsageEntries(inputs);
            if (dropped > 0) {
                warn(`사용량 엔트리 ${dropped}개를 서버 스키마 제약(예약 키·길이)으로 제외했습니다.`);
            }
            if (!this.firstScanDone) {
                this.firstScanDone = true;
                log(`사용량 전량 재독 완료 · ${Date.now() - startedAt}ms · 파일 ${this.files.size}개 · ` +
                    `줄 ${stats.totalLines} (반영 ${stats.applied} · 중복 ${stats.superseded} · ` +
                    `파싱실패 ${stats.parseFailed}) · 엔트리 ${entries.length}개`);
            }
            await this.report(entries);
            this.lastCycleError = null;
        }
        catch (err) {
            // 서버가 꺼져 있으면 30초마다 같은 오류가 난다. 메시지가 바뀔 때만 남긴다.
            const message = err instanceof Error ? err.message : String(err);
            if (message !== this.lastCycleError) {
                this.lastCycleError = message;
                warn(`사용량 수집 주기 실패: ${message}`);
            }
        }
        finally {
            this.running = false;
        }
    }
    /** 서버 세션 목록에서 이 호스트의 것만 고른다 */
    async listOwnSessions() {
        const { sessions } = await api.sessions();
        return (sessions ?? []).filter((s) => {
            // hostname이 빈 세션은 귀속시킬 호스트가 없어 건너뛴다.
            if (!s?.id || !s.hostname)
                return false;
            return s.hostname === config.hostLabel && SAFE_SESSION_ID.test(s.id);
        });
    }
    /**
     * 세션 하나의 transcript(부모 + subagents)를 증분으로 읽어 상태 목록을 돌려준다.
     * 파일이 사라지면 그 파일 상태를 버린다. 보고값은 단조 병합이라 줄어들지 않는다 (D10).
     */
    async collectSession(sessionId, stats) {
        const dir = await this.resolveSessionDir(sessionId);
        if (!dir)
            return [];
        const targets = [path.join(dir, `${sessionId}.jsonl`)];
        for (const sub of await this.listSubagentFiles(dir, sessionId))
            targets.push(sub);
        const states = [];
        for (const filePath of targets) {
            const tracked = await this.readIncremental(filePath);
            if (!tracked)
                continue;
            states.push(tracked.state);
            addUsageStats(stats, tracked.state.stats);
        }
        return states;
    }
    /**
     * 세션 파일이 들어 있는 프로젝트 폴더를 찾는다.
     *
     * ⚠️ cwd 인코딩 규칙을 역산하지 않는다(문서화된 규칙이 아니다). 폴더 **이름만** 나열해
     *    `<sessionId>.jsonl`의 존재를 확인하며, 다른 대화 파일은 열지 않는다.
     */
    async resolveSessionDir(sessionId) {
        const cached = this.sessionDirs.get(sessionId);
        if (cached) {
            try {
                await fs.access(path.join(cached, `${sessionId}.jsonl`));
                return cached;
            }
            catch {
                // 파일이 사라졌다 (자동 정리). 다시 찾아본다.
                this.sessionDirs.delete(sessionId);
            }
        }
        let dirents;
        try {
            dirents = await fs.readdir(this.projectsDir, { withFileTypes: true });
        }
        catch {
            if (!this.warnedNoProjects) {
                this.warnedNoProjects = true;
                warn(`transcript 폴더를 읽을 수 없습니다: ${this.projectsDir}`);
            }
            return null;
        }
        for (const dirent of dirents) {
            if (!dirent.isDirectory())
                continue;
            const dir = path.join(this.projectsDir, dirent.name);
            try {
                await fs.access(path.join(dir, `${sessionId}.jsonl`));
            }
            catch {
                continue;
            }
            this.sessionDirs.set(sessionId, dir);
            return dir;
        }
        return null;
    }
    /** `<프로젝트>/<sessionId>/subagents/*.jsonl` — 해당 세션 폴더 안만 본다 */
    async listSubagentFiles(dir, sessionId) {
        const subDir = path.join(dir, sessionId, 'subagents');
        try {
            const names = await fs.readdir(subDir);
            return names.filter((n) => n.endsWith('.jsonl')).map((n) => path.join(subDir, n));
        }
        catch {
            // subagents 폴더가 없는 세션이 더 많다. 오류가 아니다.
            return [];
        }
    }
    /**
     * 파일의 새 내용만 읽어 상태에 반영한다.
     *
     * · 완결되지 않은(개행으로 끝나지 않는) 마지막 줄은 **소비하지 않고** 오프셋을 그 앞에
     *   둔다. Claude Code가 쓰는 도중에 읽으면 반쪽 줄이 오기 때문이다 (D8).
     * · 파일이 줄어들었으면(교체·잘림) 상태를 버리고 처음부터 다시 읽는다.
     */
    async readIncremental(filePath) {
        let handle;
        try {
            handle = await fs.open(filePath, 'r');
        }
        catch {
            // 사라졌거나 잠겨 있다. 다음 주기에 다시 본다.
            this.files.delete(filePath);
            return null;
        }
        let tracked = this.files.get(filePath);
        if (!tracked) {
            tracked = { offset: 0, state: createUsageFileState() };
            this.files.set(filePath, tracked);
        }
        try {
            const stat = await handle.stat();
            if (stat.size < tracked.offset) {
                tracked.offset = 0;
                tracked.state = createUsageFileState();
            }
            if (stat.size === tracked.offset)
                return tracked;
            const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
            let pending = Buffer.alloc(0);
            while (tracked.offset + pending.length < stat.size) {
                const position = tracked.offset + pending.length;
                const { bytesRead } = await handle.read(chunk, 0, READ_CHUNK_BYTES, position);
                if (bytesRead <= 0)
                    break;
                // chunk는 다음 반복에서 덮어쓰므로 반드시 복사본을 들고 있어야 한다.
                const buf = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
                const lastNewline = buf.lastIndexOf(0x0a);
                if (lastNewline < 0) {
                    if (buf.length > MAX_PENDING_BYTES) {
                        // 한 줄이 상한을 넘었다. 이 구간을 포기하고 앞으로 건너뛴다.
                        warn(`transcript 한 줄이 너무 깁니다. 건너뜁니다: ${path.basename(filePath)}`);
                        tracked.offset += buf.length;
                        tracked.state.stats.parseFailed += 1;
                        pending = Buffer.alloc(0);
                        continue;
                    }
                    pending = buf;
                    continue;
                }
                const consumable = buf.subarray(0, lastNewline + 1);
                applyRawTranscriptLines(tracked.state, consumable.toString('utf-8').split('\n'));
                tracked.offset += consumable.length;
                pending = Buffer.from(buf.subarray(lastNewline + 1));
            }
            // pending(완결되지 않은 꼬리)은 버린다. 오프셋이 그 앞에 있으므로 다음 주기에 다시 읽는다.
            return tracked;
        }
        catch (err) {
            warn(`transcript를 읽지 못했습니다 (${path.basename(filePath)}): ` +
                `${err instanceof Error ? err.message : String(err)}`);
            return tracked;
        }
        finally {
            await handle.close().catch(() => {
                /* 닫기 실패는 무시한다 */
            });
        }
    }
    /**
     * 서버에 보고한다.
     *
     * · 직전 보고와 값이 같으면 **보내지 않는다.**
     * · 직전 보고와 필드별 max를 취해 **줄어든 값을 보고하지 않는다** (D10).
     * · 5,000개를 넘으면 나눠 보낸다. 전부 성공해야 lastReported를 갱신한다.
     */
    async report(entries) {
        const merged = mergeMonotonic(this.lastReported, entries);
        if (!merged.length)
            return;
        if (sameUsageEntries(this.lastReported, merged))
            return;
        const collectedAt = new Date().toISOString();
        const chunks = chunkUsageEntries(merged, MAX_ENTRIES_PER_REPORT);
        let accepted = 0;
        let rejected = 0;
        for (const chunk of chunks) {
            const result = await api.reportUsage({
                hostname: config.hostLabel,
                collectedAt,
                entries: chunk,
            });
            accepted += result.accepted ?? 0;
            rejected += result.rejected ?? 0;
            if (result.persisted === false) {
                warn(`서버가 사용량을 파일에 저장하지 못했습니다: ${result.persistError ?? '이유 없음'}`);
            }
        }
        // 전송이 성공한 뒤에만 기준선을 갱신한다. 실패하면 다음 주기에 같은 값을 다시 보낸다.
        this.lastReported = merged;
        if (rejected > 0) {
            warn(`사용량 보고: ${accepted}건 반영 · ${rejected}건 거부됨 (상한 초과 등)`);
        }
        else {
            log(`사용량 보고: ${accepted}건 반영 (엔트리 ${merged.length}개)`);
        }
    }
}
