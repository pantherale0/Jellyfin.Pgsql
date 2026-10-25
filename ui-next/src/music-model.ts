import type { NormalizationMode } from './music-settings';
import type { MediaItem } from './types';

type Track = Pick<MediaItem, 'Id' | 'Name' | 'AlbumId' | 'IndexNumber' | 'ParentIndexNumber' | 'NormalizationGain'>;

/** Seconds before a transition the next deck starts loading. */
export const PRELOAD_LEAD_SECONDS = 20;
/** Tracks shorter than this never crossfade; the fade would swallow them. */
export const MIN_CROSSFADE_TRACK_SECONDS = 10;
export const MAX_TRACK_FAILURES = 3;

/** Item types the music player takes; everything else goes to the video player. */
export const MUSIC_CONTAINER_TYPES = [ 'MusicAlbum', 'MusicArtist', 'MusicGenre' ];

export function isAudioItem(item: Pick<MediaItem, 'Type' | 'MediaType'>): boolean {
    return item.MediaType === 'Audio' || item.Type === 'Audio';
}

export function isMusicTarget(item: Pick<MediaItem, 'Type' | 'MediaType'>): boolean {
    return isAudioItem(item) || MUSIC_CONTAINER_TYPES.indexOf(item.Type || '') >= 0;
}

/** Linear gain for a ReplayGain-style dB value; HTML audio cannot amplify, so it never exceeds 1. */
export function gainFactor(db: number | null | undefined): number {
    if (typeof db !== 'number' || !Number.isFinite(db)) return 1;
    return Math.min(1, Math.max(0, Math.pow(10, db / 20)));
}

/** The dB value the chosen mode applies: album mode falls back to the track's own gain. */
export function normalizationDb(track: Pick<Track, 'NormalizationGain'>, albumGain: number | null | undefined, mode: NormalizationMode): number | undefined {
    if (mode === 'off') return undefined;
    if (mode === 'album' && typeof albumGain === 'number' && Number.isFinite(albumGain)) return albumGain;
    return typeof track.NormalizationGain === 'number' && Number.isFinite(track.NormalizationGain) ? track.NormalizationGain : undefined;
}

/** Element volume: user volume × normalization × crossfade envelope, clamped to 0–1. */
export function elementVolume(userVolume: number, db: number | undefined, envelope = 1): number {
    const value = userVolume * gainFactor(db) * envelope;
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** Equal-power crossfade so loudness stays even through the overlap; `progress` runs 0→1. */
export function crossfadeEnvelope(progress: number): { out: number; in: number } {
    const p = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 1));
    return { out: Math.cos(p * Math.PI / 2), in: Math.sin(p * Math.PI / 2) };
}

/** True when `next` directly follows `current` on the same album, where a fade would break a continuous mix. */
export function continuesAlbum(current: Track, next: Track): boolean {
    if (!current.AlbumId || current.AlbumId !== next.AlbumId) return false;
    const disc = (track: Track) => track.ParentIndexNumber ?? 1;
    if (typeof current.IndexNumber !== 'number' || typeof next.IndexNumber !== 'number') return false;
    if (disc(next) === disc(current)) return next.IndexNumber === current.IndexNumber + 1;
    return disc(next) === disc(current) + 1 && next.IndexNumber === 1;
}

export interface TransitionInput {
    currentDuration: number;
    nextDuration: number;
    crossfadeSeconds: number;
    gapless: boolean;
    albumContinues: boolean;
    volumeControl: boolean;
}

/**
 * `preloadAt`: current-track time to load the next deck (Infinity: load on end).
 * `startAt`: time to start the next deck and fade (Infinity: start on `ended`).
 */
export interface TransitionPlan { preloadAt: number; startAt: number; fadeSeconds: number }

export function planTransition(input: TransitionInput): TransitionPlan {
    const current = input.currentDuration;
    if (!Number.isFinite(current) || current <= 0) return { preloadAt: Infinity, startAt: Infinity, fadeSeconds: 0 };
    const nextKnown = Number.isFinite(input.nextDuration) && input.nextDuration > 0;
    const canFade = input.volumeControl && input.crossfadeSeconds > 0
        && !(input.gapless && input.albumContinues)
        && current >= MIN_CROSSFADE_TRACK_SECONDS
        && (!nextKnown || input.nextDuration >= MIN_CROSSFADE_TRACK_SECONDS);
    const fadeSeconds = canFade ? Math.min(input.crossfadeSeconds, current / 2, nextKnown ? input.nextDuration / 2 : input.crossfadeSeconds) : 0;
    const startAt = fadeSeconds > 0 ? current - fadeSeconds : Infinity;
    const preloadAt = fadeSeconds > 0 || input.gapless ? Math.max(0, current - fadeSeconds - PRELOAD_LEAD_SECONDS) : Infinity;
    return { preloadAt, startAt, fadeSeconds };
}

export interface MusicMetadata { title: string; artist: string; album: string; artwork: Array<{ src: string; sizes: string; type: string }> }

export function trackArtist(track: Pick<MediaItem, 'AlbumArtists' | 'ArtistItems'> & { Artists?: string[]; AlbumArtist?: string }): string {
    return track.Artists?.filter(Boolean).join(', ') || track.ArtistItems?.map(artist => artist.Name).filter(Boolean).join(', ')
        || track.AlbumArtist || track.AlbumArtists?.map(artist => artist.Name).filter(Boolean).join(', ') || '';
}

export function mediaSessionMetadata(track: Pick<MediaItem, 'Name' | 'Album' | 'AlbumArtists' | 'ArtistItems'> & { Artists?: string[]; AlbumArtist?: string }, imageUrl?: string): MusicMetadata {
    return {
        title: track.Name || '',
        artist: trackArtist(track),
        album: track.Album || '',
        artwork: imageUrl ? [ { src: imageUrl, sizes: '512x512', type: 'image/jpeg' } ] : [],
    };
}

/** `setPositionState` throws on invalid input, so unknown durations send nothing. */
export function mediaPositionState(position: number, duration: number): { duration: number; position: number; playbackRate: number } | null {
    if (!Number.isFinite(duration) || duration <= 0) return null;
    return { duration, position: Math.min(duration, Math.max(0, Number.isFinite(position) ? position : 0)), playbackRate: 1 };
}

export function formatDuration(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const total = Math.floor(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const pad = (value: number) => (value < 10 ? `0${value}` : String(value));
    return hours ? `${hours}:${pad(minutes)}:${pad(total % 60)}` : `${minutes}:${pad(total % 60)}`;
}

/** Previous restarts the track after three seconds, as in other players; before that it goes back. */
export function previousGoesBack(positionSeconds: number): boolean {
    return !(positionSeconds > 3);
}
