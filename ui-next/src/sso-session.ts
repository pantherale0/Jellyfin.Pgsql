import type { JellyfinUser, Session } from './types';

export const SSO_HANDOFF_KEY = 'jellyfin-ui-next-sso-pending';
export const UI_NEXT_SIGNED_OUT_KEY = 'jellyfin-ui-next-signed-out';
export const SSO_HANDOFF_MAX_AGE_MS = 15 * 60 * 1000;

export interface SsoHandoffAttempt {
    server: string;
    startedAt: number;
    previousAccessToken: string | null;
}

export interface SsoHandoff {
    server: string;
    token: string;
    userId: string;
    serverId: string;
}

export interface SsoHandoffStorage {
    serverOrigin: string;
    credentials: string | null;
    apiKey: string | null;
    userId: string | null;
    serverId: string | null;
    attempt: string | null;
    now: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOrigin(value: unknown, expectedOrigin: string): boolean {
    if (typeof value !== 'string') return false;
    try {
        const parsed = new URL(value);
        return parsed.origin === expectedOrigin && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
    } catch (_error) {
        return false;
    }
}

export function parseSsoHandoff({ serverOrigin, credentials, apiKey, userId, serverId, attempt, now }: SsoHandoffStorage): SsoHandoff | null {
    if (!credentials || !apiKey || !userId || !serverId || !attempt) return null;

    let parsedAttempt: unknown;
    try {
        parsedAttempt = JSON.parse(attempt);
    } catch (_error) {
        return null;
    }
    if (!isRecord(parsedAttempt)) return null;
    const attemptServer = parsedAttempt.server;
    const startedAt = parsedAttempt.startedAt;
    const previousAccessToken = parsedAttempt.previousAccessToken;
    if (typeof attemptServer !== 'string' || typeof startedAt !== 'number' || !Number.isFinite(startedAt) || startedAt <= 0 || !Number.isFinite(now) || now < startedAt || now - startedAt > SSO_HANDOFF_MAX_AGE_MS) return null;
    if (previousAccessToken !== null && typeof previousAccessToken !== 'string') return null;
    if (previousAccessToken && previousAccessToken === apiKey) return null;

    let expectedOrigin: string;
    try {
        const parsedOrigin = new URL(serverOrigin);
        if (parsedOrigin.origin !== serverOrigin || parsedOrigin.pathname !== '/' || parsedOrigin.search || parsedOrigin.hash || parsedOrigin.username || parsedOrigin.password) return null;
        expectedOrigin = parsedOrigin.origin;
    } catch (_error) {
        return null;
    }
    if (!hasOrigin(attemptServer, expectedOrigin)) return null;
    let server: string;
    try {
        server = new URL(attemptServer).toString().replace(/\/$/, '');
    } catch (_error) {
        return null;
    }

    let parsedCredentials: unknown;
    try {
        parsedCredentials = JSON.parse(credentials);
    } catch (_error) {
        return null;
    }
    if (!isRecord(parsedCredentials) || !Array.isArray(parsedCredentials.Servers)) return null;

    for (const candidate of parsedCredentials.Servers) {
        if (!isRecord(candidate)) continue;
        if (!hasOrigin(candidate.ManualAddress, expectedOrigin) && !hasOrigin(candidate.LocalAddress, expectedOrigin)) continue;
        const token = candidate.AccessToken;
        const credentialUserId = candidate.UserId;
        const accessedAt = candidate.DateLastAccessed;
        if (token !== apiKey || credentialUserId !== userId) continue;
        if (typeof accessedAt !== 'number' || !Number.isFinite(accessedAt) || accessedAt < startedAt) continue;
        if (candidate.Id !== undefined && candidate.Id !== null && candidate.Id !== serverId) continue;
        return { server, token: apiKey, userId, serverId };
    }

    return null;
}

export function createSsoSession(handoff: SsoHandoff, response: unknown, serverInfo: unknown): Session | null {
    if (!isRecord(response)) return null;
    if (!isRecord(serverInfo) || serverInfo.Id !== handoff.serverId) return null;
    const id = response.Id;
    const name = response.Name;
    if (typeof id !== 'string' || id !== handoff.userId || typeof name !== 'string' || !name) return null;
    const user: JellyfinUser = { Id: id, Name: name };
    return { server: handoff.server, token: handoff.token, user, serverId: handoff.serverId };
}

export function canCommitSsoRestore({ requestActive, signedOut }: { requestActive: boolean; signedOut: boolean }): boolean {
    return requestActive && !signedOut;
}
