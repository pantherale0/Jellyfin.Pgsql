const FALLBACK = 'Something went wrong. Please try again.';

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
        if (status === 401) return 'Your session expired. Sign in again.';
        if (status === 403) return 'Your account does not have permission to do that on this server.';
        if (status === 404) return 'That is no longer available on the server. Refresh and try again.';
        if (status === 408 || status === 504) return 'The server is taking longer than expected. Try again in a moment.';
        if (status === 409) return 'That conflicts with a change made elsewhere. Refresh and try again.';
        if (status === 429) return 'The server is busy. Wait a moment and try again.';
        if (status >= 500) return 'The server ran into a problem. Try again in a moment.';
        if (status >= 400) return 'The server could not complete that request.';
    }
    if (error instanceof Error && error.message) return error.message;
    return fallback;
}

/** Raw detail for logs and support, never for primary UI copy. */
export function errorDiagnostic(error: unknown): string {
    const status = statusOf(error);
    const message = error instanceof Error ? error.message : String(error ?? '');
    return status !== null ? `HTTP ${status}: ${message}` : message;
}
