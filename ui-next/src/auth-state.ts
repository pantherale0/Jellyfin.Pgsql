import type { Session } from './types';

export interface SessionPolicy {
    configuredServer: string;
    pageOrigin: string;
    allowInsecureHttp: boolean;
}

export function comparableServer(server: string): string | null {
    try {
        const url = new URL(server);
        url.pathname = url.pathname.replace(/\/(web|web\/index\.html)\/?$/i, '').replace(/\/$/, '');
        return url.origin + url.pathname;
    } catch (_error) {
        return null;
    }
}

/** Validates a stored session the same way for the active session, other tabs and remembered accounts. */
export function validStoredSession(candidate: unknown, policy: SessionPolicy): Session | null {
    if (typeof candidate !== 'object' || candidate === null) return null;
    const value = candidate as Partial<Session>;
    if (typeof value.token !== 'string' || !value.token || typeof value.user?.Id !== 'string' || typeof value.user.Name !== 'string') return null;
    if (policy.configuredServer && comparableServer(value.server || '') !== comparableServer(policy.configuredServer)) return null;
    let url: URL;
    try { url = new URL(value.server || ''); } catch (_error) { return null; }
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    const validProtocol = url.protocol === 'https:' || url.protocol === 'http:' && (policy.allowInsecureHttp || local || url.origin === policy.pageOrigin);
    if (!validProtocol || url.username || url.password || url.search || url.hash) return null;
    return value as Session;
}

/** A remembered session may only be reused against the server the current account is signed in to. */
export function usableRememberedSession(remembered: Session | undefined, current: Session | null, policy: SessionPolicy): Session | null {
    const valid = validStoredSession(remembered, policy);
    if (!valid) return null;
    if (current && comparableServer(valid.server) !== comparableServer(current.server)) return null;
    return valid;
}

export type SharedSessionChange = { action: 'none' } | { action: 'adopt'; session: Session } | { action: 'signout' };

/** Tabs share one signed-in session: a newer session in another tab replaces ours; its removal signs us out. */
export function sharedSessionChange(newValue: string | null, currentToken: string | null, policy: SessionPolicy): SharedSessionChange {
    if (newValue === null) return currentToken ? { action: 'signout' } : { action: 'none' };
    let parsed: unknown;
    try { parsed = JSON.parse(newValue); } catch (_error) { return { action: 'none' }; }
    const session = validStoredSession(parsed, policy);
    if (!session || session.token === currentToken) return { action: 'none' };
    return { action: 'adopt', session };
}

/** Removes the stored session only when it still belongs to the token being signed out. */
export function shouldRemoveStoredSession(storedValue: string | null, token: string | null): boolean {
    if (!storedValue) return false;
    if (!token) return true;
    try { return (JSON.parse(storedValue) as Partial<Session>).token === token; } catch (_error) { return true; }
}

export const QUICK_CONNECT_CODE_LIFETIME_MS = 10 * 60 * 1000;
export const QUICK_CONNECT_MAX_TRANSIENT_FAILURES = 3;

export type QuickConnectPollOutcome = 'expired' | 'retry' | 'stop';

export function quickConnectPollOutcome(status: number | undefined, failures: number, startedAt: number, now: number): QuickConnectPollOutcome {
    if (now - startedAt >= QUICK_CONNECT_CODE_LIFETIME_MS) return 'expired';
    if (status === 404) return 'expired';
    if (status === 401 || status === 403) return 'stop';
    return failures < QUICK_CONNECT_MAX_TRANSIENT_FAILURES ? 'retry' : 'stop';
}

/** Writes the active account into classic web's credential store so classic links open the same account. */
export function classicCredentialsWithSession(raw: string | null, session: Session, now: number): string | null {
    if (!session.serverId) return null;
    let store: { Servers?: Array<Record<string, unknown>> } = {};
    try {
        const parsed: unknown = raw ? JSON.parse(raw) : {};
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) store = parsed as typeof store;
    } catch (_error) { store = {}; }
    const servers = Array.isArray(store.Servers) ? store.Servers.filter(s => s && typeof s === 'object') : [];
    const existing = servers.find(s => s.Id === session.serverId) || {};
    const entry = {
        ...existing,
        Id: session.serverId,
        ManualAddress: session.server,
        AccessToken: session.token,
        UserId: session.user.Id,
        DateLastAccessed: now,
    };
    return JSON.stringify({ ...store, Servers: [entry, ...servers.filter(s => s.Id !== session.serverId)] });
}

export function canHandOffToClassic(session: Session, pageOrigin: string): boolean {
    try { return new URL(session.server).origin === pageOrigin && Boolean(session.serverId); } catch (_error) { return false; }
}

/** Applies only the fields this screen edited onto a freshly read configuration. */
export function mergeEditedFields<T extends Record<string, unknown>>(fresh: T | undefined, draft: T, edited: Iterable<keyof T>): T {
    const merged = { ...(fresh || {}) } as T;
    for (const key of edited) merged[key] = draft[key];
    return merged;
}

export function devProbeOrigins(backend: string, extra: string): Set<string> {
    const origins = new Set<string>();
    for (const value of [backend, ...extra.split(',')]) {
        try { if (value.trim()) origins.add(new URL(value.trim()).origin); } catch (_error) { /* Ignore malformed entries. */ }
    }
    return origins;
}

/** The development SSO probe only contacts configured backends and only answers loopback clients unless LAN access is enabled. */
export function devProbeAllowed(target: URL, allowedOrigins: Set<string>, remoteAddress: string | undefined, allowLan: boolean): boolean {
    if (!allowedOrigins.has(target.origin)) return false;
    if (allowLan) return true;
    const address = (remoteAddress || '').replace(/^::ffff:/, '');
    return address === '127.0.0.1' || address === '::1' || address === 'localhost';
}
