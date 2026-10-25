import { normalizeUserId } from './sso-session';
import type { Session } from './types';

const STORAGE_KEY = 'jellyfin-ui-next-remembered-users';
const MAX_USERS_PER_SERVER = 8;
const MAX_SERVERS = 16;
const MAX_TEXT = 512;

export interface RememberedUser {
    userId: string;
    name: string;
    session?: Session;
    lastSignedIn: number;
}

type Store = Record<string, RememberedUser[]>;

function serverKey(session: Session): string {
    return session.serverId || session.server;
}

function isSession(value: unknown): value is Session {
    if (typeof value !== 'object' || value === null) return false;
    const session = value as Record<string, unknown>;
    const user = session.user as Record<string, unknown> | undefined;
    return typeof session.server === 'string' && typeof session.token === 'string'
        && typeof user?.Id === 'string' && typeof user?.Name === 'string';
}

function isRememberedUser(value: unknown): value is RememberedUser {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const user = value as Record<string, unknown>;
    if (typeof user.userId !== 'string' || !user.userId || user.userId.length > MAX_TEXT) return false;
    if (typeof user.name !== 'string' || !user.name || user.name.length > MAX_TEXT) return false;
    if (typeof user.lastSignedIn !== 'number' || !Number.isFinite(user.lastSignedIn)) return false;
    if (user.session !== undefined && !isSession(user.session)) return false;
    // A saved token must belong to the profile it is listed under.
    if (user.session !== undefined && normalizeUserId((user.session as Session).user.Id) !== normalizeUserId(user.userId)) return false;
    return true;
}

/** Keeps valid entries only: one per user (most recent wins), newest first, capped per server. */
function validUsers(value: unknown): RememberedUser[] {
    if (!Array.isArray(value)) return [];
    const byId = new Map<string, RememberedUser>();
    value.filter(isRememberedUser).forEach(user => {
        const existing = byId.get(user.userId);
        if (!existing || existing.lastSignedIn < user.lastSignedIn) byId.set(user.userId, user);
    });
    return Array.from(byId.values()).sort((a, b) => b.lastSignedIn - a.lastSignedIn).slice(0, MAX_USERS_PER_SERVER);
}

function readStore(): Store {
    try {
        const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const store: Store = {};
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (!key || key.length > MAX_TEXT || Object.keys(store).length >= MAX_SERVERS) continue;
            const users = validUsers(value);
            if (users.length) store[key] = users;
        }
        return store;
    } catch (_error) {
        return {};
    }
}

function writeStore(store: Store): void {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch (_error) { /* Remembered user switching is unavailable when storage is blocked. */ }
}

export function getRememberedUsers(session: Session): RememberedUser[] {
    return (readStore()[serverKey(session)] || []).slice().sort((a, b) => b.lastSignedIn - a.lastSignedIn);
}

export function rememberUser(session: Session): void {
    const store = readStore();
    const key = serverKey(session);
    const users = store[key] || [];
    store[key] = [
        { userId: session.user.Id, name: session.user.Name, session, lastSignedIn: Date.now() },
        ...users.filter(user => user.userId !== session.user.Id)
    ].slice(0, MAX_USERS_PER_SERVER);
    writeStore(store);
}

export function clearRememberedToken(session: Session): void {
    const store = readStore();
    const key = serverKey(session);
    const users = store[key] || [];
    store[key] = users.map(user => user.userId === session.user.Id && user.session?.token === session.token
        ? { userId: user.userId, name: user.name, lastSignedIn: user.lastSignedIn }
        : user);
    writeStore(store);
}
