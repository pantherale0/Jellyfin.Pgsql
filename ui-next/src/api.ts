import type { GuideInfo, ItemResponse, JellyfinUser, LiveChannelFilter, LiveTimer, MediaItem, RecommendationGroup, Session, TasteProfile, UserConfiguration } from './types';
import type { PlaybackReport } from './playback-report';
import type { MediaStreamInfo, PlaybackChoice, TrickplayLevel } from './player-model';
import { mapLibraryQuery } from './library-query';
import type { LibraryItemsOptions } from './library-query';

const CLIENT_NAME = 'Jellyfin UI Next';
const CLIENT_VERSION = '0.1.0';
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
    const devHttpAllowed = import.meta.env.DEV && url.protocol === 'http:';
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

// Browsers only keep a handful of HTTP/1.1 connections per host. Filling all of them
// stalls input and scrolling until a socket frees, so catalog and image reads stay
// under that cap and a click can still take the last slot.
const MAX_IN_FLIGHT = 4;
const MAX_BULK = 3;
const MAX_BACKGROUND = 2;

interface ScheduledRequest {
    priority: number;
    cancelled: boolean;
    abort?: () => void;
    run: (finish: () => void, registerAbort: (abort: () => void) => void) => void;
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

function enqueueRequest(priority: number, run: ScheduledRequest['run']): { cancel: () => 'queued' | 'started' } {
    const slot: ScheduledRequest = { priority, cancelled: false, run };
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

function startNextRequest(): boolean {
    const interactive = requestQueue.findIndex(slot => !slot.cancelled && slot.priority >= 2);
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

function xhrRequest<T>(url: string, method = 'GET', headers: Record<string, string> = {}, body?: Document | XMLHttpRequestBodyInit, emptyOk = false, priority = 2, signal?: AbortSignal | null, responseType: 'json' | 'text' = 'json', maxResponseBytes?: number): Promise<T> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(new DOMException('The request was cancelled.', 'AbortError')); return; }
        const cleanup = () => signal?.removeEventListener('abort', onAbort);
        const onAbort = () => {
            if (handle.cancel() === 'queued') {
                cleanup();
                reject(new DOMException('The request was cancelled.', 'AbortError'));
            }
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
                    settle(() => reject(new Error(responseMessage || `Jellyfin request failed (${xhr.status}).`)));
                    return;
                }
                if (emptyOk) {
                    settle(() => resolve(undefined as T));
                    return;
                }
                const text = xhr.responseText || '';
                const deliver = () => {
                    cleanup();
                    try {
                        if (signal?.aborted) reject(new DOMException('The request was cancelled.', 'AbortError'));
                        else resolve((responseType === 'text' ? text : JSON.parse(text)) as T);
                    } catch (_error) {
                        reject(new Error('The server returned an invalid response.'));
                    }
                    finish();
                };
                settled = true;
                // A large catalog payload is parsed on a later turn so a burst of
                // responses cannot block clicks and scrolling.
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
        });
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

function deviceProfile() {
    const video = document.createElement('video');
    const supports = (codec: string) => Boolean(video.canPlayType && video.canPlayType(codec).replace(/no/, ''));
    const videoCodecs: string[] = [];
    if (supports('video/mp4; codecs="avc1.42E01E"')) videoCodecs.push('h264');
    if (supports('video/mp4; codecs="hvc1.1.L120"') || /web0s|webos|tizen/i.test(navigator.userAgent)) videoCodecs.push('hevc');
    const audioCodecs: string[] = [];
    if (supports('audio/mp4; codecs="mp4a.40.2"')) audioCodecs.push('aac');
    if (supports('audio/mp4; codecs="ac-3"') || /web0s|webos|tizen/i.test(navigator.userAgent)) audioCodecs.push('ac3');
    const directPlayProfiles = videoCodecs.length && audioCodecs.length ? [
        { Container: 'mp4,m4v', Type: 'Video', VideoCodec: videoCodecs.join(','), AudioCodec: audioCodecs.join(',') }
    ] : [];
    if (supports('video/x-matroska') && videoCodecs.length && audioCodecs.length) {
        directPlayProfiles.push({ Container: 'mkv', Type: 'Video', VideoCodec: videoCodecs.join(','), AudioCodec: audioCodecs.join(',') });
    }
    return {
        MaxStreamingBitrate: 120000000,
        DirectPlayProfiles: directPlayProfiles,
        TranscodingProfiles: [ { Container: 'ts', Type: 'Video', VideoCodec: 'h264', AudioCodec: 'aac', Context: 'Streaming', Protocol: 'hls' } ],
        CodecProfiles: []
    };
}

export class JellyfinApi {
    readonly session: Session;

    constructor(session: Session) {
        this.session = session;
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

    static async getSsoConfig(serverInput: string): Promise<boolean> {
        const server = normalizeServer(serverInput);
        const configUrl = import.meta.env.DEV
            ? `/__debug/sso-config?server=${encodeURIComponent(server)}`
            : `${server}/sso/config`;
        try {
            const result = await xhrRequest<{ Enabled?: boolean; enabled?: boolean }>(configUrl);
            return result.Enabled === true || result.enabled === true;
        } catch (_error) {
            // Optional feature probe: treat proxy/debug failures as "not enabled".
            return false;
        }
    }

    static async beginSso(serverInput: string): Promise<void> {
        const server = normalizeServer(serverInput);
        try { localStorage.setItem('jellyfin-ui-next-server', server); } catch (_error) { /* Session screen remains available after callback. */ }
        const query = queryString({ deviceId: deviceId() });
        window.location.assign(`${server}/sso/login?${query}`);
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

    async request<T>(path: string, init: RequestInit = {}, emptyOk = false, priority = 2): Promise<T> {
        const headers: Record<string, string> = { 'Authorization': authorization(this.session.token) };
        if (init.body && !(typeof FormData !== 'undefined' && init.body instanceof FormData)) headers['Content-Type'] = 'application/json';
        if (init.headers && typeof init.headers === 'object') {
            Object.keys(init.headers).forEach(key => {
                const value = (init.headers as Record<string, string>)[key];
                if (value) headers[key] = value;
            });
        }
        try {
            const body = typeof init.body === 'string' || (typeof FormData !== 'undefined' && init.body instanceof FormData) ? init.body : undefined;
            return await xhrRequest<T>(`${this.session.server}${path}`, init.method || 'GET', headers, body, emptyOk, priority, init.signal);
        } catch (error) {
            if (error instanceof Error && error.message.indexOf('(401)') >= 0) throw new Error('Your session expired. Sign in again.');
            throw error;
        }
    }

    async requestText(path: string, priority = 1): Promise<string> {
        const headers = { 'Authorization': authorization(this.session.token) };
        return xhrRequest<string>(`${this.session.server}${path}`, 'GET', headers, undefined, false, priority, undefined, 'text', 2 * 1024 * 1024)
            .then(value => typeof value === 'string' ? value : String(value));
    }

    async getViews(): Promise<MediaItem[]> {
        const response = await this.bulk<ItemResponse>(`/UserViews?${queryString({ UserId: this.session.user.Id })}`);
        return response.Items || [];
    }

    async getResumeItems(): Promise<MediaItem[]> {
        const userId = encodeURIComponent(this.session.user.Id);
        const response = await this.bulk<ItemResponse>(`/UserItems/Resume?UserId=${userId}&Limit=12&Fields=Overview,PrimaryImageAspectRatio,UserData,SeriesName,SeriesId,IndexNumber,ParentIndexNumber,ProductionYear`);
        return response.Items || [];
    }

    async getLatestItems(): Promise<MediaItem[]> {
        const userId = encodeURIComponent(this.session.user.Id);
        const response = await this.bulk<MediaItem[]>(`/Items/Latest?UserId=${userId}&Limit=16&Fields=Overview,PrimaryImageAspectRatio,UserData`);
        return response || [];
    }

    async getRecentCollections(limit = 12): Promise<MediaItem[]> {
        const result = await this.bulk<ItemResponse>(`/Items?${queryString({
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
        return this.bulk<ItemResponse>(`/Items?${queryString({
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
        const result = await this.bulk<ItemResponse>(`/Items?${queryString({
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
        if (!ids.length) return [];
        const result = await this.bulk<ItemResponse>(`/Items?${queryString({
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
            if (item) ordered.push({ ...item, RecommendationType: itemType === 'Movie' ? 6 : 7 });
        });
        return ordered;
    }

    async getUser(): Promise<JellyfinUser> {
        return JellyfinApi.getUserSession(this.session);
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

    async getCultures(): Promise<Array<{ ThreeLetterISOLanguageName: string; DisplayName: string }>> {
        return this.request<Array<{ ThreeLetterISOLanguageName: string; DisplayName: string }>>('/Localization/Cultures');
    }

    async getTasteProfile(): Promise<TasteProfile> {
        return this.request<TasteProfile>(`/Pgsql/Taste/Users/${encodeURIComponent(this.session.user.Id)}`);
    }

    async getItems(parentId: string, startIndex = 0, search?: string, includeItemTypes?: string[], recursive = true, pageSize = 40, libraryOptions?: LibraryItemsOptions, priority = 1): Promise<ItemResponse> {
        const query = libraryOptions?.Query;
        return this.request<ItemResponse>(`/Items?${queryString({
            UserId: this.session.user.Id,
            Recursive: String(recursive),
            ParentId: parentId || undefined,
            SearchTerm: search || undefined,
            IncludeItemTypes: includeItemTypes?.join(','),
            ...(libraryOptions ? mapLibraryQuery(query!, { ...libraryOptions, StartIndex: startIndex, Limit: libraryOptions.Limit ?? pageSize, IncludeItemTypes: includeItemTypes, Recursive: recursive }) : {
                Limit: pageSize,
                StartIndex: startIndex,
                Fields: 'Overview,PrimaryImageAspectRatio,UserData,CommunityRating,ProductionYear,RunTimeTicks,IndexNumber,ParentIndexNumber,SeriesId,SeasonId',
                SortBy: 'SortName',
                SortOrder: 'Ascending'
            })
        })}`, { signal: libraryOptions?.Signal }, false, search ? 2 : priority);
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
        return this.bulk<ItemResponse>(`/Shows/${encodeURIComponent(seriesId)}/Seasons?${queryString({
            UserId: this.session.user.Id,
            Fields: 'Overview,PrimaryImageAspectRatio,UserData,CommunityRating,ProductionYear,IndexNumber,ParentId,ChildCount,CumulativeRunTimeTicks,PremiereDate,EndDate',
            EnableImages: 'true',
            EnableUserData: 'true'
        })}`);
    }

    async getEpisodes(seriesId: string, seasonId: string): Promise<ItemResponse> {
        return this.bulk<ItemResponse>(`/Shows/${encodeURIComponent(seriesId)}/Episodes?${queryString({
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
        while (startIndex < totalRecordCount && startIndex < 1000) {
            const response = await this.bulk<ItemResponse>(`/Shows/${encodeURIComponent(seriesId)}/Episodes?${queryString({
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
        while (startIndex < total && startIndex < 800) {
            const response = await this.bulk<ItemResponse>(`/Shows/${encodeURIComponent(seriesId)}/Episodes?${queryString({
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
        return `${this.session.server}/Videos/${encodeURIComponent(itemId)}/${encodeURIComponent(mediaSourceId)}/Subtitles/${index}/Stream.vtt?${queryString({ api_key: this.session.token })}`;
    }

    trickplayTileUrl(itemId: string, width: number, index: number, mediaSourceId?: string): string {
        return `${this.session.server}/Videos/${encodeURIComponent(itemId)}/Trickplay/${width}/${index}.jpg?${queryString({ MediaSourceId: mediaSourceId, api_key: this.session.token })}`;
    }

    async getItem(id: string): Promise<MediaItem> {
        return this.request<MediaItem>(`/Users/${encodeURIComponent(this.session.user.Id)}/Items/${encodeURIComponent(id)}?Fields=Overview,CommunityRating,ProductionYear,RunTimeTicks,UserData,BackdropImageTags,ImageTags,ChildCount,PremiereDate,EndDate,SeriesName,SeriesId,IndexNumber,ParentIndexNumber`);
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
        return this.bulk<ItemResponse>(`/LiveTv/Channels?${queryString({
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

    async getAiringPrograms(limit = 80): Promise<ItemResponse> {
        return this.bulk<ItemResponse>(`/LiveTv/Programs?${queryString({
            UserId: this.session.user.Id,
            IsAiring: 'true',
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

    async getLivePrograms(channelIds: string[], minStart: string, maxEnd: string, limit = 500): Promise<ItemResponse> {
        return this.bulk<ItemResponse>(`/LiveTv/Programs?${queryString({
            UserId: this.session.user.Id,
            ChannelIds: channelIds.length ? channelIds.join(',') : undefined,
            MinStartDate: minStart,
            MaxEndDate: maxEnd,
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
        return this.bulk<ItemResponse>(`/LiveTv/Recordings?${queryString({
            UserId: this.session.user.Id,
            StartIndex: startIndex,
            Limit: limit,
            EnableImages: 'true',
            EnableUserData: 'true',
            Fields: 'Overview'
        })}`);
    }

    async setFavorite(itemId: string, favorite: boolean): Promise<void> {
        const path = `/Users/${encodeURIComponent(this.session.user.Id)}/FavoriteItems/${encodeURIComponent(itemId)}`;
        await this.request(path, { method: favorite ? 'POST' : 'DELETE' }, true);
    }

    async setPlayed(itemId: string, played: boolean): Promise<void> {
        const path = `/Users/${encodeURIComponent(this.session.user.Id)}/PlayedItems/${encodeURIComponent(itemId)}`;
        await this.request(path, { method: played ? 'POST' : 'DELETE' }, true);
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
                const xhr = new XMLHttpRequest();
                registerAbort(() => xhr.abort());
                const complete = (value: string) => {
                    finish();
                    finishJob(value);
                };
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
                    } catch (_error) {
                        complete('');
                        return;
                    }
                    complete(xhr.status >= 200 && xhr.status < 300 && xhr.response ? rememberImage(url, URL.createObjectURL(xhr.response)) : '');
                };
                xhr.onerror = () => complete('');
                xhr.ontimeout = () => complete('');
                xhr.onabort = () => complete('');
                try {
                    xhr.send();
                } catch (_error) {
                    complete('');
                }
            });
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

    async play(item: MediaItem): Promise<PlaybackChoice> {
        const result = await this.request<{ MediaSources?: Array<{ Id: string; SupportsDirectPlay?: boolean; TranscodingUrl?: string; Bitrate?: number; MediaStreams?: MediaStreamInfo[]; TranscodeReasons?: number | string }>; PlaySessionId?: string }>(
            `/Items/${encodeURIComponent(item.Id)}/PlaybackInfo?UserId=${encodeURIComponent(this.session.user.Id)}`,
            {
                method: 'POST',
                body: JSON.stringify({
                    DeviceProfile: deviceProfile(),
                    PlayMethod: 'Auto'
                })
            }
        );
        const source = result.MediaSources?.[0];
        if (!source) throw new Error('No playable media source was returned.');
        const choice = {
            direct: source.SupportsDirectPlay !== false || !source.TranscodingUrl,
            mediaSourceId: source.Id,
            playSessionId: result.PlaySessionId,
            bitrate: source.Bitrate,
            streams: source.MediaStreams || [],
            transcodeReasons: source.TranscodeReasons
        };
        if (source.SupportsDirectPlay === false && !source.TranscodingUrl) {
            throw new Error('The server requires transcoding for this item. Transcoding playback is not available in this preview yet.');
        }
        if (source.SupportsDirectPlay === false && source.TranscodingUrl) {
            const transcodeUrl = new URL(source.TranscodingUrl, `${this.session.server}/`);
            if (transcodeUrl.origin !== new URL(this.session.server).origin) {
                throw new Error('The server returned a playback URL on another origin.');
            }
            return { ...choice, url: transcodeUrl.toString(), direct: false };
        }
        const query = queryString({
            Static: source.SupportsDirectPlay === false ? 'false' : 'true',
            MediaSourceId: source.Id,
            PlaySessionId: result.PlaySessionId
        });
        return { ...choice, url: `${this.session.server}/Videos/${encodeURIComponent(item.Id)}/stream?${query}&api_key=${encodeURIComponent(this.session.token)}`, direct: true };
    }

    reportPlaybackStart(report: PlaybackReport): Promise<void> {
        return this.postPlayback('/Sessions/Playing', report);
    }

    reportPlaybackProgress(report: PlaybackReport): Promise<void> {
        return this.postPlayback('/Sessions/Playing/Progress', report);
    }

    reportPlaybackStopped(report: PlaybackReport, keepalive = false): Promise<void> {
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
            }).then(() => undefined).catch(() => undefined);
        }
        return this.postPlayback('/Sessions/Playing/Stopped', report);
    }

    private postPlayback(path: string, report: PlaybackReport): Promise<void> {
        return xhrRequest<void>(
            `${this.session.server}${path}`,
            'POST',
            {
                'Authorization': authorization(this.session.token),
                'Content-Type': 'application/json'
            },
            JSON.stringify(report),
            true,
            1
        ).catch(() => undefined);
    }
}
