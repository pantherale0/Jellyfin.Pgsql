import type { JellyfinSession, JellyfinUserInfo, LibraryInfo } from './types';

export function adminRouteHash(section: string): string {
    return `#admin/${encodeURIComponent(section)}`;
}

export function parseAdminRoute(hash: string): string | null {
    const match = hash.match(/^#admin\/(.+)$/);
    if (!match) return null;
    try { return decodeURIComponent(match[1]); } catch { return null; }
}

export function pluginSection(pluginId: string): string {
    return `plugin-${pluginId}`;
}

export function hasConfigurationPage(pages: Array<{ PluginId?: string }>, pluginId?: string): boolean {
    return Boolean(pluginId) && pages.some(page => page.PluginId === pluginId);
}

type UnsavedGuard = () => boolean;
let unsavedGuard: UnsavedGuard | null = null;

/** Registers the active unsaved-changes check; returns an unregister callback scoped to this guard. */
export function registerUnsavedGuard(guard: UnsavedGuard): () => void {
    unsavedGuard = guard;
    return () => { if (unsavedGuard === guard) unsavedGuard = null; };
}

export function hasUnsavedChanges(): boolean {
    return unsavedGuard?.() === true;
}

export function confirmLeave(confirm: (message: string) => boolean): boolean {
    if (!hasUnsavedChanges()) return true;
    if (!confirm('You have unsaved changes. Discard them and leave this page?')) return false;
    unsavedGuard = null;
    return true;
}

export function canSavePluginDraft(loadedId: string | null | undefined, pluginId: string): boolean {
    return Boolean(loadedId) && loadedId === pluginId;
}

export function canDeleteAdminUser(target: JellyfinUserInfo, actorId: string, users: JellyfinUserInfo[]): boolean {
    if (target.Id === actorId) return false;
    const isAdministrator = target.Policy?.IsAdministrator === true || target.IsAdministrator === true;
    if (!isAdministrator) return true;
    return users.some(user => user.Id !== target.Id
        && (user.Policy?.IsAdministrator === true || user.IsAdministrator === true)
        && user.Policy?.IsDisabled !== true && user.IsDisabled !== true);
}

export type ResourceState<T> = { ok: true; value: T } | { ok: false; error: string };

export async function settle<T>(promise: Promise<T>, fallbackError: string): Promise<ResourceState<T>> {
    try { return { ok: true, value: await promise }; }
    catch (error) { return { ok: false, error: error instanceof Error && error.message ? error.message : fallbackError }; }
}

export function resourceErrors(entries: Record<string, ResourceState<unknown>>): string[] {
    return Object.entries(entries).filter(([, state]) => !state.ok).map(([name, state]) => `${name}: ${(state as { error: string }).error}`);
}

export const ACTIVITY_SEVERITIES = ['All', 'Critical', 'Error', 'Warning'] as const;

export function isErrorSeverity(severity?: string): boolean {
    return severity === 'Error' || severity === 'Critical';
}

export function activitySeverityParam(filter: string): string | undefined {
    return filter === 'Critical' || filter === 'Error' || filter === 'Warning' ? filter : undefined;
}

export interface LogTailState {
    lines: string[];
    length: number;
}

export const LOG_LINE_LIMIT = 2000;

/** Appends only the new part of a growing log file; a shorter file means it rotated, so it restarts. */
export function appendLogText(previous: LogTailState, text: string, limit = LOG_LINE_LIMIT): LogTailState {
    if (text.length < previous.length || previous.length === 0) {
        return { lines: splitLog(text).slice(-limit), length: text.length };
    }
    if (text.length === previous.length) return previous;
    const added = text.slice(previous.length);
    const lines = previous.lines.slice();
    const pieces = added.split('\n');
    const last = lines.length ? lines[lines.length - 1] : undefined;
    if (last !== undefined && !text.slice(0, previous.length).endsWith('\n')) {
        lines[lines.length - 1] = last + pieces.shift();
    }
    lines.push(...pieces);
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return { lines: lines.slice(-limit), length: text.length };
}

const LOG_LEVELS: Record<string, string> = {
    VRB: 'TRACE', TRACE: 'TRACE', DBG: 'DEBUG', DEBUG: 'DEBUG', INF: 'INFO', INFO: 'INFO',
    WRN: 'WARN', WARN: 'WARN', ERR: 'ERROR', ERROR: 'ERROR', FTL: 'FATAL', FATAL: 'FATAL', CRITICAL: 'FATAL',
};

export function parseLogLine(text: string): { text: string; severity: string; ts: string; rest: string } {
    const tsMatch = text.match(/^\[?(\d{4}-\d{2}-\d{2}[ T][\d:.,]+(?: [+-]\d{2}:\d{2})?)\]?\s*/);
    const ts = tsMatch?.[1] || '';
    let rest = tsMatch ? text.slice(tsMatch[0].length) : text;
    const levelMatch = rest.match(/^\[?(VRB|DBG|INF|WRN|ERR|FTL|TRACE|DEBUG|INFO|WARN|ERROR|FATAL|CRITICAL)\]?\s*/)
        || text.match(/\b(TRACE|DEBUG|INFO|WARN|ERROR|FATAL|CRITICAL)\b/);
    if (levelMatch && rest.startsWith(levelMatch[0])) rest = rest.slice(levelMatch[0].length);
    return { text, severity: levelMatch ? LOG_LEVELS[levelMatch[1]] : 'INFO', ts, rest: rest.trim() };
}

function splitLog(text: string): string[] {
    const lines = text.split('\n');
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines;
}

export function libraryStatusLabel(library: Pick<LibraryInfo, 'RefreshStatus' | 'RefreshProgress'>): { text: string; tone: 'red' | 'blue' | 'green' } {
    const status = library.RefreshStatus || '';
    if (status.toLowerCase().includes('error') || status.toLowerCase().includes('fail')) return { text: status, tone: 'red' };
    if (library.RefreshProgress != null) return { text: `Scanning ${Math.round(library.RefreshProgress)}%`, tone: 'blue' };
    if (status && status !== 'Idle') return { text: status, tone: 'blue' };
    return { text: 'Idle', tone: 'green' };
}

export function isLibraryScanning(libraries: Array<Pick<LibraryInfo, 'RefreshStatus' | 'RefreshProgress'>>): boolean {
    return libraries.some(l => l.RefreshProgress != null || l.RefreshStatus === 'Active');
}

/** Polls quickly while a scan is active, and for a bounded window after a scan was requested. */
export function scanPollDelay(scanning: boolean, requestedAt: number, now: number, windowMs = 60_000): number | null {
    if (scanning) return 3000;
    if (requestedAt && now - requestedAt < windowMs) return 5000;
    return null;
}

export interface EmbyImportMapping {
    sessionId: string;
    sourceUserIds: number[];
    targetUserId: string;
}

export function embyImportMapping(sessionId: string, selected: number[], discovered: Array<{ id: number }>, targetUserId: string): EmbyImportMapping | null {
    const sourceUserIds = selected.filter(id => discovered.some(user => user.id === id));
    if (!sessionId || !targetUserId || !sourceUserIds.length) return null;
    return { sessionId, sourceUserIds, targetUserId };
}

export function sameEmbyImportMapping(a: EmbyImportMapping | null, b: EmbyImportMapping | null): boolean {
    return Boolean(a && b) && a!.sessionId === b!.sessionId && a!.targetUserId === b!.targetUserId
        && a!.sourceUserIds.length === b!.sourceUserIds.length && a!.sourceUserIds.every((id, i) => id === b!.sourceUserIds[i]);
}

export function sessionControls(session: Pick<JellyfinSession, 'SupportsRemoteControl' | 'NowPlayingItem' | 'PlayState'>): { canControl: boolean; isPaused: boolean; reason: string } {
    if (!session.NowPlayingItem) return { canControl: false, isPaused: false, reason: 'Nothing is playing' };
    if (session.SupportsRemoteControl === false) return { canControl: false, isPaused: false, reason: 'This client does not accept remote control' };
    return { canControl: true, isPaused: session.PlayState?.IsPaused === true, reason: '' };
}

const PGSQL_RUNTIME_FIELDS: Array<[configKey: string, statsKey: string, envVar: string]> = [
    ['CacheBackend', 'CacheBackend', 'Pgsql_CACHE_BACKEND'],
    ['LatestCacheTtlSeconds', 'LatestTtlSeconds', 'Pgsql_CACHE_LATEST_TTL'],
    ['ResumeCacheTtlSeconds', 'ResumeTtlSeconds', 'Pgsql_CACHE_RESUME_TTL'],
    ['NextUpCacheTtlSeconds', 'NextUpTtlSeconds', 'Pgsql_CACHE_NEXTUP_TTL'],
    ['BrowseCacheTtlSeconds', 'BrowseTtlSeconds', 'Pgsql_CACHE_BROWSE_TTL'],
    ['OptimizeNextUpQueries', 'OptimizeNextUp', 'Pgsql_PG_OPTIMIZE_NEXTUP'],
];

/** Saved settings whose effective runtime value differs, meaning an environment variable overrides them. */
export function pgsqlEnvironmentOverrides(saved: Record<string, unknown>, stats: Record<string, unknown> | null): Record<string, { envVar: string; effective: unknown }> {
    if (!stats) return {};
    const overrides: Record<string, { envVar: string; effective: unknown }> = {};
    for (const [configKey, statsKey, envVar] of PGSQL_RUNTIME_FIELDS) {
        if (!(configKey in saved) || !(statsKey in stats)) continue;
        const savedValue = saved[configKey], effective = stats[statsKey];
        const same = typeof savedValue === 'string' && typeof effective === 'string'
            ? savedValue.toLowerCase() === effective.toLowerCase()
            : savedValue === effective;
        if (!same) overrides[configKey] = { envVar, effective };
    }
    return overrides;
}

const TASTE_RUNTIME_FIELDS: Array<[configKey: string, statusKey: string]> = [
    ['EnableTasteProfiles', 'TasteEnabled'],
    ['EnableNeuralShadowTraining', 'ShadowTrainingEnabled'],
    ['UseNeuralForServing', 'NeuralServingEnabled'],
];

/** Saved taste toggles whose effective runtime value (from the shadow-eval status) differs. */
export function tasteRuntimeOverrides(saved: Record<string, unknown>, status: Record<string, unknown> | null | undefined): Record<string, { effective: boolean }> {
    if (!status) return {};
    const overrides: Record<string, { effective: boolean }> = {};
    for (const [configKey, statusKey] of TASTE_RUNTIME_FIELDS) {
        if (typeof status[statusKey] !== 'boolean') continue;
        if ((saved[configKey] === true) !== status[statusKey]) overrides[configKey] = { effective: status[statusKey] as boolean };
    }
    return overrides;
}

export function validateNewPassword(password: string, confirm: string): string {
    if (!password) return 'Enter a new password.';
    if (password !== confirm) return 'The passwords do not match.';
    return '';
}
