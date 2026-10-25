import { UI_NEXT_SIGNED_OUT_KEY } from './sso-session';

export class AuthAttemptTracker {
    private current = 0;

    begin(): number {
        this.current += 1;
        return this.current;
    }

    invalidate(): void {
        this.current += 1;
    }

    isCurrent(id: number): boolean {
        return id === this.current;
    }
}

export function clearLoginMarkers(): void {
    try { localStorage.removeItem(UI_NEXT_SIGNED_OUT_KEY); } catch (_error) { /* Clearing the sign-out marker is best effort. */ }
    try {
        if (new URL(window.location.href).searchParams.get('server') !== null) {
            window.history.replaceState(null, '', window.location.pathname + window.location.hash);
        }
    } catch (_error) { /* The transient server query is best effort. */ }
}
