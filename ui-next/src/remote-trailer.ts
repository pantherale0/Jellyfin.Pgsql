import type { PlaybackChoice } from './player-model';
import type { MediaItem } from './types';

export type PlayerSource =
    | { kind: 'library'; item: MediaItem; playback: PlaybackChoice }
    | { kind: 'remote-trailer'; videoId: string; title: string; url: string; parentItemId: string };

const YOUTUBE_HOSTS = new Set([ 'youtube.com', 'www.youtube.com', 'm.youtube.com' ]);
const EMBED_HOSTS = new Set([ 'youtube-nocookie.com', 'www.youtube-nocookie.com' ]);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export function youtubeVideoId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    try {
        const url = new URL(value);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null;
        let id: string | null = null;
        if (url.hostname === 'youtu.be') {
            id = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1] || null;
        } else if (YOUTUBE_HOSTS.has(url.hostname)) {
            id = url.pathname === '/watch' ? url.searchParams.get('v')
                : /^\/(?:embed|shorts)\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1] || null;
        } else if (EMBED_HOSTS.has(url.hostname)) {
            id = /^\/embed\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1] || null;
        }
        return id && VIDEO_ID.test(id) ? id : null;
    } catch {
        return null;
    }
}

export function firstYouTubeTrailer(raw: unknown): { videoId: string } | null {
    if (!Array.isArray(raw)) return null;
    for (const entry of raw) {
        if (typeof entry !== 'object' || entry === null || !('Url' in entry)) continue;
        const videoId = youtubeVideoId(entry.Url);
        if (videoId) return { videoId };
    }
    return null;
}
