import { useEffect, useState } from 'preact/hooks';
import { t } from './i18n';

export type HaRole = 'single' | 'leader' | 'standby';

export interface HaHeaders { role: HaRole; epoch: number }

export interface HaStatsInfo {
    enabled: boolean;
    role: HaRole;
    epoch: number;
    instanceName: string;
    startedAt: string | null;
    leaderSince: string | null;
    heartbeatSeconds: number | null;
}

export interface FailoverEvent { at: number; from: string; to: string }

export interface HaSnapshot {
    /** Latest leadership headers seen on any Jellyfin response. */
    headers: HaHeaders | null;
    /** True once a response arrived without readable leadership headers and none were ever seen. */
    headersMissing: boolean;
    stats: HaStatsInfo | null;
    /** Newest first. */
    failovers: FailoverEvent[];
}

export const MAX_FAILOVER_EVENTS = 10;
/** Header and stats observations of the same failover arrive seconds apart; count them once. */
export const FAILOVER_MERGE_MS = 30_000;

const ROLES: readonly HaRole[] = [ 'single', 'leader', 'standby' ];

function asRole(value: unknown): HaRole | null {
    const role = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return (ROLES as readonly string[]).includes(role) ? role as HaRole : null;
}

function asEpoch(value: unknown): number | null {
    const epoch = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
    return Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : null;
}

/** Parses the raw `getAllResponseHeaders()` block; returns null unless both leadership headers are present and valid. */
export function parseHaHeaders(raw: string | null | undefined): HaHeaders | null {
    if (!raw) return null;
    let role: HaRole | null = null;
    let epoch: number | null = null;
    for (const line of raw.split(/\r?\n/)) {
        const colon = line.indexOf(':');
        if (colon <= 0) continue;
        const name = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1);
        if (name === 'x-jellyfin-ha-role') role = asRole(value);
        else if (name === 'x-jellyfin-leader-epoch') epoch = asEpoch(value);
    }
    return role && epoch !== null ? { role, epoch } : null;
}

export function haFromStats(stats: unknown): HaStatsInfo | null {
    if (!stats || typeof stats !== 'object') return null;
    const s = stats as Record<string, unknown>;
    const role = asRole(s.HaRole);
    if (!role) return null;
    const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
    const heartbeat = typeof s.HaHeartbeatSeconds === 'number' && Number.isFinite(s.HaHeartbeatSeconds) && s.HaHeartbeatSeconds > 0 ? s.HaHeartbeatSeconds : null;
    return {
        enabled: s.HaEnabled === true,
        role,
        epoch: asEpoch(s.LeaderEpoch) ?? 0,
        instanceName: text(s.InstanceName) || '',
        startedAt: text(s.StartedAtUtc),
        leaderSince: text(s.LeaderSinceUtc),
        heartbeatSeconds: heartbeat,
    };
}

export function describeHeaders(headers: HaHeaders): string {
    return headers.role === 'single' ? 'single instance' : `${headers.role} · epoch ${headers.epoch}`;
}

function describeStats(stats: HaStatsInfo): string {
    return `${stats.instanceName || 'unknown instance'} (${stats.role}, epoch ${stats.epoch})`;
}

/** Identity of the process answering; a different value means another node (or a restart) took over. */
function statsIdentity(stats: HaStatsInfo): string {
    return `${stats.instanceName}|${stats.startedAt || ''}|${stats.role}|${stats.epoch}`;
}

export function createHaTracker(now: () => number = Date.now) {
    let state: HaSnapshot = { headers: null, headersMissing: false, stats: null, failovers: [] };
    const listeners = new Set<() => void>();
    const emit = (next: HaSnapshot) => {
        state = next;
        listeners.forEach(listener => listener());
    };
    const withFailover = (failovers: FailoverEvent[], from: string, to: string): FailoverEvent[] => {
        const at = now();
        const latest = failovers[0];
        if (latest && at - latest.at < FAILOVER_MERGE_MS) return failovers;
        return [ { at, from, to }, ...failovers ].slice(0, MAX_FAILOVER_EVENTS);
    };

    return {
        snapshot: (): HaSnapshot => state,
        subscribe(listener: () => void): () => void {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        /** Feed every Jellyfin response's raw header block. */
        observeHeaders(raw: string | null | undefined): void {
            const headers = parseHaHeaders(raw);
            if (!headers) {
                if (!state.headers && !state.headersMissing) emit({ ...state, headersMissing: true });
                return;
            }
            const previous = state.headers;
            if (previous && previous.role === headers.role && previous.epoch === headers.epoch && !state.headersMissing) return;
            const changed = headers.role !== 'single' && (previous?.role !== headers.role || previous?.epoch !== headers.epoch);
            emit({
                ...state,
                headers,
                headersMissing: false,
                failovers: previous && changed ? withFailover(state.failovers, describeHeaders(previous), describeHeaders(headers)) : state.failovers,
            });
        },
        observeStats(stats: unknown): void {
            const info = haFromStats(stats);
            if (!info) return;
            const previous = state.stats;
            if (previous && statsIdentity(previous) === statsIdentity(info) && previous.leaderSince === info.leaderSince && previous.heartbeatSeconds === info.heartbeatSeconds) return;
            const changed = info.enabled && (!previous || statsIdentity(previous) !== statsIdentity(info));
            emit({
                ...state,
                stats: info,
                failovers: previous && changed ? withFailover(state.failovers, describeStats(previous), describeStats(info)) : state.failovers,
            });
        },
        reset(): void {
            if (!state.headers && !state.stats && !state.headersMissing && state.failovers.length === 0) return;
            emit({ headers: null, headersMissing: false, stats: null, failovers: [] });
        },
    };
}

export type HaTracker = ReturnType<typeof createHaTracker>;

export const haTracker = createHaTracker();

export function effectiveHaRole(snapshot: HaSnapshot): HaRole | null {
    return snapshot.headers?.role ?? snapshot.stats?.role ?? null;
}

export function haEnabled(snapshot: HaSnapshot): boolean {
    const role = effectiveHaRole(snapshot);
    return snapshot.stats?.enabled === true || role === 'leader' || role === 'standby';
}

/** Short top-bar label; null for single-instance servers. */
export function haChip(snapshot: HaSnapshot): { label: string; tone: 'ok' | 'critical' } | null {
    if (!haEnabled(snapshot)) return null;
    const role = effectiveHaRole(snapshot);
    if (role === 'standby') return { label: t('Standby instance'), tone: 'critical' };
    if (role !== 'leader') return null;
    const epoch = snapshot.headers?.epoch ?? snapshot.stats?.epoch;
    return { label: epoch === undefined ? t('HA leader') : t('HA leader · epoch {0}', epoch), tone: 'ok' };
}

export const FAILOVER_RECENT_MS = 10 * 60_000;

export type HaReadiness = 'ready' | 'not-ready' | 'unknown';

export function haHealthIssues(snapshot: HaSnapshot, readiness: HaReadiness | null, now = Date.now()): Array<{ severity: 'critical' | 'degraded'; message: string }> {
    if (!haEnabled(snapshot)) return [];
    const issues: Array<{ severity: 'critical' | 'degraded'; message: string }> = [];
    if (effectiveHaRole(snapshot) === 'standby') issues.push({ severity: 'critical', message: t('This instance is an HA standby; route clients to the leader') });
    if (readiness === 'not-ready') issues.push({ severity: 'critical', message: t('Readiness probe (/health/ready) reports not ready') });
    const latest = snapshot.failovers[0];
    if (latest && now - latest.at < FAILOVER_RECENT_MS) issues.push({ severity: 'degraded', message: t('HA failover observed: {0} → {1}', latest.from, latest.to) });
    return issues;
}

export function useHaSnapshot(tracker: HaTracker = haTracker): HaSnapshot {
    const [snapshot, setSnapshot] = useState(tracker.snapshot);
    useEffect(() => {
        setSnapshot(tracker.snapshot());
        return tracker.subscribe(() => setSnapshot(tracker.snapshot()));
    }, [tracker]);
    return snapshot;
}
