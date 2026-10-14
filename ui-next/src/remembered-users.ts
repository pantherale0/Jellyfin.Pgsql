import type { Session } from './types';

const STORAGE_KEY = 'jellyfin-ui-next-remembered-users';
const MAX_USERS_PER_SERVER = 8;

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
    if (typeof value !== 'object' || value === null) return false;
    const user = value as Record<string, unknown>;
    if (typeof user.userId !== 'string' || typeof user.name !== 'string') return false;
    if (typeof user.lastSignedIn !== 'number' || !Number.isFinite(user.lastSignedIn)) return false;
    if (user.session !== undefined && !isSession(user.session)) return false;
    return true;
}

function readStore(): Store {
    try {
        const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const store: Store = {};
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (!Array.isArray(value)) continue;
            const users = value.filter(isRememberedUser);
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
