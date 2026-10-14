import type { GuideInfo, ItemResponse, JellyfinUser, LiveChannelFilter, LiveTimer, MediaItem, RecommendationGroup, Session, TasteProfile, UserConfiguration } from './types';
import type { PlaybackReport } from './playback-report';
import { mediaVersions, preferredVersionId, startPlan, transcodeReasonsFromUrl, type MediaStreamInfo, type PlaybackChoice, type PlaybackOptions, type SessionTranscodingInfo, type TrickplayLevel } from './player-model';
import { browserCapabilities, buildDeviceProfile, loadPlaybackPreferences } from './device-profile';
import { isHlsUrl } from './live-model';
import { mapLibraryQuery } from './library-query';
import type { LibraryItemsOptions } from './library-query';
import { clientVersion } from './build';
import { recommendationTitle } from './home-feed-blocks';
import { withEntityType, type EntitySearchSection, type FavoriteGroup } from './discovery';
import { asItemResponse, asMediaItem } from './api-contracts';
import { normalizeBranding, NO_BRANDING, type Branding } from './branding';
import { publicUsers, type ForgotPasswordResult, type PublicUser } from './account';
import { createSsoSession, normalizeUserId, SSO_HANDOFF_KEY, UI_NEXT_SIGNED_OUT_KEY, type SsoHandoff, type SsoHandoffAttempt } from './sso-session';

const CLIENT_NAME = 'Jellyfin UI Next';
const CLIENT_VERSION = clientVersion();
const USER_AGENT = navigator.userAgent.toLowerCase();
const DEVICE_NAME = /web0s|webos|netcast/.test(USER_AGENT) ? 'webOS TV Browser'
    : /tizen|samsungbrowser/.test(USER_AGENT) ? 'Samsung TV Browser'
        : /titanos/.test(USER_AGENT) ? 'Titan OS TV Browser'
            : /vidaa|hisense/.test(USER_AGENT) ? 'VIDAA TV Browser'
                : /android/.test(USER_AGENT) ? 'Android Browser'
                    : /iphone|ipad|ipod/.test(USER_AGENT) ? 'iOS Browser' : 'Web Browser';
const DEVICE_ID_KEY = 'jellyfin-ui-next-device-id';
let fallbackDeviceId: string | undefined;

function createDeviceId(): string {
    return 'ui-next-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function deviceId(): string {
    try {
        let id = localStorage.getItem(DEVICE_ID_KEY);
        if (!id) {
            id = 'ui-next-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
            localStorage.setItem(DEVICE_ID_KEY, id);
        }
        return id;
    } catch (_error) {
        fallbackDeviceId = fallbackDeviceId || createDeviceId();
        return fallbackDeviceId;
    }
}

function normalizeServer(server: string): string {
    const url = new URL(server.trim());
    const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    const isSameOrigin = url.origin === window.location.origin;
    const devHttpAllowed = import.meta.env?.DEV === true && url.protocol === 'http:';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (devHttpAllowed || isLocalhost || isSameOrigin))) {
        throw new Error('Use HTTPS for Jellyfin servers. HTTP is allowed for localhost, the same origin, or this development build.');
    }
    if (url.username || url.password || url.search || url.hash) {
        throw new Error('Enter the Jellyfin server address only, without credentials or query parameters.');
    }
    url.pathname = url.pathname.replace(/\/(web|web\/index\.html)\/?$/i, '').replace(/\/$/, '');
    return url.toString().replace(/\/$/, '');
}

function authorization(token?: string): string {
    const values = [
        `Client="${encodeURIComponent(CLIENT_NAME)}"`,
        `Device="${encodeURIComponent(DEVICE_NAME)}"`,
        `DeviceId="${encodeURIComponent(deviceId())}"`,
        `Version="${encodeURIComponent(CLIENT_VERSION)}"`,
        `Token="${encodeURIComponent(token || '')}"`
    ];
    return `MediaBrowser ${values.join(', ')}`;
}

function queryString(values: Record<string, string | number | undefined>): string {
    return Object.keys(values)
        .filter(key => values[key] !== undefined)
        .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(String(values[key]))}`)
        .join('&');
}

const IMAGE_CACHE_LIMIT = 200;

interface CachedImage {
    objectUrl: string;
    refs: number;
}

const imageCache = new Map<string, CachedImage>();

// Browsers only keep a handful of HTTP/1.1 connections per host. Requests made through
// this scheduler (API reads and loadImage blobs) stay under that cap so a click can still
// take the last slot. Plain <img> elements (home feed cards, live thumbnails) are fetched
// by the browser and are not counted here; the cap is a budget for scheduled work only.
const MAX_IN_FLIGHT = 4;
const MAX_BULK = 3;
const MAX_BACKGROUND = 2;

// Fairness: queued bulk/background work that has waited this long competes as interactive,
// so a sustained stream of clicks cannot starve it. Work still queued after the deadline
// is dropped through its own settle path instead of starting long after anyone wanted it.
export const QUEUE_AGEING_MS = 4000;
export const QUEUE_DEADLINE_MS = 45000;

interface ScheduledRequest {
    priority: number;
    cancelled: boolean;
    queuedAt: number;
    abort?: () => void;
    drop?: () => void;
    run: (finish: () => void, registerAbort: (abort: () => void) => void) => void;
}

/** Effective priority after ageing; exported for tests. */
export function effectivePriority(priority: number, queuedAt: number, now: number): number {
    return priority < 2 && now - queuedAt >= QUEUE_AGEING_MS ? 2 : priority;
}

let inFlight = 0;
let bulkInFlight = 0;
let backgroundInFlight = 0;
let pumping = false;
let pumpScheduled = false;
const requestQueue: ScheduledRequest[] = [];

function schedulePump(): void {
    if (pumpScheduled) return;
    pumpScheduled = true;
    // After the current turn, so a batch of unmounts can cancel queued work
    // before the next image request is started.
    Promise.resolve().then(() => {
        pumpScheduled = false;
        pumpRequests();
    });
}

function enqueueRequest(priority: number, run: ScheduledRequest['run'], drop?: () => void): { cancel: () => 'queued' | 'started' } {
    const slot: ScheduledRequest = { priority, cancelled: false, queuedAt: Date.now(), run, drop };
    requestQueue.push(slot);
    pumpRequests();
    return {
        cancel: () => {
            slot.cancelled = true;
            const index = requestQueue.indexOf(slot);
            if (index >= 0) {
                requestQueue.splice(index, 1);
                return 'queued';
            }
            slot.abort?.();
            return 'started';
        }
    };
}

function pumpRequests(): void {
    if (pumping) return;
    pumping = true;
    try {
        while (startNextRequest()) { /* fill every free slot */ }
    } finally {
        pumping = false;
    }
}

function dropExpired(now: number): void {
    for (let cursor = requestQueue.length - 1; cursor >= 0; cursor -= 1) {
        const slot = requestQueue[cursor];
        if (slot.cancelled || now - slot.queuedAt < QUEUE_DEADLINE_MS || !slot.drop) continue;
        requestQueue.splice(cursor, 1);
        slot.cancelled = true;
        try { slot.drop(); } catch (_error) { /* A failing drop handler must not stall the queue. */ }
    }
}

function startNextRequest(): boolean {
    const now = Date.now();
    dropExpired(now);
    const interactive = requestQueue.findIndex(slot => !slot.cancelled && effectivePriority(slot.priority, slot.queuedAt, now) >= 2);
    const bulk = requestQueue.findIndex(slot => !slot.cancelled && slot.priority === 1);
    const background = requestQueue.findIndex(slot => !slot.cancelled && slot.priority <= 0);
    let index = -1;
    if (interactive >= 0 && inFlight < MAX_IN_FLIGHT) index = interactive;
    else if (bulk >= 0 && bulkInFlight < MAX_BULK && inFlight < MAX_BULK) index = bulk;
    else if (background >= 0 && backgroundInFlight < (bulk >= 0 ? 1 : MAX_BACKGROUND) && inFlight < MAX_BULK) index = background;
    else {
        for (let cursor = requestQueue.length - 1; cursor >= 0; cursor -= 1) {
            if (requestQueue[cursor].cancelled) requestQueue.splice(cursor, 1);
        }
        return false;
    }
    const slot = requestQueue.splice(index, 1)[0];
    inFlight += 1;
    if (slot.priority <= 0) backgroundInFlight += 1;
    else if (slot.priority === 1) bulkInFlight += 1;
    let finished = false;
    const finish = () => {
        if (finished) return;
        finished = true;
        inFlight -= 1;
        if (slot.priority <= 0) backgroundInFlight -= 1;
        else if (slot.priority === 1) bulkInFlight -= 1;
        schedulePump();
    };
    try {
        slot.run(finish, abort => {
            slot.abort = abort;
            if (slot.cancelled) abort();
        });
    } catch (_error) {
        finish();
    }
    return true;
}

interface ImageJob {
    promise: Promise<string>;
    waiters: number;
    settled: boolean;
    cancel: () => void;
}

const imageJobs = new Map<string, ImageJob>();

export interface ImageCancel {
    cancel?: () => void;
}

function evictImages(protectedUrl?: string): void {
    if (imageCache.size <= IMAGE_CACHE_LIMIT) return;
    Array.from(imageCache.entries()).forEach(([url, entry]) => {
        if (imageCache.size <= IMAGE_CACHE_LIMIT || entry.refs > 0 || url === protectedUrl) return;
        URL.revokeObjectURL(entry.objectUrl);
        imageCache.delete(url);
    });
}

function rememberImage(url: string, objectUrl: string): string {
    const existing = imageCache.get(url);
    if (existing) {
        if (existing.objectUrl !== objectUrl) URL.revokeObjectURL(objectUrl);
        imageCache.delete(url);
        imageCache.set(url, existing);
        return existing.objectUrl;
    }
    imageCache.set(url, { objectUrl, refs: 0 });
    evictImages(url);
    return objectUrl;
}

export function peekCachedImage(url: string): string {
    if (!url) return '';
    const entry = imageCache.get(url);
    return entry ? entry.objectUrl : '';
}

export function retainCachedImage(url: string): void {
    const entry = imageCache.get(url);
    if (!entry) return;
    entry.refs += 1;
    imageCache.delete(url);
    imageCache.set(url, entry);
}

export function releaseCachedImage(url: string): void {
    const entry = imageCache.get(url);
    if (!entry) return;
    entry.refs = Math.max(0, entry.refs - 1);
}

export function clearImageCache(): void {
    imageJobs.forEach(job => job.cancel());
    imageJobs.clear();
    imageCache.forEach(entry => URL.revokeObjectURL(entry.objectUrl));
    imageCache.clear();
}

export class JellyfinRequestError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

export interface ApiRequestInit {
    method?: string;
    headers?: Record<string, string>;
    body?: string | FormData;
    signal?: AbortSignal | null;
}

/** DOMException is not constructible on the oldest legacy targets. */
function abortError(): Error {
    try {
        return new DOMException('The request was cancelled.', 'AbortError');
    } catch (_error) {
        const error = new Error('The request was cancelled.');
        error.name = 'AbortError';
        return error;
    }
}

function xhrRequest<T>(url: string, method = 'GET', headers: Record<string, string> = {}, body?: Document | XMLHttpRequestBodyInit, emptyOk = false, priority = 2, signal?: AbortSignal | null, responseType: 'json' | 'text' = 'json', maxResponseBytes?: number): Promise<T> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(abortError()); return; }
        const cleanup = () => signal?.removeEventListener('abort', onAbort);
        const onAbort = () => {
            if (handle.cancel() === 'queued') {
                cleanup();
                reject(abortError());
            }
        };
        const dropQueued = () => {
            cleanup();
            reject(new Error('The Jellyfin server took too long to respond.'));
        };
        const handle = enqueueRequest(priority, (finish, registerAbort) => {
            const xhr = new XMLHttpRequest();
            let settled = false;
            const settle = (callback: () => void) => {
                if (settled) return;
                settled = true;
                cleanup();
                callback();
                finish();
            };
            registerAbort(() => xhr.abort());
            try {
                xhr.open(method, url, true);
                Object.keys(headers).forEach(key => xhr.setRequestHeader(key, headers[key]));
                xhr.onload = () => {
                    try {
                        if (xhr.responseURL && new URL(xhr.responseURL).origin !== new URL(url, window.location.href).origin) {
                            settle(() => reject(new Error('The Jellyfin server redirected this request to another origin. Check the server address and proxy configuration.')));
                            return;
                        }
                    } catch (_error) {
                        settle(() => reject(new Error('The Jellyfin server returned an invalid response URL.')));
                        return;
                    }
                    if (xhr.status < 200 || xhr.status >= 300) {
                        const responseMessage = (xhr.responseText || '')
                            .replace(/[\u0000-\u001f\u007f]/g, ' ')
                            .replace(/\s+/g, ' ')
                            .trim()
                            .slice(0, 180);
                        settle(() => reject(new JellyfinRequestError(xhr.status, responseMessage || `Jellyfin request failed (${xhr.status}).`)));
                        return;
                    }
                    const text = xhr.responseText || '';
                    if (emptyOk && !text.trim()) {
                        settle(() => resolve(undefined as T));
                        return;
                    }
                    const deliver = () => {
                        cleanup();
                        try {
                            if (signal?.aborted) reject(abortError());
                            else resolve((responseType === 'text' ? text : JSON.parse(text)) as T);
                        } catch (_error) {
                            if (emptyOk) resolve(undefined as T);
                            else reject(new Error('The server returned an invalid response.'));
                        }
                        finish();
                    };
                    settled = true;
                    // A large catalog payload is parsed on a later turn so input queued behind a
                    // burst of responses can run first; the parse itself still occupies the main thread.
                    if (text.length > 120000) window.setTimeout(deliver, 0);
                    else deliver();
                };
                xhr.onerror = () => settle(() => reject(new Error('Could not reach the Jellyfin server. Check the address and connection.')));
                xhr.onprogress = event => {
                    if (maxResponseBytes && event.loaded > maxResponseBytes) {
                        settle(() => reject(new Error('This log exceeds the 2 MB viewer limit. Select a smaller log file.')));
                        xhr.abort();
                    }
                };
                xhr.ontimeout = () => settle(() => reject(new Error('The Jellyfin server took too long to respond.')));
                xhr.onabort = () => settle(() => reject(new Error('The request was cancelled.')));
                xhr.timeout = 20000;
                xhr.send(body || null);
            } catch (_error) {
                settle(() => reject(new Error('Could not reach the Jellyfin server. Check the address and connection.')));
            }
        }, dropQueued);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

interface PlaybackMediaSource {
    Id: string;
    Name?: string;
    Container?: string;
    SupportsDirectPlay?: boolean;
    SupportsDirectStream?: boolean;
    TranscodingUrl?: string;
    Bitrate?: number;
    MediaStreams?: MediaStreamInfo[];
    TranscodeReasons?: number | string;
    DefaultAudioStreamIndex?: number | null;
    DefaultSubtitleStreamIndex?: number | null;
    RequiresOpening?: boolean;
    OpenToken?: string;
    LiveStreamId?: string;
    IsInfiniteStream?: boolean;
}

/** Long-running series can exceed a thousand episodes; this only bounds a server that never reports a total. */
const MAX_EPISODES = 20000;

export class JellyfinApi {
    readonly session: Session;
    private readonly onSessionExpired?: () => void;
    private sessionExpired = false;
    private reportTail: Promise<unknown> = Promise.resolve();

    constructor(session: Session, onSessionExpired?: () => void) {
        this.session = session;
        this.onSessionExpired = onSessionExpired;
    }

    static async login(serverInput: string, username: string, password: string): Promise<Session> {
        const server = normalizeServer(serverInput);
        let data: { AccessToken?: string; User?: JellyfinUser; ServerId?: string };
        try {
            data = await xhrRequest(`${server}/Users/AuthenticateByName`, 'POST', {
                'Content-Type': 'application/json',
                'Authorization': authorization()
            }, JSON.stringify({ Username: username, Pw: password }));
        } catch (error) {
            if (error instanceof JellyfinRequestError) throw error;
            throw new Error(error instanceof Error ? error.message : 'Sign-in failed. Check your server and credentials.');
        }
        if (!data.AccessToken || !data.User?.Id) throw new Error('The server returned an incomplete sign-in response.');
        return {
            server,
            token: data.AccessToken,
            user: data.User,
            serverId: data.ServerId || ''
        };
    }

    static async loginWithQuickConnect(serverInput: string, secret: string): Promise<Session> {
        const server = normalizeServer(serverInput);
        const result = await xhrRequest<{ AccessToken?: string; User?: JellyfinUser; ServerId?: string }>(
            `${server}/Users/AuthenticateWithQuickConnect`,
            'POST',
            { 'Content-Type': 'application/json', 'Authorization': authorization() },
            JSON.stringify({ Secret: secret })
        );
        if (!result.AccessToken || !result.User?.Id) throw new Error('Quick Connect did not return a Jellyfin session.');
        return { server, token: result.AccessToken, user: result.User, serverId: result.ServerId || '' };
    }

    static async getSsoConfig(serverInput: string): Promise<{ enabled: boolean; checked: boolean }> {
        const server = normalizeServer(serverInput);
        const configUrl = import.meta.env?.DEV === true
            ? `/__debug/sso-config?server=${encodeURIComponent(server)}`
            : `${server}/sso/config`;
        try {
            const result = await xhrRequest<{ Enabled?: boolean; enabled?: boolean }>(configUrl);
            return { enabled: result.Enabled === true || result.enabled === true, checked: true };
        } catch (_error) {
            // Optional feature probe: a failed probe is unavailable, not disabled.
            return { enabled: false, checked: false };
        }
    }

    static async beginSso(serverInput: string): Promise<void> {
        const server = normalizeServer(serverInput);
        try { localStorage.setItem('jellyfin-ui-next-server', server); } catch (_error) { /* Session screen remains available after callback. */ }
        let previousAccessToken: string | null = null;
        try {
            previousAccessToken = localStorage.getItem('api_key');
        } catch (_error) { /* A callback can still be parsed if there was no saved classic session. */ }
        const attempt: SsoHandoffAttempt = {
            server,
            startedAt: Date.now(),
            previousAccessToken
        };
        try {
            localStorage.removeItem(UI_NEXT_SIGNED_OUT_KEY);
            sessionStorage.setItem(SSO_HANDOFF_KEY, JSON.stringify(attempt));
        } catch (_error) {
            try { sessionStorage.removeItem(SSO_HANDOFF_KEY); } catch (_storageError) { /* No pending marker was saved. */ }
            throw new Error('This browser cannot store the SSO sign-in handoff.');
        }
        const query = queryString({ deviceId: deviceId() });
        window.location.assign(`${server}/sso/login?${query}`);
    }

    static async restoreSsoSession(handoff: SsoHandoff): Promise<Session> {
        const server = normalizeServer(handoff.server);
        const [ user, serverInfo ] = await Promise.all([
            xhrRequest<unknown>(`${server}/Users/${encodeURIComponent(handoff.userId)}`, 'GET', {
                'Authorization': authorization(handoff.token)
            }),
            xhrRequest<unknown>(`${server}/System/Info/Public`)
        ]);
        const session = createSsoSession({ ...handoff, server }, user, serverInfo);
        if (!session) throw new Error('The Jellyfin server returned an incomplete SSO session.');
        return session;
    }

    static async getPublicUsers(serverInput: string): Promise<PublicUser[]> {
        try {
            return publicUsers(await xhrRequest<unknown>(`${normalizeServer(serverInput)}/Users/Public`, 'GET', { 'Authorization': authorization() }));
        } catch (_error) {
            return [];
        }
    }

    static async forgotPassword(serverInput: string, username: string): Promise<ForgotPasswordResult> {
        return xhrRequest<ForgotPasswordResult>(`${normalizeServer(serverInput)}/Users/ForgotPassword`, 'POST', {
            'Content-Type': 'application/json', 'Authorization': authorization()
        }, JSON.stringify({ EnteredUsername: username }));
    }

    static async redeemPasswordPin(serverInput: string, pin: string): Promise<{ Success?: boolean; UsersReset?: string[] }> {
        try {
            return await xhrRequest<{ Success?: boolean; UsersReset?: string[] }>(`${normalizeServer(serverInput)}/Users/ForgotPassword/Pin`, 'POST', {
                'Content-Type': 'application/json', 'Authorization': authorization()
            }, JSON.stringify({ Pin: pin }));
        } catch (error) {
            if (error instanceof JellyfinRequestError && error.status === 404) return { Success: false };
            throw error;
        }
    }

    static async getBranding(serverInput: string): Promise<Branding> {
        try {
            return normalizeBranding(await xhrRequest<unknown>(`${normalizeServer(serverInput)}/Branding/Configuration`));
        } catch (_error) {
            return NO_BRANDING;
        }
    }

    static async isQuickConnectEnabled(serverInput: string): Promise<boolean> {
        const server = normalizeServer(serverInput);
        try {
            return await xhrRequest<boolean>(`${server}/QuickConnect/Enabled`);
        } catch (_error) {
            // Some deployments/proxies return 500 for this probe; fail closed.
            return false;
        }
    }

    static async getUserSession(session: Session): Promise<JellyfinUser> {
        return xhrRequest<JellyfinUser>(`${session.server}/Users/${encodeURIComponent(session.user.Id)}`, 'GET', {
            'Authorization': authorization(session.token)
        });
    }

    static async getUsers(session: Session): Promise<JellyfinUser[]> {
        return xhrRequest<JellyfinUser[]>(`${session.server}/Users`, 'GET', {
            'Authorization': authorization(session.token)
        });
    }

    static async authorizeQuickConnect(session: Session, code: string, userId = session.user.Id): Promise<boolean> {
        const params = queryString({ code: code.replace(/\s/g, ''), userId });
        return xhrRequest<boolean>(`${session.server}/QuickConnect/Authorize?${params}`, 'POST', {
            'Authorization': authorization(session.token)
        });
    }

    static async initiateQuickConnect(serverInput: string): Promise<{ secret: string; code: string }> {
        const server = normalizeServer(serverInput);
        const result = await xhrRequest<{ Secret?: string; Code?: string }>(
            `${server}/QuickConnect/Initiate`, 'POST', { 'Authorization': authorization() }
        );
        if (!result.Secret || !result.Code) throw new Error('The server returned an invalid Quick Connect challenge.');
        return { secret: result.Secret, code: result.Code };
    }

    static async isQuickConnectAuthenticated(serverInput: string, secret: string): Promise<boolean> {
        const server = normalizeServer(serverInput);
        const result = await xhrRequest<{ Authenticated?: boolean }>(
            `${server}/QuickConnect/Connect?${queryString({ secret })}`
        );
        return result.Authenticated === true;
    }

    private bulk<T>(path: string): Promise<T> {
        return this.request<T>(path, {}, false, 1);
    }

    private bulkItems(path: string): Promise<ItemResponse> {
        return this.request<unknown>(path, {}, false, 1).then(asItemResponse);
    }

    private requestItems(path: string, init: ApiRequestInit = {}, emptyOk = false, priority = 2): Promise<ItemResponse> {
        return this.request<unknown>(path, init, emptyOk, priority).then(asItemResponse);
    }

    async request<T>(path: string, init: ApiRequestInit = {}, emptyOk = false, priority = 2): Promise<T> {
        const headers: Record<string, string> = { 'Authorization': authorization(this.session.token) };
        if (init.body && !(typeof FormData !== 'undefined' && init.body instanceof FormData)) headers['Content-Type'] = 'application/json';
        if (init.headers) {
            Object.keys(init.headers).forEach(key => {
                const value = init.headers?.[key];
                if (value) headers[key] = value;
            });
        }
        try {
            return await xhrRequest<T>(`${this.session.server}${path}`, init.method || 'GET', headers, init.body, emptyOk, priority, init.signal);
        } catch (error) {
            this.handleRequestError(error);
        }
    }

    private handleRequestError(error: unknown): never {
        if (error instanceof JellyfinRequestError && error.status === 401) {
            if (!this.sessionExpired) {
                this.sessionExpired = true;
                this.onSessionExpired?.();
            }
            throw new JellyfinRequestError(401, 'Your session expired. Sign in again.');
        }
        throw error;
    }

    async requestText(path: string, priority = 1): Promise<string> {
        const headers = { 'Authorization': authorization(this.session.token) };
        try {
            const value = await xhrRequest<string>(`${this.session.server}${path}`, 'GET', headers, undefined, false, priority, undefined, 'text', 2 * 1024 * 1024);
            return typeof value === 'string' ? value : String(value);
        } catch (error) {
            this.handleRequestError(error);
        }
    }

    async getViews(): Promise<MediaItem[]> {
        const response = await this.bulkItems(`/UserViews?${queryString({ UserId: this.session.user.Id })}`);
        return response.Items || [];
    }

    /** Resume rows per media type: Video for Continue watching, Audio for listening, Book for reading. */
    async getResumeItems(mediaType: 'Video' | 'Audio' | 'Book' = 'Video'): Promise<MediaItem[]> {
        const userId = encodeURIComponent(this.session.user.Id);
        const response = await this.bulkItems(`/UserItems/Resume?UserId=${userId}&MediaTypes=${mediaType}&Limit=12&Fields=Overview,PrimaryImageAspectRatio,UserData,SeriesName,SeriesId,IndexNumber,ParentIndexNumber,ProductionYear`);
        return response.Items || [];
    }

    async getLatestItems(): Promise<MediaItem[]> {
        const userId = encodeURIComponent(this.session.user.Id);
        const response = await this.bulk<MediaItem[]>(`/Items/Latest?UserId=${userId}&Limit=16&Fields=Overview,PrimaryImageAspectRatio,UserData`);
        return response || [];
    }

    async getLatestInLibrary(parentId: string, limit = 16): Promise<MediaItem[]> {
        const response = await this.bulk<MediaItem[]>(`/Items/Latest?${queryString({ UserId: this.session.user.Id, ParentId: parentId, Limit: limit, Fields: 'Overview,PrimaryImageAspectRatio,UserData,ProductionYear,SeriesName' })}`);
        return Array.isArray(response) ? response : [];
    }

    /** One group of the global Favorites page. */
    async getFavorites(group: FavoriteGroup, limit = 24): Promise<{ items: MediaItem[]; total: number }> {
        const common = { UserId: this.session.user.Id, Limit: limit, SortBy: 'SortName', SortOrder: 'Ascending', Fields: 'PrimaryImageAspectRatio,UserData,ProductionYear,RunTimeTicks,SeriesName,IndexNumber,ParentIndexNumber' };
        const result = group.path
            ? await this.bulkItems(`${group.path}?${queryString({ ...common, IsFavorite: 'true' })}`)
            : await this.bulkItems(`/Items?${queryString({ ...common, Filters: 'IsFavorite', Recursive: 'true', IncludeItemTypes: group.types?.join(',') })}`);
        const items = group.path ? withEntityType(result.Items || [], group.path) : result.Items || [];
        return { items, total: result.TotalRecordCount ?? items.length };
    }

    /** People, artists, genres and studios matching a search term. */
    async searchEntities(section: EntitySearchSection, term: string, limit = 12): Promise<MediaItem[]> {
        const result = await this.requestItems(`${section.path}?${queryString({ UserId: this.session.user.Id, SearchTerm: term, Limit: limit, Fields: 'PrimaryImageAspectRatio', EnableImages: 'true', EnableTotalRecordCount: 'false' })}`);
        return withEntityType(result.Items || [], section.path);
    }

    async getNextUpItems(limit = 15): Promise<MediaItem[]> {
        const response = await this.bulkItems(`/Shows/NextUp?${queryString({
            UserId: this.session.user.Id,
            Limit: limit,
            Fields: 'Overview,PrimaryImageAspectRatio,ImageTags,BackdropImageTags,UserData,ProductionYear,SeriesName,SeriesId,SeasonId,IndexNumber,ParentIndexNumber,RunTimeTicks',
            EnableImages: 'true',
            ImageTypeLimit: 1,
            EnableImageTypes: 'Primary,Thumb,Backdrop',
            EnableUserData: 'true',
            EnableTotalRecordCount: 'false',
            EnableResumable: 'false'
        })}`);
        return response.Items || [];
    }

    async getRecentCollections(limit = 12): Promise<MediaItem[]> {
        const result = await this.bulkItems(`/Items?${queryString({
            UserId: this.session.user.Id,
            IncludeItemTypes: 'BoxSet',
            Recursive: 'true',
            SortBy: 'DateCreated',
            SortOrder: 'Descending',
            Limit: limit,
            EnableImages: 'true',
            ImageTypeLimit: 1,
            EnableImageTypes: 'Primary,Backdrop',
            Fields: 'Overview,PrimaryImageAspectRatio,ImageTags,BackdropImageTags,ChildCount,UserData,ProductionYear,CommunityRating,DateCreated'
        })}`);
        return result.Items || [];
    }

    async getHomeFeedPage(startIndex: number, limit = 24): Promise<ItemResponse> {
        return this.bulkItems(`/Items?${queryString({
            UserId: this.session.user.Id,
            IncludeItemTypes: 'Movie,Series',
            Recursive: 'true',
            StartIndex: startIndex,
            Limit: limit,
            SortBy: 'DateCreated,SortName',
            SortOrder: 'Descending,Ascending',
            EnableImages: 'true',
            EnableUserData: 'true',
            ImageTypeLimit: 1,
            EnableImageTypes: 'Primary,Backdrop',
            Fields: 'Overview,PrimaryImageAspectRatio,ImageTags,BackdropImageTags,UserData,ProductionYear,CommunityRating,DateCreated,RunTimeTicks,SeriesName,SeriesId,MediaStreams'
        })}`);
    }

    async getVaultCandidates(limit = 48): Promise<MediaItem[]> {
        const result = await this.bulkItems(`/Items?${queryString({
            UserId: this.session.user.Id,
            Recursive: 'true',
            IncludeItemTypes: 'Movie',
            Filters: 'IsUnplayed',
            MinCommunityRating: 8,
            SortBy: 'DateCreated',
            SortOrder: 'Ascending',
            Limit: limit,
            EnableImages: 'true',
            ImageTypeLimit: 1,
            EnableImageTypes: 'Primary,Backdrop',
            Fields: 'Overview,PrimaryImageAspectRatio,ImageTags,BackdropImageTags,UserData,ProductionYear,CommunityRating,DateCreated,RunTimeTicks'
        })}`);
        return result.Items || [];
    }

    async getRecommendations(): Promise<RecommendationGroup[]> {
        const query = queryString({
            UserId: this.session.user.Id,
            categoryLimit: 6,
            itemLimit: 12,
            Fields: 'Overview,PrimaryImageAspectRatio,CommunityRating,ProductionYear,RunTimeTicks,UserData',
            EnableImages: 'true',
            ImageTypeLimit: 1,
            EnableImageTypes: 'Primary,Backdrop,Logo'
        });
        return this.bulk<RecommendationGroup[]>(`/Movies/Recommendations?${query}`);
    }

    async getForYouRecommendations(itemType: 'Movie' | 'Series'): Promise<MediaItem[]> {
        const limit = 24;
        const ranked = await this.bulk<{ Items?: Array<{ ItemId?: string; Tier?: string; Score?: number }> }>(
            `/Pgsql/Taste/Recommendations?${queryString({
                UserId: this.session.user.Id,
                includeItemTypes: itemType,
                limit
            })}`
        );
        const ids = (ranked.Items || []).map(item => item.ItemId).filter((id): id is string => Boolean(id)).slice(0, limit);
        const tiers = new Map((ranked.Items || []).map(item => [ item.ItemId, item.Tier ]));
        if (!ids.length) return [];
        const result = await this.bulkItems(`/Items?${queryString({
            UserId: this.session.user.Id,
            Ids: ids.join(','),
            Limit: ids.length,
            Fields: 'Overview,PrimaryImageAspectRatio,CommunityRating,ProductionYear,RunTimeTicks,UserData',
            EnableImages: 'true',
            ImageTypeLimit: 1,
            EnableImageTypes: 'Primary,Backdrop,Logo'
        })}`);
        const byId = new Map((result.Items || []).filter(item => item.Id).map(item => [ item.Id, item ]));
        const ordered: MediaItem[] = [];
        ids.forEach(id => {
            const item = byId.get(id);
            if (item) ordered.push({ ...item, RecommendationType: itemType === 'Movie' ? 6 : 7, TasteTier: tiers.get(id) || undefined });
        });
        return ordered;
    }

    async getUser(): Promise<JellyfinUser> {
        const user = await this.request<JellyfinUser>('/Users/Me');
        if (!user?.Id || normalizeUserId(user.Id) !== normalizeUserId(this.session.user.Id)) {
            throw new JellyfinRequestError(401, 'Your session expired. Sign in again.');
        }
        return user;
    }

    async getUserConfiguration(): Promise<UserConfiguration> {
        const user = await this.getUser();
        return user.Configuration || {};
    }

    async updateUserConfiguration(configuration: UserConfiguration): Promise<void> {
        await this.request<void>(`/Users/Configuration?UserId=${encodeURIComponent(this.session.user.Id)}`, {
            method: 'POST', body: JSON.stringify(configuration)
        }, true);
        this.session.user.Configuration = configuration;
    }

    async changeOwnPassword(currentPassword: string, newPassword: string): Promise<void> {
        await this.request<void>(`/Users/Password?${new URLSearchParams({ userId: this.session.user.Id })}`, {
            method: 'POST', body: JSON.stringify({ CurrentPw: currentPassword, NewPw: newPassword })
        }, true);
    }

    async uploadOwnAvatar(base64: string, contentType: string): Promise<void> {
        await this.request<void>(`/UserImage?${new URLSearchParams({ userId: this.session.user.Id })}`, {
            method: 'POST', headers: { 'Content-Type': contentType }, body: base64
        }, true);
    }

    async deleteOwnAvatar(): Promise<void> {
        await this.request<void>(`/UserImage?${new URLSearchParams({ userId: this.session.user.Id })}`, { method: 'DELETE' }, true);
    }

    async getCultures(): Promise<Array<{ ThreeLetterISOLanguageName: string; DisplayName: string }>> {
        return this.request<Array<{ ThreeLetterISOLanguageName: string; DisplayName: string }>>('/Localization/Cultures');
    }

    async getTasteProfile(): Promise<TasteProfile> {
        return this.request<TasteProfile>(`/Pgsql/Taste/Users/${encodeURIComponent(this.session.user.Id)}`);
    }

    async getItems(parentId: string, startIndex = 0, search?: string, includeItemTypes?: string[], recursive = true, pageSize = 40, libraryOptions?: LibraryItemsOptions, priority = 1, genreIds?: string[]): Promise<ItemResponse> {
        const query = libraryOptions?.Query;
        const path = { items: '/Items', albumArtists: '/Artists/AlbumArtists', artists: '/Artists', upcoming: '/Shows/Upcoming' }[libraryOptions?.Source || 'items'];
        return this.requestItems(`${path}?${queryString({
            UserId: this.session.user.Id,
            Recursive: String(recursive),
            ParentId: parentId || undefined,
            SearchTerm: search || undefined,
            GenreIds: genreIds?.length ? genreIds.join(',') : undefined,
            IncludeItemTypes: includeItemTypes?.join(','),
            ...(libraryOptions ? mapLibraryQuery(query!, { ...libraryOptions, StartIndex: startIndex, Limit: libraryOptions.Limit ?? pageSize, IncludeItemTypes: includeItemTypes, Recursive: recursive }) : {
                Limit: pageSize,
                StartIndex: startIndex,
                Fields: 'Overview,PrimaryImageAspectRatio,UserData,CommunityRating,ProductionYear,RunTimeTicks,IndexNumber,ParentIndexNumber,SeriesId,SeasonId,ChannelName',
                SortBy: 'SortName',
                SortOrder: 'Ascending'
            })
        })}`, { signal: libraryOptions?.Signal }, false, search ? 2 : priority);
    }

    /** Tags and official ratings present in a library, for its filter panel. */
    async getLibraryFilters(parentId: string, includeItemTypes?: string[]): Promise<{ tags: string[]; ratings: string[] }> {
        const result = await this.bulk<{ Tags?: string[]; OfficialRatings?: string[] }>(`/Items/Filters?${queryString({ UserId: this.session.user.Id, ParentId: parentId || undefined, IncludeItemTypes: includeItemTypes?.join(',') })}`);
        const clean = (values?: string[]) => Array.from(new Set((values || []).filter(value => typeof value === 'string' && value.trim()))).sort((a, b) => a.localeCompare(b)).slice(0, 200);
        return { tags: clean(result?.Tags), ratings: clean(result?.OfficialRatings) };
    }

    /** Library-local suggestion rows: Continue watching, Next up (TV), Latest and Because-you-watched groups (movies). */
    async getLibrarySuggestions(library: Pick<MediaItem, 'Id' | 'CollectionType'>): Promise<Array<{ title: string; items: MediaItem[] }>> {
        const userId = this.session.user.Id;
        const fields = 'Overview,PrimaryImageAspectRatio,UserData,ProductionYear,RunTimeTicks,SeriesName,SeriesId,IndexNumber,ParentIndexNumber';
        const tv = library.CollectionType?.toLowerCase() === 'tvshows';
        const settle = <T,>(promise: Promise<T>, fallback: T) => promise.catch(() => fallback);
        if (library.CollectionType?.toLowerCase() === 'music') {
            const songs = (sortBy: string) => settle(this.bulkItems(`/Items?${queryString({ UserId: userId, ParentId: library.Id, IncludeItemTypes: 'Audio', Recursive: 'true', Filters: 'IsPlayed', SortBy: sortBy, SortOrder: 'Descending', Limit: 12, Fields: 'PrimaryImageAspectRatio,UserData,AlbumArtists,ArtistItems,Album,AlbumId' })}`).then(result => result.Items || []), [] as MediaItem[]);
            const [ latestAlbums, recent, frequent, favorites ] = await Promise.all([
                settle(this.bulk<MediaItem[]>(`/Items/Latest?${queryString({ UserId: userId, ParentId: library.Id, IncludeItemTypes: 'Audio', Limit: 16, Fields: 'PrimaryImageAspectRatio,UserData' })}`).then(result => Array.isArray(result) ? result : []), [] as MediaItem[]),
                songs('DatePlayed'),
                songs('PlayCount'),
                settle(this.bulkItems(`/Items?${queryString({ UserId: userId, ParentId: library.Id, IncludeItemTypes: 'MusicAlbum', Recursive: 'true', Filters: 'IsFavorite', SortBy: 'Random', Limit: 12, Fields: 'PrimaryImageAspectRatio,UserData' })}`).then(result => result.Items || []), [] as MediaItem[]),
            ]);
            return [
                { title: 'Latest albums', items: latestAlbums },
                { title: 'Recently played', items: recent },
                { title: 'Frequently played', items: frequent },
                { title: 'Favorite albums', items: favorites },
            ].filter(row => row.items.length > 0);
        }
        const [ resume, nextUp, latest, groups ] = await Promise.all([
            settle(this.bulkItems(`/UserItems/Resume?${queryString({ UserId: userId, ParentId: library.Id, Limit: 12, Fields: fields })}`).then(result => result.Items || []), [] as MediaItem[]),
            tv ? settle(this.bulkItems(`/Shows/NextUp?${queryString({ UserId: userId, ParentId: library.Id, Limit: 12, Fields: fields, EnableResumable: 'false', EnableTotalRecordCount: 'false' })}`).then(result => result.Items || []), [] as MediaItem[]) : Promise.resolve([] as MediaItem[]),
            settle(this.bulk<MediaItem[]>(`/Items/Latest?${queryString({ UserId: userId, ParentId: library.Id, Limit: 16, Fields: fields })}`).then(result => Array.isArray(result) ? result : []), [] as MediaItem[]),
            tv ? Promise.resolve([] as RecommendationGroup[]) : settle(this.bulk<RecommendationGroup[]>(`/Movies/Recommendations?${queryString({ UserId: userId, ParentId: library.Id, categoryLimit: 3, itemLimit: 12, Fields: fields })}`).then(result => Array.isArray(result) ? result : []), [] as RecommendationGroup[]),
        ]);
        const rows = [
            { title: 'Continue watching', items: resume },
            { title: 'Next up', items: nextUp },
            { title: 'Latest', items: latest },
            ...groups.map(group => ({ title: recommendationTitle(group), items: group.Items || [] })),
        ];
        return rows.filter(row => row.items.length > 0);
    }

    async getGenres(parentId: string): Promise<Array<{ Name?: string; Id?: string }>> {
        const result = await this.bulk<{ Items?: Array<{ Name?: string; Id?: string }> }>(`/Genres?${queryString({ UserId: this.session.user.Id, ParentId: parentId || undefined, Recursive: 'true', Limit: 1000, SortBy: 'SortName' })}`);
        return result.Items || [];
    }

    async getYears(parentId: string): Promise<number[]> {
        const result = await this.bulk<{ Items?: Array<{ Name?: string; Id?: string }> }>(`/Years?${queryString({ UserId: this.session.user.Id, ParentId: parentId || undefined, Recursive: 'true', Limit: 1000, SortBy: 'SortName' })}`);
        return (result.Items || []).map(item => Number(item.Name)).filter(year => Number.isFinite(year) && year > 1800).sort((a, b) => a - b);
    }

    async getSeasons(seriesId: string): Promise<ItemResponse> {
        return this.bulkItems(`/Shows/${encodeURIComponent(seriesId)}/Seasons?${queryString({
            UserId: this.session.user.Id,
            Fields: 'Overview,PrimaryImageAspectRatio,UserData,CommunityRating,ProductionYear,IndexNumber,ParentId,ChildCount,CumulativeRunTimeTicks,PremiereDate,EndDate',
            EnableImages: 'true',
            EnableUserData: 'true'
        })}`);
    }

    async getEpisodes(seriesId: string, seasonId: string): Promise<ItemResponse> {
        return this.bulkItems(`/Shows/${encodeURIComponent(seriesId)}/Episodes?${queryString({
            UserId: this.session.user.Id,
            SeasonId: seasonId,
            Fields: 'Overview,PrimaryImageAspectRatio,UserData,CommunityRating,ProductionYear,IndexNumber,ParentIndexNumber,RunTimeTicks',
            EnableImages: 'true',
            EnableUserData: 'true',
            SortBy: 'IndexNumber'
        })}`);
    }

    async getAllSeasonEpisodes(seriesId: string, seasonId: string): Promise<MediaItem[]> {
        const pageSize = 100;
        const allEpisodes: MediaItem[] = [];
        let startIndex = 0;
        let totalRecordCount = Number.POSITIVE_INFINITY;
        while (startIndex < totalRecordCount && startIndex < MAX_EPISODES) {
            const response = await this.bulkItems(`/Shows/${encodeURIComponent(seriesId)}/Episodes?${queryString({
                UserId: this.session.user.Id,
                SeasonId: seasonId,
                StartIndex: startIndex,
                Limit: pageSize,
                Fields: 'Overview,PrimaryImageAspectRatio,UserData,CommunityRating,ProductionYear,IndexNumber,ParentIndexNumber,RunTimeTicks,PremiereDate',
                EnableImages: 'true',
                ImageTypeLimit: 1,
                EnableImageTypes: 'Primary,Backdrop,Thumb',
                EnableUserData: 'true',
                SortBy: 'IndexNumber'
            })}`);
            const page = response.Items || [];
            allEpisodes.push(...page);
            totalRecordCount = response.TotalRecordCount || allEpisodes.length;
            if (!page.length) break;
            startIndex += page.length;
        }
        return allEpisodes;
    }

    async getSeriesEpisodes(seriesId: string): Promise<MediaItem[]> {
        const pageSize = 100;
        const episodes: MediaItem[] = [];
        let startIndex = 0;
        let total = Number.POSITIVE_INFINITY;
        while (startIndex < total && startIndex < MAX_EPISODES) {
            const response = await this.bulkItems(`/Shows/${encodeURIComponent(seriesId)}/Episodes?${queryString({
                UserId: this.session.user.Id,
                StartIndex: startIndex,
                Limit: pageSize,
                Fields: 'SeriesName,IndexNumber,ParentIndexNumber,RunTimeTicks,UserData,ImageTags,PremiereDate',
                EnableImages: 'true',
                ImageTypeLimit: 1,
                EnableImageTypes: 'Primary',
                EnableUserData: 'true',
                SortBy: 'ParentIndexNumber,IndexNumber'
            })}`);
            const page = response.Items || [];
            page.forEach(item => { item.Type = item.Type || 'Episode'; item.SeriesId = item.SeriesId || seriesId; });
            episodes.push(...page);
            total = response.TotalRecordCount || episodes.length;
            if (!page.length) break;
            startIndex += page.length;
        }
        return episodes;
    }

    async getTrickplay(itemId: string): Promise<Record<string, Record<string, TrickplayLevel>>> {
        const item = await this.bulk<{ Trickplay?: Record<string, Record<string, TrickplayLevel>> }>(
            `/Users/${encodeURIComponent(this.session.user.Id)}/Items/${encodeURIComponent(itemId)}?Fields=Trickplay`
        );
        return item.Trickplay || {};
    }

    async getMediaSegments(itemId: string): Promise<Array<{ Type?: string | number; StartTicks?: number; EndTicks?: number }>> {
        const result = await this.bulk<{ Items?: Array<{ Type?: string | number; StartTicks?: number; EndTicks?: number }> }>(
            `/MediaSegments/${encodeURIComponent(itemId)}`
        );
        return result.Items || [];
    }

    subtitleUrl(itemId: string, mediaSourceId: string, index: number): string {
        return `${this.session.server}/Videos/${encodeURIComponent(itemId)}/${encodeURIComponent(mediaSourceId)}/Subtitles/${index}/Stream.vtt?${queryString({ ApiKey: this.session.token })}`;
    }

    trickplayTileUrl(itemId: string, width: number, index: number, mediaSourceId?: string): string {
        return `${this.session.server}/Videos/${encodeURIComponent(itemId)}/Trickplay/${width}/${index}.jpg?${queryString({ MediaSourceId: mediaSourceId, ApiKey: this.session.token })}`;
    }

    async getItem(id: string): Promise<MediaItem> {
        return this.request<unknown>(`/Users/${encodeURIComponent(this.session.user.Id)}/Items/${encodeURIComponent(id)}?Fields=Overview,CommunityRating,ProductionYear,RunTimeTicks,UserData,BackdropImageTags,ImageTags,ChildCount,PremiereDate,EndDate,SeriesName,SeriesId,IndexNumber,ParentIndexNumber,People,ExternalUrls,Genres,Studios,Tags,Taglines,MediaSources,MediaStreams,CanDelete,CanDownload,OfficialRating,CriticRating,LocalTrailerCount,SpecialFeatureCount,PartCount,AlbumArtists,ArtistItems`).then(asMediaItem);
    }

    async getChapters(id: string): Promise<Array<{ StartPositionTicks?: number; Name?: string; ImageTag?: string }>> {
        const item = await this.request<{ Chapters?: Array<{ StartPositionTicks?: number; Name?: string; ImageTag?: string }> }>(
            `/Users/${encodeURIComponent(this.session.user.Id)}/Items/${encodeURIComponent(id)}?Fields=Chapters`, {}, false, 1
        );
        return Array.isArray(item.Chapters) ? item.Chapters : [];
    }

    chapterImageUrl(itemId: string, index: number, tag: string, width = 320): string {
        return `${this.session.server}/Items/${encodeURIComponent(itemId)}/Images/Chapter/${index}?${queryString({ tag, maxWidth: String(width), quality: '80' })}`;
    }

    private detailList(path: string, extra: Record<string, string | number | undefined> = {}): Promise<MediaItem[]> {
        return this.request<unknown>(`${path}${path.includes('?') ? '&' : '?'}${queryString({ UserId: this.session.user.Id, Fields: 'PrimaryImageAspectRatio,UserData,ProductionYear,RunTimeTicks,IndexNumber,ParentIndexNumber,SeriesName,ImageTags,CanDelete,CanDownload,ExtraType', ...extra })}`, {}, false, 1)
            .then(value => Array.isArray(value) ? asItemResponse({ Items: value }).Items : asItemResponse(value).Items);
    }

    getSimilarItems(id: string, limit = 12): Promise<MediaItem[]> {
        return this.detailList(`/Items/${encodeURIComponent(id)}/Similar`, { Limit: limit });
    }

    getItemCollections(id: string): Promise<MediaItem[]> {
        return this.detailList(`/Items/${encodeURIComponent(id)}/Collections`, { Limit: 24 });
    }

    getLocalTrailers(id: string): Promise<MediaItem[]> {
        return this.detailList(`/Items/${encodeURIComponent(id)}/LocalTrailers`);
    }

    getSpecialFeatures(id: string): Promise<MediaItem[]> {
        return this.detailList(`/Items/${encodeURIComponent(id)}/SpecialFeatures`);
    }

    getAdditionalParts(id: string): Promise<MediaItem[]> {
        return this.detailList(`/Videos/${encodeURIComponent(id)}/AdditionalParts`);
    }

    /** Direct children in server order (album tracks by disc/track, photos by name). */
    getChildren(parentId: string, sortBy = 'ParentIndexNumber,IndexNumber,SortName', limit = 500): Promise<MediaItem[]> {
        return this.detailList('/Items', { ParentId: parentId, SortBy: sortBy, SortOrder: 'Ascending', Limit: limit, Fields: 'PrimaryImageAspectRatio,UserData,ProductionYear,RunTimeTicks,IndexNumber,ParentIndexNumber,SeriesName,ImageTags,CanDelete,CanDownload,ExtraType,ArtistItems,AlbumArtists,Width,Height,Tags' });
    }

    /** Playlist entries keep their PlaylistItemId so repeated titles stay distinct. */
    getPlaylistEntries(playlistId: string, limit = 500): Promise<MediaItem[]> {
        return this.detailList(`/Playlists/${encodeURIComponent(playlistId)}/Items`, { Limit: limit });
    }

    async deleteItem(id: string): Promise<void> {
        await this.request<void>(`/Items/${encodeURIComponent(id)}`, { method: 'DELETE' }, true);
    }

    getCollections(): Promise<MediaItem[]> {
        return this.detailList('/Items', { IncludeItemTypes: 'BoxSet', Recursive: 'true', SortBy: 'SortName', Limit: 200 });
    }

    async createCollection(name: string, itemIds: string[]): Promise<{ Id?: string }> {
        return this.request<{ Id?: string }>(`/Collections?${queryString({ name, ids: itemIds.join(',') })}`, { method: 'POST' });
    }

    async addToCollection(collectionId: string, itemIds: string[]): Promise<void> {
        await this.request<void>(`/Collections/${encodeURIComponent(collectionId)}/Items?${queryString({ ids: itemIds.join(',') })}`, { method: 'POST' }, true);
    }

    async removeFromCollection(collectionId: string, itemIds: string[]): Promise<void> {
        await this.request<void>(`/Collections/${encodeURIComponent(collectionId)}/Items?${queryString({ ids: itemIds.join(',') })}`, { method: 'DELETE' }, true);
    }

    async getLyrics(id: string): Promise<Array<{ Text?: string; Start?: number }>> {
        const result = await this.request<{ Lyrics?: Array<{ Text?: string; Start?: number }> }>(`/Audio/${encodeURIComponent(id)}/Lyrics`, {}, false, 1);
        return Array.isArray(result?.Lyrics) ? result.Lyrics : [];
    }

    downloadUrl(id: string): string {
        return `${this.session.server}/Items/${encodeURIComponent(id)}/Download?${queryString({ ApiKey: this.session.token })}`;
    }

    async getItemPeople(id: string, signal: AbortSignal): Promise<Array<{ Name?: string; Type?: string }>> {
        const item = await this.request<{ People?: Array<{ Name?: string; Type?: string }> }>(
            `/Users/${encodeURIComponent(this.session.user.Id)}/Items/${encodeURIComponent(id)}?Fields=People`,
            { signal }, false, 0
        );
        return item.People || [];
    }

    async getGuideInfo(): Promise<GuideInfo> {
        return this.bulk<GuideInfo>('/LiveTv/GuideInfo');
    }

    async getLiveChannels(startIndex = 0, limit = 30, filter: LiveChannelFilter = 'all'): Promise<ItemResponse> {
        return this.bulkItems(`/LiveTv/Channels?${queryString({
            UserId: this.session.user.Id,
            StartIndex: startIndex,
            Limit: limit,
            EnableFavoriteSorting: 'true',
            AddCurrentProgram: 'true',
            EnableImages: 'true',
            EnableUserData: 'true',
            ImageTypeLimit: 1,
            EnableImageTypes: 'Primary,Logo,Thumb',
            Fields: 'Overview,ChannelInfo',
            IsFavorite: filter === 'favorites' ? 'true' : undefined,
            IsSports: filter === 'sports' ? 'true' : undefined,
            IsNews: filter === 'news' ? 'true' : undefined,
            IsMovie: filter === 'movies' ? 'true' : undefined,
            IsKids: filter === 'kids' ? 'true' : undefined
        })}`);
    }

    async getAiringPrograms(limit = 80, startIndex = 0): Promise<ItemResponse> {
        return this.bulkItems(`/LiveTv/Programs?${queryString({
            UserId: this.session.user.Id,
            IsAiring: 'true',
            StartIndex: startIndex,
            Limit: limit,
            EnableTotalRecordCount: 'true',
            EnableImages: 'true',
            EnableUserData: 'true',
            ImageTypeLimit: 1,
            EnableImageTypes: 'Primary,Thumb,Backdrop',
            Fields: 'Overview,ChannelInfo,MediaStreams',
            SortBy: 'StartDate',
            SortOrder: 'Ascending'
        })}`);
    }

    async getLivePrograms(channelIds: string[], minStart: string, maxEnd: string, limit = 500): Promise<ItemResponse> {
        return this.bulkItems(`/LiveTv/Programs?${queryString({
            UserId: this.session.user.Id,
            ChannelIds: channelIds.length ? channelIds.join(',') : undefined,
            MinEndDate: minStart,
            MaxStartDate: maxEnd,
            Limit: limit,
            EnableTotalRecordCount: 'false',
            EnableImages: 'true',
            EnableUserData: 'true',
            ImageTypeLimit: 1,
            EnableImageTypes: 'Primary,Thumb,Backdrop',
            Fields: 'Overview,ChannelInfo,MediaStreams',
            SortBy: 'StartDate',
            SortOrder: 'Ascending'
        })}`);
    }

    async getLiveTimers(): Promise<LiveTimer[]> {
        const result = await this.bulk<{ Items?: LiveTimer[] }>(`/LiveTv/Timers?${queryString({ IsScheduled: 'true' })}`);
        return result.Items || [];
    }

    async getSeriesTimers(): Promise<LiveTimer[]> {
        const result = await this.bulk<{ Items?: LiveTimer[] }>('/LiveTv/SeriesTimers');
        return result.Items || [];
    }

    async getRecordings(startIndex = 0, limit = 40): Promise<ItemResponse> {
        return this.bulkItems(`/LiveTv/Recordings?${queryString({
            UserId: this.session.user.Id,
            StartIndex: startIndex,
            Limit: limit,
            EnableImages: 'true',
            EnableUserData: 'true',
            Fields: 'Overview'
        })}`);
    }

    /** Resolves with the server's updated user data when it returns one (Jellyfin answers with UserItemDataDto). */
    async setFavorite(itemId: string, favorite: boolean): Promise<MediaItem['UserData'] | null> {
        const path = `/Users/${encodeURIComponent(this.session.user.Id)}/FavoriteItems/${encodeURIComponent(itemId)}`;
        const result = await this.request<MediaItem['UserData'] | undefined>(path, { method: favorite ? 'POST' : 'DELETE' }, true);
        return result && typeof result === 'object' ? result : null;
    }

    async setPlayed(itemId: string, played: boolean): Promise<MediaItem['UserData'] | null> {
        const path = `/Users/${encodeURIComponent(this.session.user.Id)}/PlayedItems/${encodeURIComponent(itemId)}`;
        const result = await this.request<MediaItem['UserData'] | undefined>(path, { method: played ? 'POST' : 'DELETE' }, true);
        return result && typeof result === 'object' ? result : null;
    }

    async getRelatedItems(entity: Record<string, string>, startIndex = 0, limit = 40): Promise<ItemResponse> {
        return this.requestItems(`/Items?${queryString({
            UserId: this.session.user.Id,
            Recursive: 'true',
            IncludeItemTypes: 'Movie,Series,Episode,MusicVideo,Video,MusicAlbum,Audio,Book',
            StartIndex: startIndex,
            Limit: limit,
            SortBy: 'SortName',
            SortOrder: 'Ascending',
            Fields: 'PrimaryImageAspectRatio,UserData,ProductionYear,SeriesName,IndexNumber,ParentIndexNumber',
            ...entity
        })}`);
    }

    async getAdjacentEpisodes(seriesId: string, episodeId: string): Promise<MediaItem[]> {
        const result = await this.requestItems(`/Shows/${encodeURIComponent(seriesId)}/Episodes?${queryString({
            UserId: this.session.user.Id,
            AdjacentTo: episodeId,
            Fields: 'UserData,IndexNumber,ParentIndexNumber,SeriesName,SeasonId,RunTimeTicks',
            EnableImages: 'true',
            ImageTypeLimit: 1
        })}`);
        return result.Items || [];
    }

    async createLiveTimer(programId: string, series: boolean): Promise<void> {
        let body: Record<string, unknown> = { ProgramId: programId };
        try {
            const defaults = await this.request<Record<string, unknown>>(`/LiveTv/Timers/Defaults?${queryString({ programId })}`);
            body = { ...defaults, ProgramId: programId };
            delete body.Id;
        } catch (_error) { /* ProgramId alone still schedules when the server can fill in the program. */ }
        await this.request(series ? '/LiveTv/SeriesTimers' : '/LiveTv/Timers', { method: 'POST', body: JSON.stringify(body) }, true);
    }

    async cancelLiveTimer(timerId: string): Promise<void> {
        await this.request(`/LiveTv/Timers/${encodeURIComponent(timerId)}`, { method: 'DELETE' }, true);
    }

    async getLiveTimer(timerId: string): Promise<LiveTimer> {
        return this.request<LiveTimer>(`/LiveTv/Timers/${encodeURIComponent(timerId)}`);
    }

    async getSeriesTimer(timerId: string): Promise<LiveTimer> {
        return this.request<LiveTimer>(`/LiveTv/SeriesTimers/${encodeURIComponent(timerId)}`);
    }

    async updateLiveTimer(timer: LiveTimer): Promise<void> {
        await this.request(`/LiveTv/Timers/${encodeURIComponent(timer.Id)}`, { method: 'POST', body: JSON.stringify(timer) }, true);
    }

    async updateSeriesTimer(timer: LiveTimer): Promise<void> {
        await this.request(`/LiveTv/SeriesTimers/${encodeURIComponent(timer.Id)}`, { method: 'POST', body: JSON.stringify(timer) }, true);
    }

    async cancelSeriesTimer(timerId: string): Promise<void> {
        await this.request(`/LiveTv/SeriesTimers/${encodeURIComponent(timerId)}`, { method: 'DELETE' }, true);
    }

    async deleteRecording(recordingId: string): Promise<void> {
        await this.request(`/LiveTv/Recordings/${encodeURIComponent(recordingId)}`, { method: 'DELETE' }, true);
    }

    imageUrl(item: MediaItem, type = 'Primary', width = 420, quality = 90): string {
        const imageType = item.ImageTags?.[type] ? type : item.BackdropImageTags?.length ? 'Backdrop' : type;
        const tag = item.ImageTags?.[imageType] || item.BackdropImageTags?.[0];
        if (!tag) return '';
        return `${this.session.server}/Items/${encodeURIComponent(item.Id)}/Images/${imageType}?${queryString({ tag, quality, maxWidth: width })}`;
    }

    async loadImage(item: MediaItem, type = 'Primary', width = 420, quality = 90, bag?: ImageCancel): Promise<string> {
        const url = this.imageUrl(item, type, width, quality);
        if (!url) return '';
        const cached = imageCache.get(url);
        if (cached) {
            imageCache.delete(url);
            imageCache.set(url, cached);
            return cached.objectUrl;
        }
        let job = imageJobs.get(url);
        if (!job) {
            let resolveJob: (value: string) => void = () => undefined;
            const promise = new Promise<string>(resolve => { resolveJob = resolve; });
            const created: ImageJob = { promise, waiters: 0, settled: false, cancel: () => undefined };
            const finishJob = (value: string) => {
                if (created.settled) return;
                created.settled = true;
                imageJobs.delete(url);
                resolveJob(value);
            };
            const handle = enqueueRequest(0, (finish, registerAbort) => {
                const complete = (value: string) => {
                    finish();
                    finishJob(value);
                };
                try {
                    const xhr = new XMLHttpRequest();
                    registerAbort(() => xhr.abort());
                    xhr.open('GET', url, true);
                    xhr.responseType = 'blob';
                    xhr.setRequestHeader('Authorization', authorization(this.session.token));
                    xhr.timeout = 10000;
                    xhr.onload = () => {
                        try {
                            if (xhr.responseURL && new URL(xhr.responseURL).origin !== new URL(url).origin) {
                                complete('');
                                return;
                            }
                            let objectUrl = '';
                            try {
                                if (xhr.status >= 200 && xhr.status < 300 && xhr.response) objectUrl = rememberImage(url, URL.createObjectURL(xhr.response));
                            } catch (_error) { objectUrl = ''; }
                            complete(objectUrl);
                        } catch (_error) {
                            complete('');
                        }
                    };
                    xhr.onerror = () => complete('');
                    xhr.ontimeout = () => complete('');
                    xhr.onabort = () => complete('');
                    xhr.send();
                } catch (_error) {
                    complete('');
                }
            }, () => finishJob(''));
            created.cancel = () => {
                if (created.settled) return;
                if (handle.cancel() === 'queued') finishJob('');
            };
            job = created;
            imageJobs.set(url, job);
        }
        const activeJob = job;
        activeJob.waiters += 1;
        let released = false;
        const release = () => {
            if (released || activeJob.settled) return;
            released = true;
            activeJob.waiters -= 1;
            if (activeJob.waiters <= 0) activeJob.cancel();
        };
        if (bag) bag.cancel = release;
        return activeJob.promise;
    }

    async logout(): Promise<void> {
        clearImageCache();
        await new Promise<void>(resolve => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', `${this.session.server}/Sessions/Logout`, true);
            xhr.setRequestHeader('Authorization', authorization(this.session.token));
            xhr.onload = () => resolve();
            xhr.onerror = () => resolve();
            xhr.ontimeout = () => resolve();
            xhr.timeout = 5000;
            xhr.send(null);
        });
    }

    async play(item: MediaItem, options: PlaybackOptions = {}): Promise<PlaybackChoice> {
        const preferences = loadPlaybackPreferences();
        const profile = buildDeviceProfile(browserCapabilities(), preferences);
        const maxBitrate = options.maxBitrate ?? (preferences.maxBitrate || undefined);
        const startTicks = Math.max(0, Math.round(options.startTicks || 0));
        const request = {
            UserId: this.session.user.Id,
            DeviceProfile: maxBitrate ? { ...profile, MaxStreamingBitrate: maxBitrate } : profile,
            MaxStreamingBitrate: maxBitrate,
            StartTimeTicks: startTicks || undefined,
            AudioStreamIndex: options.audioStreamIndex ?? undefined,
            SubtitleStreamIndex: options.subtitleStreamIndex ?? undefined,
            MediaSourceId: options.mediaSourceId,
            LiveStreamId: options.liveStreamId,
            IsPlayback: true,
            AutoOpenLiveStream: true,
            EnableDirectPlay: !options.forceTranscode,
            EnableDirectStream: !options.forceTranscode,
            EnableTranscoding: true,
            AllowVideoStreamCopy: !options.forceTranscode,
            AllowAudioStreamCopy: !options.forceTranscode
        };
        const result = await this.request<{ MediaSources?: PlaybackMediaSource[]; PlaySessionId?: string; ErrorCode?: string }>(
            `/Items/${encodeURIComponent(item.Id)}/PlaybackInfo`,
            { method: 'POST', body: JSON.stringify(request) }
        );
        if (result.ErrorCode) throw new Error(`The server refused playback (${result.ErrorCode}).`);
        const versions = mediaVersions(result.MediaSources);
        const wantedSource = options.mediaSourceId || preferredVersionId(item.SeriesId, versions);
        let source = (wantedSource && result.MediaSources?.find(candidate => candidate.Id === wantedSource)) || result.MediaSources?.[0];
        if (!source) throw new Error('No playable media source was returned.');
        try {
            if (source.RequiresOpening && !source.LiveStreamId) {
                const opened = await this.request<{ MediaSource?: PlaybackMediaSource }>(`/LiveStreams/Open`, {
                    method: 'POST',
                    body: JSON.stringify({ ...request, OpenToken: source.OpenToken, PlaySessionId: result.PlaySessionId, ItemId: item.Id })
                });
                if (!opened.MediaSource) throw new Error('The tuner did not open a live stream.');
                source = opened.MediaSource;
            }
            const nullableIndex = (value: number | null | undefined) => value === undefined || value === null || value < 0 ? null : value;
            const choice = {
                mediaSourceId: source.Id,
                playSessionId: result.PlaySessionId,
                bitrate: source.Bitrate,
                streams: source.MediaStreams || [],
                audioStreamIndex: nullableIndex(options.audioStreamIndex ?? source.DefaultAudioStreamIndex),
                subtitleStreamIndex: options.subtitleStreamIndex === -1 ? null : nullableIndex(options.subtitleStreamIndex ?? source.DefaultSubtitleStreamIndex),
                liveStreamId: source.LiveStreamId || undefined,
                isLive: Boolean(source.IsInfiniteStream || source.LiveStreamId || item.Type === 'TvChannel'),
                maxBitrate,
                versions: versions.length > 1 ? versions : undefined
            };
            const directPlay = source.SupportsDirectPlay !== false && !options.forceTranscode;
            if (!directPlay && !source.TranscodingUrl) {
                throw new Error('The server could not prepare a stream this browser can play.');
            }
            if (!directPlay && source.TranscodingUrl) {
                const serverUrl = new URL(this.session.server);
                const transcodeUrl = /^https?:\/\//i.test(source.TranscodingUrl)
                    ? new URL(source.TranscodingUrl)
                    : new URL(`${serverUrl.origin}${serverUrl.pathname.replace(/\/$/, '')}${source.TranscodingUrl.startsWith('/') ? source.TranscodingUrl : `/${source.TranscodingUrl}`}`);
                if (transcodeUrl.origin !== serverUrl.origin) {
                    throw new Error('The server returned a playback URL on another origin.');
                }
                const url = transcodeUrl.toString();
                const reasons = transcodeReasonsFromUrl(url);
                return {
                    ...choice,
                    ...startPlan(url, false, isHlsUrl(url), startTicks),
                    url,
                    direct: false,
                    method: 'Transcode',
                    transcodeReasons: reasons.length ? reasons : source.TranscodeReasons
                };
            }
            const query = queryString({
                Static: 'true',
                MediaSourceId: source.Id,
                PlaySessionId: result.PlaySessionId,
                LiveStreamId: source.LiveStreamId
            });
            const url = `${this.session.server}/Videos/${encodeURIComponent(item.Id)}/stream?${query}&ApiKey=${encodeURIComponent(this.session.token)}`;
            return { ...choice, ...startPlan(url, true, false, startTicks), url, direct: true, method: 'DirectPlay', transcodeReasons: source.TranscodeReasons };
        } catch (cause) {
            await this.releasePlayback({ liveStreamId: source.LiveStreamId, playSessionId: result.PlaySessionId }, options.liveStreamId);
            throw cause;
        }
    }

    /** Reads this device's own session, the authoritative record of what the server is actually doing. */
    async getPlaybackDiagnostics(): Promise<SessionTranscodingInfo | null> {
        const sessions = await this.request<Array<{ DeviceId?: string; TranscodingInfo?: SessionTranscodingInfo }>>(
            `/Sessions?${queryString({ DeviceId: deviceId() })}`
        );
        return sessions.find(entry => entry.DeviceId === deviceId())?.TranscodingInfo || null;
    }

    /** Resolves true only once the server acknowledged the report; never rejects so playback is unaffected. */
    reportPlaybackStart(report: PlaybackReport): Promise<boolean> {
        return this.postPlayback('/Sessions/Playing', report);
    }

    reportPlaybackProgress(report: PlaybackReport): Promise<boolean> {
        return this.postPlayback('/Sessions/Playing/Progress', report);
    }

    reportPlaybackStopped(report: PlaybackReport, keepalive = false): Promise<boolean> {
        const payload = JSON.stringify(report);
        if (keepalive && typeof fetch === 'function') {
            return fetch(`${this.session.server}/Sessions/Playing/Stopped`, {
                method: 'POST',
                headers: {
                    'Authorization': authorization(this.session.token),
                    'Content-Type': 'application/json'
                },
                body: payload,
                keepalive: true
            }).then(response => response.ok).catch(() => false);
        }
        return this.postPlayback('/Sessions/Playing/Stopped', report);
    }

    private postPlayback(path: string, report: PlaybackReport): Promise<boolean> {
        const delivery = this.reportTail.then(() =>
            this.request<void>(path, { method: 'POST', body: JSON.stringify(report) }, true, 1).then(() => true, () => false));
        this.reportTail = delivery;
        return delivery;
    }

    /** Release negotiated media that was never adopted by a player. */
    async releasePlayback(choice: Pick<PlaybackChoice, 'liveStreamId' | 'playSessionId'>, retainedLiveStreamId?: string): Promise<void> {
        if (choice.liveStreamId && choice.liveStreamId !== retainedLiveStreamId) await this.closeLiveStream(choice.liveStreamId);
        if (choice.playSessionId) {
            await this.request<void>(`/Videos/ActiveEncodings?${queryString({ DeviceId: deviceId(), PlaySessionId: choice.playSessionId })}`, { method: 'DELETE' }, true)
                .catch(() => undefined);
        }
    }

    /**
     * Best-effort tuner cleanup when a playback stop report cannot be delivered.
     * Successful stops already carry LiveStreamId and let the server close the
     * stream, so callers must claim ownership before using this fallback.
     */
    async closeLiveStream(liveStreamId: string): Promise<boolean> {
        if (!liveStreamId) return false;
        try {
            await this.request<void>(`/LiveStreams/Close?${queryString({ liveStreamId })}`, { method: 'POST' }, true);
            return true;
        } catch (_error) {
            return false;
        }
    }
}
