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

function readStore(): Store {
    try {
        const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Store;
        return parsed && typeof parsed === 'object' ? parsed : {};
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
    store[key] = users.map(user => user.userId === session.user.Id
        ? { userId: user.userId, name: user.name, lastSignedIn: user.lastSignedIn }
        : user);
    writeStore(store);
}
