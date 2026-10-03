import type { MediaItem } from './types';

export interface MediaStreamInfo {
    Index: number;
    Type?: string | number;
    Codec?: string;
    Language?: string;
    DisplayTitle?: string;
    Title?: string;
    IsDefault?: boolean;
    IsForced?: boolean;
    IsTextSubtitleStream?: boolean;
    AspectRatio?: string;
}

export interface PlaybackChoice {
    url: string;
    direct: boolean;
    mediaSourceId: string;
    playSessionId?: string;
    bitrate?: number;
    streams: MediaStreamInfo[];
    transcodeReasons?: number | string;
}

export interface TrickplayLevel {
    Width: number;
    Height: number;
    TileWidth: number;
    TileHeight: number;
    ThumbnailCount: number;
    Interval: number;
}

export interface TrickplayFrame {
    tileIndex: number;
    x: number;
    y: number;
    width: number;
    height: number;
    sheetWidth: number;
    sheetHeight: number;
}

export interface TimelineCue {
    kind: 'intro' | 'credits';
    label: string;
    start: number;
    end: number;
}

const TRANSCODE_REASONS: Array<[number, string]> = [
    [ 1 << 0, 'Container is not supported' ],
    [ 1 << 1, 'Video codec is not supported' ],
    [ 1 << 2, 'Audio codec is not supported' ],
    [ 1 << 3, 'Subtitle codec is not supported' ],
    [ 1 << 4, 'Audio is external' ],
    [ 1 << 5, 'Secondary audio is not supported' ],
    [ 1 << 6, 'Video profile is not supported' ],
    [ 1 << 7, 'Video level is not supported' ],
    [ 1 << 8, 'Video resolution is not supported' ],
    [ 1 << 9, 'Video bit depth is not supported' ],
    [ 1 << 10, 'Video frame rate is not supported' ],
    [ 1 << 11, 'Reference frames are not supported' ],
    [ 1 << 12, 'Anamorphic video is not supported' ],
    [ 1 << 13, 'Interlaced video is not supported' ],
    [ 1 << 14, 'Audio channel layout is not supported' ],
    [ 1 << 15, 'Audio profile is not supported' ],
    [ 1 << 16, 'Audio sample rate is not supported' ],
    [ 1 << 17, 'Audio bit depth is not supported' ],
    [ 1 << 18, 'Container bitrate exceeds the limit' ],
    [ 1 << 19, 'Video bitrate is not supported' ],
    [ 1 << 20, 'Audio bitrate is not supported' ],
    [ 1 << 21, 'Video stream information is missing' ],
    [ 1 << 22, 'Audio stream information is missing' ],
    [ 1 << 23, 'Direct play failed' ],
    [ 1 << 24, 'Video range is not supported' ],
    [ 1 << 25, 'Video codec tag is not supported' ],
    [ 1 << 26, 'Stream count exceeds the limit' ],
    [ 1 << 27, 'Video rotation is not supported' ]
];

export function playbackTitle(item: MediaItem | null): string {
    if (!item) return 'Playback';
    const season = item.ParentIndexNumber;
    const episode = item.IndexNumber;
    if (item.SeriesName && season !== undefined && episode !== undefined && item.Name) {
        const code = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
        return `${item.SeriesName} • ${code}: ${item.Name}`;
    }
    return item.Name || 'Playback';
}

export function streamKind(type: string | number | undefined): 'audio' | 'video' | 'subtitle' | 'other' {
    if (type === 'Audio' || type === 0 || type === '0') return 'audio';
    if (type === 'Video' || type === 1 || type === '1') return 'video';
    if (type === 'Subtitle' || type === 2 || type === '2') return 'subtitle';
    return 'other';
}

export function streamLabel(stream: MediaStreamInfo): string {
    if (stream.DisplayTitle) return stream.DisplayTitle;
    const parts = [ stream.Language, stream.Title, stream.Codec ].filter(Boolean);
    return parts.join(' · ') || `Track ${stream.Index + 1}`;
}

export function formatBitrate(bits?: number): string {
    if (!bits || bits < 0) return 'Unknown bitrate';
    if (bits >= 1000000) return `${(bits / 1000000).toFixed(1)} Mbps`;
    if (bits >= 1000) return `${Math.round(bits / 1000)} kbps`;
    return `${bits} bps`;
}

export function describeTranscode(reasons: number | string | undefined, direct: boolean): string {
    if (typeof reasons === 'number' && reasons > 0) {
        const labels = TRANSCODE_REASONS.filter(([ bit ]) => (reasons & bit) === bit).map(([, label ]) => label);
        if (labels.length) return labels.join('. ') + '.';
    }
    if (typeof reasons === 'string' && reasons.trim() && reasons !== '0') return reasons;
    if (direct) return 'None. This file is playing directly.';
    return 'The server opened a transcoded stream and did not include a reason list.';
}

export function timelineCues(items: Array<{ Type?: string | number; StartTicks?: number; EndTicks?: number }>): TimelineCue[] {
    const cues: TimelineCue[] = [];
    items.forEach(item => {
        const start = (item.StartTicks || 0) / 10000000;
        const end = (item.EndTicks || 0) / 10000000;
        if (end <= start) return;
        const type = item.Type;
        const intro = type === 'Intro' || type === 5 || type === '5';
        const credits = type === 'Outro' || type === 4 || type === '4';
        if (intro) cues.push({ kind: 'intro', label: 'Skip intro', start, end });
        if (credits) cues.push({ kind: 'credits', label: 'Skip credits', start, end });
    });
    return cues;
}

export function cueBox(cue: TimelineCue, duration: number): { left: string; width: string } | null {
    if (!duration || duration <= 0) return null;
    const left = Math.min(100, Math.max(0, (cue.start / duration) * 100));
    const width = Math.min(100 - left, Math.max(0, ((cue.end - cue.start) / duration) * 100));
    if (width <= 0) return null;
    return { left: `${left}%`, width: `${width}%` };
}

export function pickTrickplay(manifest: Record<string, Record<string, TrickplayLevel>> | undefined, mediaSourceId?: string): TrickplayLevel | null {
    if (!manifest) return null;
    const source = (mediaSourceId && manifest[mediaSourceId]) || manifest[Object.keys(manifest)[0]];
    if (!source) return null;
    const levels = Object.keys(source).map(key => source[key]).filter(level => level && level.Width && level.Interval && level.ThumbnailCount);
    if (!levels.length) return null;
    levels.sort((left, right) => Math.abs(left.Width - 320) - Math.abs(right.Width - 320));
    return levels[0];
}

export function trickplayFrame(info: TrickplayLevel, timeSeconds: number): TrickplayFrame | null {
    if (!info.Interval || !info.TileWidth || !info.TileHeight || !info.ThumbnailCount || !info.Width || !info.Height) return null;
    const thumbIndex = Math.min(info.ThumbnailCount - 1, Math.max(0, Math.floor((timeSeconds * 1000) / info.Interval)));
    const perTile = info.TileWidth * info.TileHeight;
    const offset = thumbIndex % perTile;
    return {
        tileIndex: Math.floor(thumbIndex / perTile),
        x: (offset % info.TileWidth) * info.Width,
        y: Math.floor(offset / info.TileWidth) * info.Height,
        width: info.Width,
        height: info.Height,
        sheetWidth: info.TileWidth * info.Width,
        sheetHeight: info.TileHeight * info.Height
    };
}

export function activeCue(cues: TimelineCue[], time: number): TimelineCue | null {
    for (let index = 0; index < cues.length; index++) {
        const cue = cues[index];
        if (time >= cue.start && time < cue.end - 0.4) return cue;
    }
    return null;
}

export function seasonLabel(number: number | undefined): string {
    if (number === 0) return 'Specials';
    if (number === undefined) return 'Episodes';
    return `Season ${number}`;
}
