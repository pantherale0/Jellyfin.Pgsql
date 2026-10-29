import { isTvLayout } from './layout-mode';
import { itemCapabilities } from './catalog-model';
import type { MediaItem } from './types';

declare global {
    interface Window {
        NativePlayer?: unknown;
    }
}

/**
 * Bridge injected by native wrappers (Jellyfin Android, Jellyfin Media Player, TV wrappers)
 * that load the server's web client. Mirrors the subset of Jellyfin Web's `apphost.js` /
 * `shell.js` contract UI Next uses; every member is optional because hosts implement
 * different parts of it.
 */
export interface NativeAppHost {
    init?: () => unknown;
    supports?: (feature: string) => unknown;
    getDefaultLayout?: () => unknown;
    getDeviceProfile?: (builder: (options?: unknown) => unknown, appVersion?: string) => unknown;
    deviceId?: () => unknown;
    deviceName?: () => unknown;
    appName?: () => unknown;
    appVersion?: () => unknown;
    exit?: () => unknown;
}

export interface NativeShellBridge {
    AppHost?: NativeAppHost;
    enableFullscreen?: () => unknown;
    disableFullscreen?: () => unknown;
    openUrl?: (url: string, target?: string) => unknown;
    openClientSettings?: () => unknown;
    openDownloadManager?: () => unknown;
    downloadFile?: (item: HostDownload) => unknown;
    downloadFiles?: (items: HostDownload[]) => unknown;
    updateMediaSession?: (info: HostMediaSession) => unknown;
    hideMediaSession?: () => unknown;
    updateVolumeLevel?: (volume: number) => unknown;
    onLocalUserSignedIn?: (user: unknown, accessToken: string) => unknown;
    onLocalUserSignedOut?: (info: unknown) => unknown;
}

export interface HostIdentity { deviceId: string; deviceName: string; appName: string; appVersion: string }

export interface HostDownload { url: string; itemId: string; serverId?: string; title: string; filename: string }

export interface HostMediaSession {
    action: string;
    isLocalPlayer: boolean;
    itemId: string;
    title: string;
    artist?: string;
    album?: string;
    /** Milliseconds. */
    duration: number;
    /** Milliseconds. */
    position: number;
    imageUrl?: string;
    canSeek: boolean;
    isPaused: boolean;
}

/** Lowercase `AppFeature` strings from Jellyfin Web. */
export type HostFeature =
    | 'filedownload' | 'externallinks' | 'fullscreenchange' | 'fileinput' | 'sharing'
    | 'clientsettings' | 'downloadmanagement' | 'exitmenu';

export interface AndroidNativePlayOptions {
    ids: [string, ...string[]];
    startIndex: number;
    startPositionTicks: number;
}

export interface AndroidNativePlayerPreferences {
    maxStreamingBitrateLocal: number;
    maxStreamingBitrateRemote: number;
}

export interface AndroidNativePlayerBridge {
    isEnabled: () => unknown;
    syncSession?: (requestId: string, serverUrl: string, userId: string, accessToken: string) => unknown;
    loadPlayer: (playOptions: string, preferences: string) => unknown;
}

export type AndroidNativePlaybackDispatch = 'unavailable' | 'disabled' | 'dispatched' | 'failed';
export type AndroidNativeSessionSync = 'unavailable' | 'disabled' | 'ready' | 'legacy' | 'rejected' | 'timeout' | 'failed';

export interface AndroidNativeSession {
    serverUrl: string;
    userId: string;
    accessToken: string;
}

export function canHandOffToAndroidNativePlayer(item: Pick<MediaItem, 'Type' | 'MediaType'>): boolean {
    return itemCapabilities(item).playable && item.Type !== 'Audio' && item.MediaType !== 'Audio';
}

interface AndroidQueueSnapshot {
    order: ReadonlyArray<Pick<MediaItem, 'Id'>>;
    position: number;
}

/** Builds the item list expected by Jellyfin Android's NativePlayer bridge. */
export function buildAndroidNativePlayOptions(input: {
    itemId: string;
    startPositionTicks: number;
    queue?: AndroidQueueSnapshot;
}): AndroidNativePlayOptions {
    const order = input.queue?.order || [];
    const queuePosition = Number.isInteger(input.queue?.position)
        ? Math.max(-1, Math.min(input.queue?.position ?? -1, order.length - 1))
        : -1;
    const selectedIndex = order[queuePosition]?.Id === input.itemId
        ? queuePosition
        : order.findIndex(item => item.Id === input.itemId);
    const position = Number.isFinite(input.startPositionTicks)
        ? Math.max(0, Math.round(input.startPositionTicks))
        : 0;

    if (selectedIndex >= 0) {
        const [ firstId, ...remainingIds ] = order.map(item => item.Id);
        if (firstId !== undefined) return { ids: [ firstId, ...remainingIds ], startIndex: selectedIndex, startPositionTicks: position };
    }

    const pending = order.slice(queuePosition + 1).map(item => item.Id);
    return { ids: [ input.itemId, ...pending ], startIndex: 0, startPositionTicks: position };
}

/** Android's bridge requires numeric local and remote caps; UI Next Auto uses its default cap. */
export function buildAndroidNativePlayerPreferences(maxBitrate: number, defaultMaxBitrate: number): AndroidNativePlayerPreferences {
    const fallback = Number.isFinite(defaultMaxBitrate) && defaultMaxBitrate > 0
        ? Math.round(defaultMaxBitrate)
        : 120_000_000;
    const bitrate = Number.isFinite(maxBitrate) && maxBitrate > 0 ? Math.round(maxBitrate) : fallback;
    return { maxStreamingBitrateLocal: bitrate, maxStreamingBitrateRemote: bitrate };
}

function androidNativePlayerBridge(): AndroidNativePlayerBridge | null {
    if (typeof window === 'undefined') return null;
    try {
        const candidate = window.NativePlayer;
        if (typeof candidate !== 'object' || candidate === null || !('isEnabled' in candidate) || !('loadPlayer' in candidate)) return null;
        const isEnabled = candidate.isEnabled;
        const syncSession = 'syncSession' in candidate ? candidate.syncSession : undefined;
        const loadPlayer = candidate.loadPlayer;
        if (typeof isEnabled !== 'function' || typeof loadPlayer !== 'function' || (syncSession !== undefined && typeof syncSession !== 'function')) return null;
        return {
            isEnabled: () => Reflect.apply(isEnabled, candidate, []),
            ...(typeof syncSession === 'function' ? {
                syncSession: (requestId: string, serverUrl: string, userId: string, accessToken: string) => Reflect.apply(syncSession, candidate, [ requestId, serverUrl, userId, accessToken ])
            } : {}),
            loadPlayer: (playOptions, preferences) => Reflect.apply(loadPlayer, candidate, [ playOptions, preferences ])
        };
    } catch (_error) {
        return null;
    }
}

function currentHostAppName(): string | null {
    const appHost = nativeShell()?.AppHost;
    if (appHost && typeof appHost.appName === 'function') {
        try {
            return identityString(appHost.appName.call(appHost));
        } catch (_error) {
            return null;
        }
    }
    return hostIdentity()?.appName || null;
}

export function isLegacyAndroidNativePlayer(): boolean {
    const bridge = androidNativePlayerBridge();
    return bridge !== null && !bridge.syncSession && currentHostAppName() === 'Jellyfin for Android';
}

const LEGACY_ANDROID_CREDENTIALS_KEY = 'jellyfin_credentials';

function isObjectRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readLegacyAndroidCredentials(): { fields: Record<string, unknown>; servers: unknown[] } {
    try {
        const raw = localStorage.getItem(LEGACY_ANDROID_CREDENTIALS_KEY);
        if (!raw) return { fields: {}, servers: [] };
        const parsed: unknown = JSON.parse(raw);
        if (!isObjectRecord(parsed)) return { fields: {}, servers: [] };
        return { fields: parsed, servers: Array.isArray(parsed.Servers) ? parsed.Servers : [] };
    } catch (_error) {
        return { fields: {}, servers: [] };
    }
}

function matchesLegacyAndroidSession(value: unknown, session: Pick<AndroidNativeSession, 'userId' | 'accessToken'>): boolean {
    return isObjectRecord(value) && value.UserId === session.userId && value.AccessToken === session.accessToken;
}

export function writeLegacyAndroidCredentials(session: AndroidNativeSession): boolean {
    if (!isLegacyAndroidNativePlayer() || typeof window === 'undefined' || !session.userId || !session.accessToken) return false;
    try {
        const server = new URL(session.serverUrl);
        if ((server.protocol !== 'https:' && server.protocol !== 'http:')
            || server.origin !== window.location.origin
            || server.username || server.password || server.search || server.hash) return false;
        const stored = readLegacyAndroidCredentials();
        const servers = stored.servers.filter(value => !matchesLegacyAndroidSession(value, session));
        localStorage.setItem(LEGACY_ANDROID_CREDENTIALS_KEY, JSON.stringify({
            ...stored.fields,
            Servers: [ { UserId: session.userId, AccessToken: session.accessToken }, ...servers ]
        }));
        return true;
    } catch (_error) {
        return false;
    }
}

export function clearLegacyAndroidCredentials(session?: Pick<AndroidNativeSession, 'userId' | 'accessToken'>): void {
    if (!isLegacyAndroidNativePlayer() || !session?.userId || !session.accessToken) return;
    try {
        const stored = readLegacyAndroidCredentials();
        const servers = stored.servers.filter(value => !matchesLegacyAndroidSession(value, session));
        if (servers.length === stored.servers.length) return;
        if (servers.length === 0 && Object.keys(stored.fields).every(key => key === 'Servers')) {
            localStorage.removeItem(LEGACY_ANDROID_CREDENTIALS_KEY);
        } else {
            localStorage.setItem(LEGACY_ANDROID_CREDENTIALS_KEY, JSON.stringify({ ...stored.fields, Servers: servers }));
        }
    } catch (_error) { /* Storage can be disabled. */ }
}

let nativeSessionSyncSequence = 0;

export interface AndroidNativeSessionSyncOptions {
    timeoutMs?: number;
    legacySync?: () => Promise<boolean>;
}

/** Synchronizes and verifies the UI session in Jellyfin Android before native playback. */
export async function synchronizeAndroidNativePlayerSession(session: AndroidNativeSession, options: AndroidNativeSessionSyncOptions = {}): Promise<AndroidNativeSessionSync> {
    const bridge = androidNativePlayerBridge();
    if (!bridge || typeof window === 'undefined') return Promise.resolve('unavailable');
    try {
        if (bridge.isEnabled() !== true) return Promise.resolve('disabled');
        const server = new URL(session.serverUrl);
        if ((server.protocol !== 'https:' && server.protocol !== 'http:')
            || server.origin !== window.location.origin
            || server.username || server.password || server.search || server.hash) {
            return Promise.resolve('unavailable');
        }
    } catch (_error) {
        return Promise.resolve('unavailable');
    }
    if (!session.userId || !session.accessToken) return Promise.resolve('unavailable');

    if (!bridge.syncSession) {
        if (!isLegacyAndroidNativePlayer() || !options.legacySync) return 'unavailable';
        try {
            return await options.legacySync() ? 'legacy' : 'failed';
        } catch (_error) {
            return 'failed';
        }
    }

    nativeSessionSyncSequence += 1;
    const requestId = `ui-next-${Date.now().toString(36)}-${nativeSessionSyncSequence}`;
    return new Promise(resolve => {
        let timer: number | undefined;
        let settled = false;
        const finish = (result: AndroidNativeSessionSync) => {
            if (settled) return;
            settled = true;
            window.removeEventListener('jellyfin-native-session-sync', onSyncResult);
            if (timer !== undefined) window.clearTimeout(timer);
            resolve(result);
        };
        const onSyncResult = (event: Event) => {
            if (!(event instanceof CustomEvent)) return;
            const detail: unknown = event.detail;
            if (typeof detail !== 'object' || detail === null || !('requestId' in detail) || !('ready' in detail)) return;
            if (detail.requestId !== requestId || typeof detail.ready !== 'boolean') return;
            finish(detail.ready ? 'ready' : 'rejected');
        };
        window.addEventListener('jellyfin-native-session-sync', onSyncResult);
        timer = window.setTimeout(() => finish('timeout'), Math.max(1, options.timeoutMs ?? 15_000));
        try {
            if (bridge.syncSession?.(requestId, session.serverUrl, session.userId, session.accessToken) !== true) finish('failed');
        } catch (_error) {
            finish('failed');
        }
    });
}

/** Hands video playback to Jellyfin Android's existing full-screen ExoPlayer. */
export function dispatchAndroidNativePlayback(options: AndroidNativePlayOptions, preferences: AndroidNativePlayerPreferences): AndroidNativePlaybackDispatch {
    const bridge = androidNativePlayerBridge();
    if (!bridge) return 'unavailable';
    let enabled: unknown;
    try {
        enabled = bridge.isEnabled();
    } catch (_error) {
        return 'unavailable';
    }
    if (enabled !== true) return 'disabled';
    try {
        bridge.loadPlayer(JSON.stringify(options), JSON.stringify(preferences));
        return 'dispatched';
    } catch (_error) {
        return 'failed';
    }
}

/** Runs once when the WebView becomes active again after native playback. */
export function listenForNativePlayerReturn(onReturn: () => void): () => void {
    if (typeof window === 'undefined' || typeof document === 'undefined') return () => undefined;
    let away = false;
    const onBlur = () => { away = true; };
    const onFocus = () => {
        if (!away || document.visibilityState === 'hidden') return;
        away = false;
        onReturn();
    };
    const onVisibilityChange = () => {
        if (document.visibilityState === 'hidden') away = true;
        else onFocus();
    };
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    window.addEventListener('pageshow', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
        window.removeEventListener('blur', onBlur);
        window.removeEventListener('focus', onFocus);
        window.removeEventListener('pageshow', onFocus);
        document.removeEventListener('visibilitychange', onVisibilityChange);
    };
}

export function nativeShell(): NativeShellBridge | null {
    try {
        const shell = (globalThis as { NativeShell?: unknown }).NativeShell;
        return shell && typeof shell === 'object' ? shell as NativeShellBridge : null;
    } catch (_error) {
        return null;
    }
}

export function hasNativeShell(): boolean {
    return nativeShell() !== null;
}

/** Calls a bridge member; a missing member or a throwing/rejecting host never reaches the UI. */
function call<T>(invoke: (shell: NativeShellBridge) => T): { called: boolean; value?: T } {
    const shell = nativeShell();
    if (!shell) return { called: false };
    try {
        const value = invoke(shell);
        if (value && typeof (value as { catch?: unknown }).catch === 'function') (value as unknown as Promise<unknown>).catch(() => undefined);
        return { called: true, value };
    } catch (_error) {
        return { called: true };
    }
}

const IDENTITY_MAX = 256;
const DEVICE_PROFILE_TIMEOUT_MS = 3000;

function identityString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    return text && text.length <= IDENTITY_MAX && !/[\u0000-\u001f\u007f]/.test(text) ? text : null;
}

let identity: HostIdentity | null = null;

export function hostIdentity(): HostIdentity | null {
    return identity;
}

/** Test seam: forget the cached host identity. */
export function resetHostIdentity(): void {
    identity = null;
}

/**
 * Resolves the wrapper's device and app identity before the first request so the
 * server sees the same device the wrapper registers for Jellyfin Web. Resolves null
 * without a host, on timeout, or when the host reports unusable values.
 */
export async function initHostIdentity(timeoutMs = 3000): Promise<HostIdentity | null> {
    const host = nativeShell()?.AppHost;
    if (!host) return null;
    const read = async (): Promise<HostIdentity | null> => {
        let initial: Record<string, unknown> = {};
        if (typeof host.init === 'function') {
            const result = await host.init();
            if (result && typeof result === 'object') initial = result as Record<string, unknown>;
        }
        const pick = (getter: (() => unknown) | undefined, key: string): string | null => {
            try {
                const fromGetter = typeof getter === 'function' ? identityString(getter.call(host)) : null;
                return fromGetter ?? identityString(initial[key]);
            } catch (_error) {
                return identityString(initial[key]);
            }
        };
        const deviceId = pick(host.deviceId, 'deviceId');
        const deviceName = pick(host.deviceName, 'deviceName');
        const appName = pick(host.appName, 'appName');
        const appVersion = pick(host.appVersion, 'appVersion');
        return deviceId && deviceName && appName && appVersion ? { deviceId, deviceName, appName, appVersion } : null;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        identity = await Promise.race([
            read(),
            new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); }),
        ]);
    } catch (_error) {
        identity = null;
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
    return identity;
}

/** What a plain browser offers, mirroring Jellyfin Web's `supportedFeatures` for the features UI Next uses. */
export function browserSupports(feature: HostFeature, tv: boolean, canShare = false): boolean {
    switch (feature) {
        case 'filedownload':
        case 'externallinks':
        case 'fullscreenchange':
        case 'fileinput':
            return !tv;
        case 'sharing':
            return canShare;
        default:
            return false;
    }
}

export function hostSupports(feature: HostFeature): boolean {
    const host = nativeShell()?.AppHost;
    if (host && typeof host.supports === 'function') {
        const result = call(() => host.supports!(feature));
        return result.value === true;
    }
    const canShare = typeof navigator !== 'undefined' && typeof (navigator as Navigator & { share?: unknown }).share === 'function';
    return browserSupports(feature, isTvLayout(), canShare);
}

function isDeviceProfile(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const profile = value as Record<string, unknown>;
    return Array.isArray(profile.DirectPlayProfiles) && Array.isArray(profile.TranscodingProfiles);
}

/**
 * Lets the wrapper adjust the device profile (its native decoders, resolution caps) the way
 * Jellyfin Web's `AppHost.getDeviceProfile(profileBuilder)` does. The builder handed to the host
 * ignores Jellyfin Web's builder options and returns UI Next's own profile.
 */
export async function hostDeviceProfile<T extends object>(build: () => T, appVersion: string, timeoutMs = DEVICE_PROFILE_TIMEOUT_MS): Promise<T> {
    const host = nativeShell()?.AppHost;
    if (!host || typeof host.getDeviceProfile !== 'function') return build();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const profile = await Promise.race([
            host.getDeviceProfile(() => build(), appVersion),
            new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), Math.max(1, timeoutMs)); })
        ]);
        return isDeviceProfile(profile) ? profile as T : build();
    } catch (_error) {
        return build();
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

export function nativeShellLayout(): string | null {
    const host = nativeShell()?.AppHost;
    if (!host || typeof host.getDefaultLayout !== 'function') return null;
    const { value } = call(() => host.getDefaultLayout!());
    return typeof value === 'string' ? value : null;
}

export function notifySignedIn(user: unknown, accessToken: string): void {
    call(shell => shell.onLocalUserSignedIn?.(user, accessToken));
}

export function notifySignedOut(info: unknown = {}, legacySession?: Pick<AndroidNativeSession, 'userId' | 'accessToken'>): void {
    clearLegacyAndroidCredentials(legacySession);
    call(shell => shell.onLocalUserSignedOut?.(info));
}

export function enableHostFullscreen(): void {
    call(shell => shell.enableFullscreen?.());
}

export function disableHostFullscreen(): void {
    call(shell => shell.disableFullscreen?.());
}

export function safeExternalUrl(url: string): string | null {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
    } catch (_error) {
        return null;
    }
}

/** Opens an http(s) URL in the host's browser, or a new tab; anything else is refused. */
export function openExternalUrl(url: string, target = '_blank'): boolean {
    const safe = safeExternalUrl(url);
    if (!safe) return false;
    const shell = nativeShell();
    if (shell && typeof shell.openUrl === 'function') {
        call(bridge => bridge.openUrl!(safe, target));
        return true;
    }
    if (typeof window === 'undefined') return false;
    window.open(safe, target, 'noopener,noreferrer');
    return true;
}

/** Hands a download to the host's download manager; false means the caller should use the browser. */
export function hostDownload(item: HostDownload): boolean {
    const shell = nativeShell();
    if (!shell || !safeExternalUrl(item.url)) return false;
    if (typeof shell.downloadFiles === 'function') return call(bridge => bridge.downloadFiles!([ item ])).called;
    if (typeof shell.downloadFile === 'function') return call(bridge => bridge.downloadFile!(item)).called;
    return false;
}

/** Builds the payload Jellyfin Web sends to `NativeShell.updateMediaSession`. */
export function hostMediaSessionInfo(item: Pick<MediaItem, 'Id' | 'Name' | 'SeriesName' | 'RunTimeTicks' | 'Album' | 'AlbumArtists'> & { SeasonName?: string; AlbumArtist?: string; Artists?: string[] }, state: { action: string; positionSeconds: number; durationSeconds: number; paused: boolean; imageUrl?: string }): HostMediaSession {
    const ms = (seconds: number) => Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
    const durationMs = ms(state.durationSeconds) || (item.RunTimeTicks ? Math.round(item.RunTimeTicks / 10_000) : 0);
    return {
        action: state.action,
        isLocalPlayer: true,
        itemId: item.Id,
        title: item.Name || '',
        artist: item.SeriesName || item.AlbumArtist || item.AlbumArtists?.[0]?.Name || item.Artists?.[0] || undefined,
        album: item.Album || item.SeasonName || undefined,
        duration: durationMs,
        position: Math.min(ms(state.positionSeconds), durationMs || Number.MAX_SAFE_INTEGER),
        imageUrl: state.imageUrl || undefined,
        canSeek: durationMs > 0 && Number.isFinite(state.durationSeconds),
        isPaused: state.paused,
    };
}

export function updateHostMediaSession(info: HostMediaSession): void {
    call(shell => shell.updateMediaSession?.(info));
}

export function hideHostMediaSession(): void {
    call(shell => shell.hideMediaSession?.());
}

export function updateHostVolume(volume: number): void {
    if (!Number.isFinite(volume)) return;
    call(shell => shell.updateVolumeLevel?.(Math.round(Math.min(1, Math.max(0, volume)) * 100)));
}

export function openHostClientSettings(): void {
    call(shell => shell.openClientSettings?.());
}

export function openHostDownloadManager(): void {
    call(shell => shell.openDownloadManager?.());
}

export function exitHostApp(): void {
    call(shell => shell.AppHost?.exit?.());
}
