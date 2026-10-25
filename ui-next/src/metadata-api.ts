import type { JellyfinApi } from './api';
import type { MediaItem } from './types';
import {
    asEditorInfo, asImageInfos, asLyricLines, asRemoteImages, asRemoteLyrics, asRemoteSearchResults, asRemoteSubtitles, buildItemUpdate,
    type ImageInfo, type LyricLine, type MetadataDraft, type MetadataEditorInfo, type RemoteImageResult, type RemoteLyric, type RemoteSearchResult,
    type RemoteSubtitle,
} from './metadata-model';
import { t } from './i18n';

type Api = Pick<JellyfinApi, 'request' | 'session'>;

const enc = encodeURIComponent;
const UPLOAD_TIMEOUT = 2 * 60_000;

export function getFullItem(api: Api, id: string): Promise<MediaItem> {
    return api.request<MediaItem>(`/Items/${enc(id)}?${new URLSearchParams({ userId: api.session.user.Id })}`, {}, false, 2);
}

export async function getEditorInfo(api: Api, id: string): Promise<MetadataEditorInfo> {
    return asEditorInfo(await api.request<unknown>(`/Items/${enc(id)}/MetadataEditor`, {}, false, 2));
}

/** Re-reads the item and applies only the edited fields before saving, because the server overwrites every field it receives. */
export async function updateItem(api: Api, id: string, changes: Partial<MetadataDraft>): Promise<MediaItem> {
    const fresh = await getFullItem(api, id);
    const next = buildItemUpdate(fresh, changes);
    await api.request<void>(`/Items/${enc(id)}`, { method: 'POST', body: JSON.stringify(next) }, true, 2);
    return next;
}

export function setContentType(api: Api, id: string, contentType: string): Promise<void> {
    return api.request<void>(`/Items/${enc(id)}/ContentType?${new URLSearchParams({ contentType })}`, { method: 'POST' }, true, 2);
}

export function refreshItem(api: Api, id: string, options: Record<string, string>): Promise<void> {
    return api.request<void>(`/Items/${enc(id)}/Refresh?${new URLSearchParams(options)}`, { method: 'POST' }, true, 2);
}

export async function remoteSearch(api: Api, type: string, query: unknown): Promise<RemoteSearchResult[]> {
    return asRemoteSearchResults(await api.request<unknown>(`/Items/RemoteSearch/${enc(type)}`, { method: 'POST', body: JSON.stringify(query), timeoutMs: 60_000 }, false, 2));
}

export function applyRemoteSearch(api: Api, id: string, result: RemoteSearchResult, replaceAllImages: boolean): Promise<void> {
    return api.request<void>(`/Items/RemoteSearch/Apply/${enc(id)}?${new URLSearchParams({ replaceAllImages: String(replaceAllImages) })}`,
        { method: 'POST', body: JSON.stringify(result), timeoutMs: UPLOAD_TIMEOUT }, true, 2);
}

export async function getImages(api: Api, id: string): Promise<ImageInfo[]> {
    return asImageInfos(await api.request<unknown>(`/Items/${enc(id)}/Images`, {}, false, 2));
}

export function itemImageUrl(api: Api, id: string, image: ImageInfo, maxWidth = 320): string {
    const query = new URLSearchParams({ maxWidth: String(maxWidth), quality: '85' });
    if (image.ImageTag) query.set('tag', image.ImageTag);
    return `${api.session.server}/Items/${enc(id)}/Images/${enc(image.ImageType)}/${image.ImageIndex}?${query}`;
}

export function deleteImage(api: Api, id: string, type: string, index: number): Promise<void> {
    return api.request<void>(`/Items/${enc(id)}/Images/${enc(type)}/${index}`, { method: 'DELETE' }, true, 2);
}

export function moveImage(api: Api, id: string, type: string, index: number, newIndex: number): Promise<void> {
    return api.request<void>(`/Items/${enc(id)}/Images/${enc(type)}/${index}/Index?${new URLSearchParams({ newIndex: String(newIndex) })}`, { method: 'POST' }, true, 2);
}

/** The server expects the image as a base64 body with the image's own Content-Type. */
export function uploadImage(api: Api, id: string, type: string, mimeType: string, base64: string): Promise<void> {
    return api.request<void>(`/Items/${enc(id)}/Images/${enc(type)}`, { method: 'POST', body: base64, headers: { 'Content-Type': mimeType }, timeoutMs: UPLOAD_TIMEOUT }, true, 2);
}

export async function getRemoteImages(api: Api, id: string, options: { type: string; startIndex: number; limit: number; providerName?: string; includeAllLanguages: boolean }): Promise<RemoteImageResult> {
    const query = new URLSearchParams({ type: options.type, startIndex: String(options.startIndex), limit: String(options.limit), includeAllLanguages: String(options.includeAllLanguages) });
    if (options.providerName) query.set('providerName', options.providerName);
    return asRemoteImages(await api.request<unknown>(`/Items/${enc(id)}/RemoteImages?${query}`, { timeoutMs: 60_000 }, false, 2));
}

export function downloadRemoteImage(api: Api, id: string, type: string, imageUrl: string): Promise<void> {
    return api.request<void>(`/Items/${enc(id)}/RemoteImages/Download?${new URLSearchParams({ type, imageUrl })}`, { method: 'POST', timeoutMs: UPLOAD_TIMEOUT }, true, 2);
}

export async function searchSubtitles(api: Api, id: string, language: string, perfectMatch: boolean): Promise<RemoteSubtitle[]> {
    const query = perfectMatch ? `?${new URLSearchParams({ isPerfectMatch: 'true' })}` : '';
    return asRemoteSubtitles(await api.request<unknown>(`/Items/${enc(id)}/RemoteSearch/Subtitles/${enc(language)}${query}`, { timeoutMs: 60_000 }, false, 2));
}

export function downloadSubtitle(api: Api, id: string, subtitleId: string): Promise<void> {
    return api.request<void>(`/Items/${enc(id)}/RemoteSearch/Subtitles/${enc(subtitleId)}`, { method: 'POST', timeoutMs: UPLOAD_TIMEOUT }, true, 2);
}

export function uploadSubtitle(api: Api, id: string, body: { Language: string; Format: string; IsForced: boolean; IsHearingImpaired: boolean; Data: string }): Promise<void> {
    return api.request<void>(`/Videos/${enc(id)}/Subtitles`, { method: 'POST', body: JSON.stringify(body), timeoutMs: UPLOAD_TIMEOUT }, true, 2);
}

export function deleteSubtitle(api: Api, id: string, index: number): Promise<void> {
    return api.request<void>(`/Videos/${enc(id)}/Subtitles/${index}`, { method: 'DELETE' }, true, 2);
}

export async function getLyrics(api: Api, id: string): Promise<LyricLine[]> {
    const result = await api.request<{ Lyrics?: unknown } | undefined>(`/Audio/${enc(id)}/Lyrics`, {}, true, 2);
    return asLyricLines(result?.Lyrics);
}

export async function searchLyrics(api: Api, id: string): Promise<RemoteLyric[]> {
    return asRemoteLyrics(await api.request<unknown>(`/Audio/${enc(id)}/RemoteSearch/Lyrics`, { timeoutMs: 60_000 }, false, 2));
}

export function downloadLyrics(api: Api, id: string, lyricId: string): Promise<unknown> {
    return api.request<unknown>(`/Audio/${enc(id)}/RemoteSearch/Lyrics/${enc(lyricId)}`, { method: 'POST' }, true, 2);
}

export function uploadLyrics(api: Api, id: string, fileName: string, content: string): Promise<unknown> {
    return api.request<unknown>(`/Audio/${enc(id)}/Lyrics?${new URLSearchParams({ fileName })}`, { method: 'POST', body: content, headers: { 'Content-Type': 'text/plain' }, timeoutMs: UPLOAD_TIMEOUT }, true, 2);
}

export function deleteLyrics(api: Api, id: string): Promise<void> {
    return api.request<void>(`/Audio/${enc(id)}/Lyrics`, { method: 'DELETE' }, true, 2);
}

/** Reads a picked file as base64 without its `data:` prefix. */
export function readFileAsBase64(file: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = String(reader.result || '');
            const comma = result.indexOf(',');
            resolve(comma >= 0 ? result.slice(comma + 1) : result);
        };
        reader.onerror = () => reject(new Error(t('The file could not be read.')));
        reader.readAsDataURL(file);
    });
}

export function readFileAsText(file: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error(t('The file could not be read.')));
        reader.readAsText(file);
    });
}
