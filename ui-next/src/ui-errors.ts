import { t } from './i18n';
const FALLBACK = t('Something went wrong. Please try again.');

function statusOf(error: unknown): number | null {
    const status = (error as { status?: unknown } | null)?.status;
    return typeof status === 'number' && status > 0 ? status : null;
}

/**
 * User-facing copy for consumer views. HTTP failures map to an action the viewer
 * can take; the server's raw response text is kept for diagnostics only.
 * Client-authored errors (timeouts, offline, validation) keep their message.
 */
export function userMessage(error: unknown, fallback = FALLBACK): string {
    const status = statusOf(error);
    if (status !== null) {
        if (status === 401) return t('Your session expired. Sign in again.');
        if (status === 403) return t('Your account does not have permission to do that on this server.');
        if (status === 404) return t('That is no longer available on the server. Refresh and try again.');
        if (status === 408 || status === 504) return t('The server is taking longer than expected. Try again in a moment.');
        if (status === 409) return t('That conflicts with a change made elsewhere. Refresh and try again.');
        if (status === 429) return t('The server is busy. Wait a moment and try again.');
        if (status >= 500) return t('The server ran into a problem. Try again in a moment.');
        if (status >= 400) return t('The server could not complete that request.');
    }
    if (error instanceof Error && error.message) return error.message;
    return fallback;
}

export type SignInFailure = 'credentials' | 'other';

/** Classifies a password sign-in failure from its HTTP status only; message text is never inspected. */
export function signInFailure(error: unknown): SignInFailure {
    const status = statusOf(error);
    return status === 401 || status === 403 ? 'credentials' : 'other';
}

/** Login-form copy: a rejected name or password is not an expired session. */
export function signInMessage(error: unknown): string {
    return signInFailure(error) === 'credentials'
        ? 'Sign-in failed. Check your username and password.'
        : userMessage(error, 'Sign-in failed. Check your server address and try again.');
}

/** Raw detail for logs and support, never for primary UI copy. */
export function errorDiagnostic(error: unknown): string {
    const status = statusOf(error);
    const message = error instanceof Error ? error.message : String(error ?? '');
    return status !== null ? `HTTP ${status}: ${message}` : message;
}
