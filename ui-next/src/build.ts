declare const __UI_NEXT_BUILD__: string | undefined;

export const buildRevision: string = typeof __UI_NEXT_BUILD__ !== 'undefined' && __UI_NEXT_BUILD__
    ? __UI_NEXT_BUILD__
    : 'dev';

/** Client version reported to Jellyfin, so session lists identify the served revision. */
export function clientVersion(revision = buildRevision): string {
    return revision && revision !== 'dev' && revision !== 'unknown' ? `0.1.0+${revision.slice(0, 12)}` : '0.1.0';
}

/** The revision the server is currently serving differs from the bundle running in this tab. */
export function isStaleBundle(served: unknown, running = buildRevision): boolean {
    const revision = (served as { revision?: unknown } | null)?.revision;
    if (typeof revision !== 'string' || !revision || revision === 'unknown') return false;
    if (!running || running === 'dev' || running === 'unknown') return false;
    return revision !== running;
}

/** Reads the build manifest emitted next to index.html. Failures (dev server, older images) report nothing. */
export async function fetchServedBuild(): Promise<unknown> {
    if (typeof fetch !== 'function') return null;
    try {
        const response = await fetch(new URL('build.json', document.baseURI).toString(), { cache: 'no-store' });
        return response.ok ? await response.json() : null;
    } catch (_error) {
        return null;
    }
}
