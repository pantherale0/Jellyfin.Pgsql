import type { JellyfinUser, Session } from './types';

export const SSO_HANDOFF_KEY = 'jellyfin-ui-next-sso-pending';
export const UI_NEXT_SIGNED_OUT_KEY = 'jellyfin-ui-next-signed-out';
/** Matches the server's OIDC state lifetime in `jellyfin_sso.patch`. */
export const SSO_HANDOFF_MAX_AGE_MS = 10 * 60 * 1000;

export interface SsoHandoffAttempt {
    server: string;
    startedAt: number;
    previousAccessToken: string | null;
    /** Present when the server returns a one-time code to this UI instead of writing classic credentials. */
    verifier?: string;
    returnUrl?: string;
}

const CODE_FRAGMENT = /^#sso_code=([A-Za-z0-9_-]{20,64})$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

/** Reads `#sso_code=...` written by the SSO callback; anything else in the fragment is ignored. */
export function parseSsoCodeFragment(hash: string): string | null {
    return CODE_FRAGMENT.exec(hash)?.[1] ?? null;
}

/** The UI address the server sends the code back to: origin and path only. */
export function ssoReturnUrl(href: string): string | null {
    try {
        const url = new URL(href);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
        return `${url.origin}${url.pathname}`;
    } catch (_error) {
        return null;
    }
}

function base64Url(bytes: Uint8Array): string {
    let binary = '';
    bytes.forEach(byte => { binary += String.fromCharCode(byte); });
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A random verifier and its base64url SHA-256 challenge, or null when Web Crypto is unavailable (insecure context). */
export async function createSsoChallenge(): Promise<{ verifier: string; challenge: string } | null> {
    const webCrypto = globalThis.crypto;
    if (!webCrypto?.getRandomValues || !webCrypto.subtle) return null;
    const verifier = base64Url(webCrypto.getRandomValues(new Uint8Array(32)));
    const digest = await webCrypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

/** A fresh code-exchange attempt, or null when the marker is stale, malformed or for the legacy handoff. */
export function parseSsoCodeAttempt(attempt: string | null, now: number): (SsoHandoffAttempt & { verifier: string }) | null {
    if (!attempt) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(attempt);
    } catch (_error) {
        return null;
    }
    if (!isRecord(parsed)) return null;
    const { server, startedAt, verifier, returnUrl } = parsed;
    if (typeof server !== 'string' || typeof verifier !== 'string' || !VERIFIER.test(verifier)) return null;
    if (typeof startedAt !== 'number' || !Number.isFinite(startedAt) || startedAt <= 0 || !Number.isFinite(now) || now < startedAt || now - startedAt > SSO_HANDOFF_MAX_AGE_MS) return null;
    try {
        const url = new URL(server);
        if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.search || url.hash) return null;
    } catch (_error) {
        return null;
    }
    return { server: server.replace(/\/$/, ''), startedAt, previousAccessToken: null, verifier, returnUrl: typeof returnUrl === 'string' ? returnUrl : undefined };
}

/** Validates the `/sso/exchange` response (camelCase or PascalCase). */
export function ssoHandoffFromExchange(server: string, response: unknown): SsoHandoff | null {
    if (!isRecord(response)) return null;
    const pick = (camel: string, pascal: string) => {
        const value = response[camel] ?? response[pascal];
        return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : null;
    };
    const token = pick('accessToken', 'AccessToken');
    const userId = pick('userId', 'UserId');
    const serverId = pick('serverId', 'ServerId');
    return token && userId && serverId ? { server, token, userId, serverId } : null;
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

export function normalizeUserId(id: string): string {
    return /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(id)
        ? id.replace(/-/g, '').toLowerCase()
        : id;
}

export function createSsoSession(handoff: SsoHandoff, response: unknown, serverInfo: unknown): Session | null {
    if (!isRecord(response)) return null;
    if (!isRecord(serverInfo) || serverInfo.Id !== handoff.serverId) return null;
    const id = response.Id;
    const name = response.Name;
    if (typeof id !== 'string' || normalizeUserId(id) !== normalizeUserId(handoff.userId) || typeof name !== 'string' || !name) return null;
    const user: JellyfinUser = { Id: id, Name: name };
    if (isRecord(response.Policy)) {
        const policy: NonNullable<JellyfinUser['Policy']> = {};
        if (typeof response.Policy.IsAdministrator === 'boolean') policy.IsAdministrator = response.Policy.IsAdministrator;
        if (typeof response.Policy.IsDisabled === 'boolean') policy.IsDisabled = response.Policy.IsDisabled;
        if (typeof response.Policy.EnableCollectionManagement === 'boolean') policy.EnableCollectionManagement = response.Policy.EnableCollectionManagement;
        if (typeof response.Policy.EnableContentDeletion === 'boolean') policy.EnableContentDeletion = response.Policy.EnableContentDeletion;
        if (typeof response.Policy.EnableContentDownloading === 'boolean') policy.EnableContentDownloading = response.Policy.EnableContentDownloading;
        if (Object.keys(policy).length) user.Policy = policy;
    }
    if (isRecord(response.Configuration) && typeof response.Configuration.EnableNextEpisodeAutoPlay === 'boolean') {
        user.Configuration = { EnableNextEpisodeAutoPlay: response.Configuration.EnableNextEpisodeAutoPlay };
    }
    return { server: handoff.server, token: handoff.token, user, serverId: handoff.serverId };
}

export function canCommitSsoRestore({ requestActive, signedOut }: { requestActive: boolean; signedOut: boolean }): boolean {
    return requestActive && !signedOut;
}
