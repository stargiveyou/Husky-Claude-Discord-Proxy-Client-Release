/**
 * JSON 객체 키로 쓰면 안 되는 이름. 서버(src/backend/server.ts의 isSafePolicyKey)가
 * 같은 값을 거부하며, 하나라도 섞이면 **보고 전체가 400**이 된다. 여기서 먼저 걷어낸다.
 */
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** 서버 스키마 상한 (API_SPECIFICATION.md 2.7) */
const MAX_SESSION_ID_LENGTH = 255;
const MAX_MODEL_LENGTH = 128;
const MAX_CWD_LENGTH = 4096;
const DAY_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** 버킷 키 구분자. 모델 이름·날짜에 등장할 수 없는 문자를 쓴다 */
const BUCKET_SEPARATOR = '\u0000';
export function createUsageFileState() {
    return {
        byRequestId: new Map(),
        stats: createUsageStats(),
    };
}
export function createUsageStats() {
    return {
        totalLines: 0,
        parseFailed: 0,
        noUsage: 0,
        noTimestamp: 0,
        noRequestKey: 0,
        superseded: 0,
        applied: 0,
    };
}
/** 통계를 한쪽에 더한다 (파일별 상태를 합쳐 로그로 남길 때) */
export function addUsageStats(target, other) {
    target.totalLines += other.totalLines;
    target.parseFailed += other.parseFailed;
    target.noUsage += other.noUsage;
    target.noTimestamp += other.noTimestamp;
    target.noRequestKey += other.noRequestKey;
    target.superseded += other.superseded;
    target.applied += other.applied;
}
function asRecord(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return null;
    return value;
}
/** 음이 아닌 정수로 정규화한다. 숫자가 아니거나 0 이하면 0 */
function toCount(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
        return 0;
    return Math.floor(value);
}
/** timestamp → UTC 'YYYY-MM-DD'. 파싱 불가면 null (D4) */
function toDayUtc(value) {
    if (typeof value !== 'string' || !value.trim())
        return null;
    const ms = Date.parse(value);
    if (!Number.isFinite(ms))
        return null;
    return new Date(ms).toISOString().slice(0, 10);
}
function toText(value) {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}
/**
 * JSON 한 줄을 파싱한다. 실패하면 null — **예외를 던지지 않는다** (D7).
 * JSON.parse는 언어 내장이라 Node API 의존이 아니다.
 */
export function parseTranscriptLine(raw) {
    const trimmed = raw.trim();
    if (!trimmed)
        return null;
    try {
        return JSON.parse(trimmed);
    }
    catch {
        return null;
    }
}
/**
 * dedup 키. requestId가 정본이고, 실측에서 usage는 있는데 requestId가 없는 줄이 7건
 * 있었으므로(전부 synthetic·토큰 0) message.id → uuid 순으로 물러선다.
 * 셋 다 없으면 군을 만들 수 없어 그 줄을 버린다.
 */
function resolveRequestKey(line, message) {
    return toText(line.requestId) ?? toText(message.id) ?? toText(line.uuid);
}
/**
 * 파싱된 줄 하나를 상태에 반영한다.
 *
 * @returns 집계에 반영됐으면 true. 버려졌으면 false (이유는 state.stats에 누적된다)
 */
export function applyTranscriptLine(state, line) {
    state.stats.totalLines += 1;
    const row = asRecord(line);
    if (!row) {
        state.stats.noUsage += 1;
        return false;
    }
    const message = asRecord(row.message);
    const usage = message ? asRecord(message.usage) : null;
    if (!message || !usage) {
        state.stats.noUsage += 1;
        return false;
    }
    const dayUtc = toDayUtc(row.timestamp);
    if (!dayUtc) {
        state.stats.noTimestamp += 1;
        return false;
    }
    const key = resolveRequestKey(row, message);
    if (!key) {
        state.stats.noRequestKey += 1;
        return false;
    }
    // D2 — apiBlockIndex가 없는 줄은 0으로 본다. 결측이 최댓값을 밀어내면 안 된다.
    const apiBlockIndex = typeof row.apiBlockIndex === 'number' && Number.isFinite(row.apiBlockIndex)
        ? Math.floor(row.apiBlockIndex)
        : 0;
    const previous = state.byRequestId.get(key);
    // D1 — 같은 requestId는 apiBlockIndex가 **더 클 때만** 덮어쓴다.
    //      ⚠️ stop_reason은 보지 않는다 (종결 표지가 아니다).
    if (previous && apiBlockIndex <= previous.apiBlockIndex) {
        state.stats.superseded += 1;
        return false;
    }
    // D3 — message.model → 최상위 model → 'unknown'
    const model = toText(message.model) ?? toText(row.model) ?? 'unknown';
    state.byRequestId.set(key, {
        apiBlockIndex,
        dayUtc,
        model,
        input: toCount(usage.input_tokens),
        output: toCount(usage.output_tokens),
        cacheCreation: toCount(usage.cache_creation_input_tokens),
        cacheRead: toCount(usage.cache_read_input_tokens),
    });
    state.stats.applied += 1;
    return true;
}
/** 원문 한 줄(JSON 문자열)을 파싱해 반영한다. 파싱 실패는 건수만 센다 (D7) */
export function applyRawTranscriptLine(state, raw) {
    const parsed = parseTranscriptLine(raw);
    if (parsed === null) {
        state.stats.totalLines += 1;
        state.stats.parseFailed += 1;
        return false;
    }
    return applyTranscriptLine(state, parsed);
}
/** 원문 여러 줄. 빈 줄은 무시한다 (개행 분리의 부산물이라 실패로 세지 않는다) */
export function applyRawTranscriptLines(state, raws) {
    for (const raw of raws) {
        if (!raw.trim())
            continue;
        applyRawTranscriptLine(state, raw);
    }
}
function isSafeKey(value) {
    return !RESERVED_KEYS.has(value);
}
/**
 * 보고 본문에서 JSON 객체 키가 되는 값(hostname·sessionId·model·dayUtc)으로 쓸 수 있는지.
 * 서버가 같은 값을 거부하며 하나라도 섞이면 보고 전체가 400이 된다.
 */
export function isSafeReportKey(value) {
    return isSafeKey(value);
}
/**
 * 세션별 상태 묶음을 서버 보고용 엔트리로 만든다.
 *
 * 집계 키는 **(sessionId, dayUtc, model)** 이다 (D5). 부모와 subagent는 requestId 교집합이
 * 0이므로(실측 M2) 단순 합산한다.
 *
 * 서버 스키마에 걸릴 버킷은 여기서 **미리 제외**한다. 엔트리 하나가 zod에 걸리면 보고
 * 전체가 400이 되어 수집이 통째로 멈추기 때문이다.
 */
export function buildUsageEntries(sessions) {
    const entries = [];
    let dropped = 0;
    for (const session of sessions) {
        const sessionId = session.sessionId;
        // 예약 키·길이 위반 세션은 통째로 제외한다.
        if (!sessionId || sessionId.length > MAX_SESSION_ID_LENGTH || !isSafeKey(sessionId)) {
            dropped += 1;
            continue;
        }
        // 프로토타입 오염을 피하려고 일반 객체 대신 Map을 쓴다.
        const buckets = new Map();
        for (const state of session.states) {
            for (const record of state.byRequestId.values()) {
                const bucketKey = `${record.dayUtc}${BUCKET_SEPARATOR}${record.model}`;
                let bucket = buckets.get(bucketKey);
                if (!bucket) {
                    bucket = {
                        dayUtc: record.dayUtc,
                        model: record.model,
                        input: 0,
                        output: 0,
                        cacheCreation: 0,
                        cacheRead: 0,
                    };
                    buckets.set(bucketKey, bucket);
                }
                bucket.input += record.input;
                bucket.output += record.output;
                bucket.cacheCreation += record.cacheCreation;
                bucket.cacheRead += record.cacheRead;
            }
        }
        for (const bucket of buckets.values()) {
            if (!DAY_UTC_PATTERN.test(bucket.dayUtc) || !isSafeKey(bucket.dayUtc)) {
                dropped += 1;
                continue;
            }
            if (!bucket.model || bucket.model.length > MAX_MODEL_LENGTH || !isSafeKey(bucket.model)) {
                dropped += 1;
                continue;
            }
            // 전부 0인 버킷은 보내지 않는다. 서버가 필드별 max로 병합하므로 효과가 없고
            // 5,000개 상한만 축낸다 (실측의 토큰 0짜리 synthetic 줄이 여기에 해당한다).
            if (!bucket.input && !bucket.output && !bucket.cacheCreation && !bucket.cacheRead) {
                continue;
            }
            const entry = {
                sessionId,
                dayUtc: bucket.dayUtc,
                model: bucket.model,
                input: bucket.input,
                output: bucket.output,
                cacheCreation: bucket.cacheCreation,
                cacheRead: bucket.cacheRead,
            };
            // cwd는 선택 필드다. 상한을 넘으면 엔트리를 버리지 않고 cwd만 뺀다.
            if (session.cwd && session.cwd.length <= MAX_CWD_LENGTH)
                entry.cwd = session.cwd;
            entries.push(entry);
        }
    }
    // 비교(직전 보고와 동일한지)와 로그 가독성을 위해 순서를 고정한다.
    entries.sort((a, b) => a.sessionId.localeCompare(b.sessionId) ||
        a.dayUtc.localeCompare(b.dayUtc) ||
        a.model.localeCompare(b.model));
    return { entries, dropped };
}
/**
 * 한 세션의 줄 배열을 통째로 집계한다 — 자체 검증(7절)과 단발 계산용 편의 함수.
 * 입력은 JSON 문자열 줄이든 이미 파싱된 줄 객체든 받는다.
 */
export function aggregateUsageLines(lines, context) {
    const state = createUsageFileState();
    for (const line of lines) {
        if (typeof line === 'string') {
            if (!line.trim())
                continue;
            applyRawTranscriptLine(state, line);
        }
        else {
            applyTranscriptLine(state, line);
        }
    }
    const result = buildUsageEntries([
        { sessionId: context.sessionId, cwd: context.cwd, states: [state] },
    ]);
    return { ...result, stats: state.stats };
}
/** 엔트리 배열을 서버 상한(5,000)에 맞춰 나눈다 */
export function chunkUsageEntries(entries, maxPerChunk) {
    const size = Math.max(1, Math.floor(maxPerChunk));
    if (entries.length <= size)
        return entries.length ? [entries] : [];
    const chunks = [];
    for (let i = 0; i < entries.length; i += size)
        chunks.push(entries.slice(i, i + size));
    return chunks;
}
/** 두 엔트리 배열이 같은 내용인지 (직전 보고와 값이 같으면 보내지 않기 위함) */
export function sameUsageEntries(a, b) {
    if (a.length !== b.length)
        return false;
    for (let i = 0; i < a.length; i += 1) {
        const x = a[i];
        const y = b[i];
        if (x.sessionId !== y.sessionId ||
            x.dayUtc !== y.dayUtc ||
            x.model !== y.model ||
            x.cwd !== y.cwd ||
            x.input !== y.input ||
            x.output !== y.output ||
            x.cacheCreation !== y.cacheCreation ||
            x.cacheRead !== y.cacheRead) {
            return false;
        }
    }
    return true;
}
/**
 * 절대 총계가 **줄어들지 않게** 병합한다 (D10).
 * transcript가 자동 정리로 사라져도 보고값이 되돌아가면 안 되므로, 직전 보고 스냅샷과
 * 필드별 max를 취한다. 서버도 같은 규칙으로 병합한다(API 2.7).
 */
export function mergeMonotonic(previous, current) {
    const keyOf = (e) => `${e.sessionId}${BUCKET_SEPARATOR}${e.dayUtc}${BUCKET_SEPARATOR}${e.model}`;
    const merged = new Map();
    for (const entry of previous)
        merged.set(keyOf(entry), { ...entry });
    for (const entry of current) {
        const key = keyOf(entry);
        const old = merged.get(key);
        if (!old) {
            merged.set(key, { ...entry });
            continue;
        }
        merged.set(key, {
            ...old,
            // cwd는 최신 세션 목록의 값을 따른다.
            cwd: entry.cwd ?? old.cwd,
            input: Math.max(old.input, entry.input),
            output: Math.max(old.output, entry.output),
            cacheCreation: Math.max(old.cacheCreation, entry.cacheCreation),
            cacheRead: Math.max(old.cacheRead, entry.cacheRead),
        });
    }
    const result = [...merged.values()];
    result.sort((a, b) => a.sessionId.localeCompare(b.sessionId) ||
        a.dayUtc.localeCompare(b.dayUtc) ||
        a.model.localeCompare(b.model));
    return result;
}
