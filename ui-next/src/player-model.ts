import type { MediaItem } from './types';
import { t } from './i18n';

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
    IsExternal?: boolean;
    DeliveryMethod?: 'Encode' | 'Embed' | 'External' | 'Hls' | 'Drop' | string;
    AspectRatio?: string;
    Height?: number;
}

export type PlayMethod = 'DirectPlay' | 'DirectStream' | 'Transcode';

export interface PlaybackChoice {
    url: string;
    direct: boolean;
    method: PlayMethod;
    mediaSourceId: string;
    playSessionId?: string;
    bitrate?: number;
    streams: MediaStreamInfo[];
    transcodeReasons?: number | string | string[];
    /** Where the element should start, in media time. */
    startSeconds: number;
    /** Added to element time when the stream itself starts at StartTimeTicks (progressive transcodes). */
    offsetSeconds: number;
    audioStreamIndex: number | null;
    subtitleStreamIndex: number | null;
    liveStreamId?: string;
    isLive: boolean;
    maxBitrate?: number;
    versions?: MediaVersion[];
}

export interface PlaybackOptions {
    startTicks?: number;
    audioStreamIndex?: number | null;
    subtitleStreamIndex?: number | null;
    maxBitrate?: number;
    mediaSourceId?: string;
    forceTranscode?: boolean;
    liveStreamId?: string;
}

export interface PlaybackRenegotiationOptions extends PlaybackOptions {
    reopenLiveStream?: boolean;
}

export interface PlaybackRenegotiationPlan {
    options: PlaybackOptions;
    retainedLiveStreamId?: string;
}

export function playbackRenegotiationPlan(options: PlaybackRenegotiationOptions, currentLiveStreamId?: string): PlaybackRenegotiationPlan {
    const { reopenLiveStream, liveStreamId, mediaSourceId, ...playbackOptions } = options;
    const retainedLiveStreamId = reopenLiveStream ? undefined : liveStreamId ?? currentLiveStreamId;
    const nextOptions: PlaybackOptions = { ...playbackOptions, liveStreamId: retainedLiveStreamId };
    if (reopenLiveStream || mediaSourceId !== undefined) nextOptions.mediaSourceId = reopenLiveStream ? undefined : mediaSourceId;
    return {
        options: nextOptions,
        retainedLiveStreamId
    };
}

export interface PlaybackProgressWatch {
    lastPositionSeconds: number;
    lastProgressAtMs: number;
    liveReopenAttempted: boolean;
}

export interface PlaybackProgressSample {
    currentTime: number;
    nowMs: number;
    paused: boolean;
    seeking: boolean;
    isLive: boolean;
}

export interface PlaybackProgressDecision {
    watch: PlaybackProgressWatch;
    buffering: boolean;
    reopenLiveStream: boolean;
    recoveryFailed: boolean;
}

export const PLAYBACK_BUFFERING_FALLBACK_MS = 2_000;
export const LIVE_REOPEN_AFTER_STALL_MS = 20_000;

export function observePlaybackProgress(watch: PlaybackProgressWatch, sample: PlaybackProgressSample): PlaybackProgressDecision {
    const nextWatch = { ...watch };
    if (sample.paused || sample.seeking || sample.currentTime > watch.lastPositionSeconds + 0.05) {
        nextWatch.lastPositionSeconds = sample.currentTime;
        nextWatch.lastProgressAtMs = sample.nowMs;
        return { watch: nextWatch, buffering: false, reopenLiveStream: false, recoveryFailed: false };
    }

    const stalledForMs = Math.max(0, sample.nowMs - watch.lastProgressAtMs);
    const reopenLiveStream = sample.isLive && !watch.liveReopenAttempted && stalledForMs >= LIVE_REOPEN_AFTER_STALL_MS;
    nextWatch.liveReopenAttempted ||= reopenLiveStream;
    return {
        watch: nextWatch,
        buffering: stalledForMs >= PLAYBACK_BUFFERING_FALLBACK_MS,
        reopenLiveStream,
        recoveryFailed: sample.isLive && watch.liveReopenAttempted && stalledForMs >= LIVE_REOPEN_AFTER_STALL_MS
    };
}

export type HlsRecoveryKind = 'network' | 'media' | 'other';
export type HlsRecoveryAction = 'ignore' | 'start-load' | 'recover-media' | 'swap-audio-codec' | 'reopen-live' | 'fail';

export interface HlsRecoveryAttempts {
    networkRetries: number;
    mediaRetries: number;
}

export interface HlsRecoveryError {
    fatal: boolean;
    kind: HlsRecoveryKind;
    responseCode?: number;
}

export interface HlsRecoveryDecision {
    action: HlsRecoveryAction;
    attempts: HlsRecoveryAttempts;
}

export function planHlsRecovery(error: HlsRecoveryError, attempts: HlsRecoveryAttempts, isLive: boolean, liveReopenAttempted: boolean): HlsRecoveryDecision {
    if (!error.fatal) return { action: 'ignore', attempts };

    if (error.kind === 'network') {
        if (error.responseCode === 0) {
            return { action: isLive && !liveReopenAttempted ? 'reopen-live' : 'fail', attempts };
        }
        if (error.responseCode !== undefined && error.responseCode >= 400) {
            return { action: 'fail', attempts };
        }
        if (attempts.networkRetries < 1) {
            return { action: 'start-load', attempts: { ...attempts, networkRetries: attempts.networkRetries + 1 } };
        }
    }

    if (error.kind === 'media' && attempts.mediaRetries < 2) {
        return {
            action: attempts.mediaRetries === 0 ? 'recover-media' : 'swap-audio-codec',
            attempts: { ...attempts, mediaRetries: attempts.mediaRetries + 1 }
        };
    }

    return { action: isLive && !liveReopenAttempted ? 'reopen-live' : 'fail', attempts };
}

export type PlayIntent = 'resume' | 'beginning';

export function resumeStartTicks(item: Pick<MediaItem, 'UserData' | 'RunTimeTicks' | 'Type'> | null, intent: PlayIntent = 'resume'): number {
    if (!item || intent === 'beginning' || item.Type === 'TvChannel') return 0;
    const ticks = item.UserData?.PlaybackPositionTicks || 0;
    if (ticks <= 0 || item.UserData?.Played) return 0;
    if (item.RunTimeTicks && ticks >= item.RunTimeTicks) return 0;
    return ticks;
}

export function canResume(item: Pick<MediaItem, 'UserData' | 'RunTimeTicks' | 'Type'> | null): boolean {
    return resumeStartTicks(item, 'resume') > 0;
}

function urlParam(url: string, name: string): string | null {
    try {
        const parsed = new URL(url, 'http://placeholder.invalid');
        for (const [ key, value ] of parsed.searchParams) if (key.toLowerCase() === name.toLowerCase()) return value;
    } catch (_error) { /* Malformed URLs carry no diagnostics. */ }
    return null;
}

export function transcodeReasonsFromUrl(url: string): string[] {
    const value = urlParam(url, 'TranscodeReasons');
    return value ? value.split(',').map(reason => reason.trim()).filter(Boolean) : [];
}

/** Progressive (non-HLS) transcodes begin at StartTimeTicks, so element time 0 is that offset. */
export function startPlan(url: string, direct: boolean, hls: boolean, startTicks: number): { startSeconds: number; offsetSeconds: number } {
    const start = Math.max(0, startTicks) / 10_000_000;
    if (direct || hls || urlParam(url, 'CopyTimestamps')?.toLowerCase() === 'true') return { startSeconds: start, offsetSeconds: 0 };
    const encoded = Number(urlParam(url, 'StartTimeTicks') || 0) / 10_000_000;
    return encoded > 0 ? { startSeconds: 0, offsetSeconds: encoded } : { startSeconds: start, offsetSeconds: 0 };
}

export function itemPosition(mediaSeconds: number, offsetSeconds: number): number {
    return Math.max(0, mediaSeconds + offsetSeconds);
}

export function mediaPosition(itemSeconds: number, offsetSeconds: number): number {
    return Math.max(0, itemSeconds - offsetSeconds);
}

export function burnedSubtitleIndex(url: string): number | null {
    const method = urlParam(url, 'SubtitleMethod');
    const index = urlParam(url, 'SubtitleStreamIndex');
    if (!method || method.toLowerCase() !== 'encode' || index === null) return null;
    const value = Number(index);
    return Number.isInteger(value) && value >= 0 ? value : null;
}

export function subtitleIsExternal(stream: MediaStreamInfo): boolean {
    if (stream.DeliveryMethod) return stream.DeliveryMethod === 'External';
    return Boolean(stream.IsTextSubtitleStream);
}

export type SubtitlePlan =
    | { action: 'none' }
    | { action: 'track'; index: number }
    | { action: 'embedded'; index: number }
    | { action: 'off' }
    | { action: 'renegotiate'; subtitleStreamIndex: number };

/** Burned-in captions can only be removed or replaced by asking the server for a new stream. */
export function planSubtitleSelection(target: number | null, streams: MediaStreamInfo[], url: string): SubtitlePlan {
    const burned = burnedSubtitleIndex(url);
    if (target === null) return burned === null ? { action: 'off' } : { action: 'renegotiate', subtitleStreamIndex: -1 };
    if (burned === target) return { action: 'none' };
    const stream = streams.find(candidate => candidate.Index === target && streamKind(candidate.Type) === 'subtitle');
    if (!stream) return { action: 'none' };
    if (stream.DeliveryMethod === 'Embed' && burned === null && !/\.m3u8(?:\?|$)/i.test(url)) return { action: 'embedded', index: target };
    if (subtitleIsExternal(stream) && burned === null) return { action: 'track', index: target };
    return { action: 'renegotiate', subtitleStreamIndex: target };
}

export function initialSubtitleIndex(choice: Pick<PlaybackChoice, 'subtitleStreamIndex' | 'streams' | 'url'>): number | null {
    const burned = burnedSubtitleIndex(choice.url);
    if (burned !== null) return burned;
    const index = choice.subtitleStreamIndex;
    if (index === null || index < 0) return null;
    const stream = choice.streams.find(candidate => candidate.Index === index && streamKind(candidate.Type) === 'subtitle');
    return stream && (subtitleIsExternal(stream) || stream.DeliveryMethod === 'Embed') ? index : null;
}

export function initialAudioIndex(choice: Pick<PlaybackChoice, 'audioStreamIndex' | 'streams'>): number | null {
    const audio = choice.streams.filter(stream => streamKind(stream.Type) === 'audio');
    if (choice.audioStreamIndex !== null && audio.some(stream => stream.Index === choice.audioStreamIndex)) return choice.audioStreamIndex;
    return audio.find(stream => stream.IsDefault)?.Index ?? audio[0]?.Index ?? null;
}

export type AudioPlan = { action: 'none' } | { action: 'switch'; trackPosition: number } | { action: 'renegotiate'; audioStreamIndex: number };

/** Only a direct-play element exposing every audio track can switch locally; anything else is a new stream. */
export function planAudioSelection(target: number, current: number | null, streams: MediaStreamInfo[], browserTrackCount: number, method: PlayMethod): AudioPlan {
    if (target === current) return { action: 'none' };
    const audio = streams.filter(stream => streamKind(stream.Type) === 'audio');
    const position = audio.findIndex(stream => stream.Index === target);
    if (position < 0) return { action: 'none' };
    if (method === 'DirectPlay' && browserTrackCount === audio.length && position < browserTrackCount) return { action: 'switch', trackPosition: position };
    return { action: 'renegotiate', audioStreamIndex: target };
}

export interface SeekBounds { start: number; end: number; live: boolean; seekable: boolean }

export function seekBounds(duration: number, ranges: Array<[number, number]>): SeekBounds {
    if (Number.isFinite(duration) && duration > 0) return { start: 0, end: duration, live: false, seekable: true };
    if (!ranges.length) return { start: 0, end: 0, live: true, seekable: false };
    const start = ranges[0][0];
    const end = ranges[ranges.length - 1][1];
    return { start, end, live: true, seekable: end - start > 1 };
}

export function clampSeek(target: number, bounds: SeekBounds): number {
    if (!bounds.seekable) return bounds.end;
    return Math.min(Math.max(bounds.start, target), bounds.end);
}

export function rangesOf(ranges: TimeRanges | null | undefined): Array<[number, number]> {
    const list: Array<[number, number]> = [];
    if (!ranges) return list;
    for (let index = 0; index < ranges.length; index++) list.push([ ranges.start(index), ranges.end(index) ]);
    return list;
}

export interface SessionTranscodingInfo {
    IsVideoDirect?: boolean;
    IsAudioDirect?: boolean;
    VideoCodec?: string;
    AudioCodec?: string;
    Container?: string;
    Bitrate?: number;
    HardwareAccelerationType?: string;
    TranscodeReasons?: string[] | string | number;
}

export function sessionPlayMethod(choice: Pick<PlaybackChoice, 'method'>, info: SessionTranscodingInfo | null | undefined): PlayMethod {
    if (choice.method === 'DirectPlay' || !info) return choice.method;
    return info.IsVideoDirect && info.IsAudioDirect ? 'DirectStream' : 'Transcode';
}

export function describePlayMethod(method: PlayMethod, info?: SessionTranscodingInfo | null): string {
    if (method === 'DirectPlay') return 'Direct play';
    if (method === 'DirectStream') return t('Remux (video and audio copied)');
    if (!info) return 'Transcoded stream';
    const parts = [ info.IsVideoDirect ? 'video copied' : `video → ${info.VideoCodec || 'converted'}`, info.IsAudioDirect ? 'audio copied' : `audio → ${info.AudioCodec || 'converted'}` ];
    if (info.HardwareAccelerationType && info.HardwareAccelerationType !== 'none') parts.push(`${info.HardwareAccelerationType} acceleration`);
    return `Transcode (${parts.join(', ')})`;
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

export type SegmentKind = 'intro' | 'credits' | 'recap' | 'preview' | 'commercial';
export type SegmentAction = 'ask' | 'skip' | 'ignore';

export interface TimelineCue {
    kind: SegmentKind;
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

const TRANSCODE_REASON_NAMES = [
    'ContainerNotSupported', 'VideoCodecNotSupported', 'AudioCodecNotSupported', 'SubtitleCodecNotSupported', 'AudioIsExternal',
    'SecondaryAudioNotSupported', 'VideoProfileNotSupported', 'VideoLevelNotSupported', 'VideoResolutionNotSupported', 'VideoBitDepthNotSupported',
    'VideoFramerateNotSupported', 'RefFramesNotSupported', 'AnamorphicVideoNotSupported', 'InterlacedVideoNotSupported', 'AudioChannelsNotSupported',
    'AudioProfileNotSupported', 'AudioSampleRateNotSupported', 'AudioBitDepthNotSupported', 'ContainerBitrateExceedsLimit', 'VideoBitrateNotSupported',
    'AudioBitrateNotSupported', 'UnknownVideoStreamInfo', 'UnknownAudioStreamInfo', 'DirectPlayError', 'VideoRangeTypeNotSupported',
    'VideoCodecTagNotSupported', 'StreamCountExceedsLimit', 'VideoRotationNotSupported'
];

function reasonLabel(name: string): string {
    const index = TRANSCODE_REASON_NAMES.findIndex(candidate => candidate.toLowerCase() === name.trim().toLowerCase());
    return index >= 0 ? TRANSCODE_REASONS[index][1] : name.trim();
}

export function describeTranscode(reasons: number | string | string[] | undefined, direct: boolean): string {
    if (typeof reasons === 'number' && reasons > 0) {
        const labels = TRANSCODE_REASONS.filter(([ bit ]) => (reasons & bit) === bit).map(([, label ]) => label);
        if (labels.length) return labels.join('. ') + '.';
    }
    const list = Array.isArray(reasons) ? reasons : typeof reasons === 'string' && reasons.trim() && reasons !== '0' ? reasons.split(',') : [];
    const labels = list.map(reasonLabel).filter(Boolean);
    if (labels.length) return labels.join('. ') + '.';
    if (direct) return 'None. This file is playing directly.';
    return t('The server did not report a reason for this stream.');
}

export function timelineCues(items: Array<{ Type?: string | number; StartTicks?: number; EndTicks?: number }>): TimelineCue[] {
    const cues: TimelineCue[] = [];
    items.forEach(item => {
        const start = (item.StartTicks || 0) / 10000000;
        const end = (item.EndTicks || 0) / 10000000;
        if (end <= start) return;
        const kind = SEGMENT_TYPES[String(item.Type)];
        if (kind) cues.push({ kind, label: t('Skip {0}', SEGMENT_LABELS[kind].toLowerCase()), start, end });
    });
    return cues.sort((left, right) => left.start - right.start);
}

const SEGMENT_TYPES: Record<string, SegmentKind> = {
    Commercial: 'commercial', 1: 'commercial', Preview: 'preview', 2: 'preview', Recap: 'recap', 3: 'recap', Outro: 'credits', 4: 'credits', Intro: 'intro', 5: 'intro'
};

export const SEGMENT_LABELS: Record<SegmentKind, string> = { intro: 'Intro', credits: 'Credits', recap: 'Recap', preview: 'Preview', commercial: 'Commercial' };
export const SEGMENT_KINDS = Object.keys(SEGMENT_LABELS) as SegmentKind[];
const SEGMENT_PREFERENCES_KEY = 'ui-next-segment-actions';
const DEFAULT_SEGMENT_ACTIONS: Record<SegmentKind, SegmentAction> = { intro: 'ask', credits: 'ask', recap: 'ask', preview: 'ask', commercial: 'ask' };

export function normalizeSegmentActions(raw: unknown): Record<SegmentKind, SegmentAction> {
    const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const actions = { ...DEFAULT_SEGMENT_ACTIONS };
    SEGMENT_KINDS.forEach(kind => {
        const action = value[kind];
        if (action === 'ask' || action === 'skip' || action === 'ignore') actions[kind] = action;
    });
    return actions;
}

export function loadSegmentActions(): Record<SegmentKind, SegmentAction> {
    try {
        return normalizeSegmentActions(JSON.parse(localStorage.getItem(SEGMENT_PREFERENCES_KEY) || '{}'));
    } catch (_error) {
        return { ...DEFAULT_SEGMENT_ACTIONS };
    }
}

export function saveSegmentAction(kind: SegmentKind, action: SegmentAction): Record<SegmentKind, SegmentAction> {
    const next = normalizeSegmentActions({ ...loadSegmentActions(), [kind]: action });
    try { localStorage.setItem(SEGMENT_PREFERENCES_KEY, JSON.stringify(next)); } catch (_error) { /* Private mode keeps the in-memory value. */ }
    return next;
}

export function cueKey(cue: TimelineCue): string {
    return `${cue.kind}:${cue.start.toFixed(1)}`;
}

/** What to do for the active segment: auto-skip once per segment, otherwise prompt unless the type is ignored. */
export function segmentDecision(cue: TimelineCue | null, actions: Record<SegmentKind, SegmentAction>, skipped: ReadonlySet<string>): 'none' | 'prompt' | 'skip' {
    if (!cue) return 'none';
    const action = actions[cue.kind];
    if (action === 'ignore') return 'none';
    if (action === 'skip' && !skipped.has(cueKey(cue))) return 'skip';
    return 'prompt';
}

export const SKIP_PROMPT_SECONDS = 8;

/** The skip prompt shows outside the OSD for the first few seconds after a segment is entered. */
export function skipPromptVisible(enteredAt: number | null, time: number, osdOpen: boolean): boolean {
    if (osdOpen) return true;
    return enteredAt !== null && time >= enteredAt && time - enteredAt < SKIP_PROMPT_SECONDS;
}

export interface Chapter { index: number; name: string; start: number; imageTag?: string }

export function chapterList(raw: Array<{ StartPositionTicks?: number; Name?: string; ImageTag?: string }> | undefined, duration = 0): Chapter[] {
    if (!Array.isArray(raw)) return [];
    const chapters = raw.map((chapter, index) => ({ index, name: chapter.Name?.trim() || `Chapter ${index + 1}`, start: Math.max(0, (chapter.StartPositionTicks || 0) / 10_000_000), imageTag: chapter.ImageTag || undefined }))
        .filter(chapter => Number.isFinite(chapter.start) && (!duration || chapter.start < duration))
        .sort((left, right) => left.start - right.start);
    return chapters.length > 1 ? chapters : [];
}

export function currentChapterIndex(chapters: Chapter[], time: number): number {
    let current = -1;
    chapters.forEach((chapter, position) => { if (time >= chapter.start) current = position; });
    return current;
}

/** Previous goes to the start of the current chapter unless playback is within its first few seconds. */
export function adjacentChapterStart(chapters: Chapter[], time: number, direction: 1 | -1): number | null {
    const current = currentChapterIndex(chapters, time);
    if (direction === 1) return chapters[current + 1]?.start ?? null;
    if (current >= 0 && time - chapters[current].start > 3) return chapters[current].start;
    return current > 0 ? chapters[current - 1].start : null;
}

export interface MediaVersion { id: string; name: string }

export function mediaVersions(sources: Array<{ Id?: string; Name?: string; Container?: string; Bitrate?: number; MediaStreams?: MediaStreamInfo[] }> | undefined): MediaVersion[] {
    if (!Array.isArray(sources)) return [];
    return sources.filter(source => source.Id).map((source, index) => {
        const height = source.MediaStreams?.find(stream => streamKind(stream.Type) === 'video')?.Height;
        const detail = [ height ? `${height}p` : '', source.Container?.toUpperCase(), source.Bitrate ? formatBitrate(source.Bitrate) : '' ].filter(Boolean).join(' · ');
        return { id: source.Id as string, name: source.Name?.trim() || detail || `Version ${index + 1}` };
    });
}

const rememberedVersions = new Map<string, string>();

/** Keeps the chosen version name per series so the next episode plays the matching cut/encode. */
export function rememberVersion(seriesId: string | undefined, name: string): void {
    if (seriesId && name) rememberedVersions.set(seriesId, name);
}

export function preferredVersionId(seriesId: string | undefined, versions: MediaVersion[]): string | undefined {
    const name = seriesId ? rememberedVersions.get(seriesId) : undefined;
    return name ? versions.find(version => version.name === name)?.id : undefined;
}

export function cueBox(cue: TimelineCue, duration: number): { left: string; width: string } | null {
    if (!duration || duration <= 0) return null;
    const left = Math.min(100, Math.max(0, (cue.start / duration) * 100));
    const width = Math.min(100 - left, Math.max(0, ((cue.end - cue.start) / duration) * 100));
    if (width <= 0) return null;
    return { left: `${left}%`, width: `${width}%` };
}

export interface TrickplayPreview {
    level: TrickplayLevel;
    sourceId: string;
}

export function pickTrickplay(manifest: Record<string, Record<string, TrickplayLevel>> | undefined, mediaSourceId?: string): TrickplayPreview | null {
    if (!manifest) return null;
    const sourceId = (mediaSourceId && manifest[mediaSourceId] ? mediaSourceId : Object.keys(manifest)[0]);
    const source = sourceId ? manifest[sourceId] : undefined;
    if (!source) return null;
    const levels = Object.keys(source).map(key => source[key]).filter(level => level && level.Width && level.Interval && level.ThumbnailCount);
    if (!levels.length) return null;
    levels.sort((left, right) => Math.abs(left.Width - 320) - Math.abs(right.Width - 320));
    return { level: levels[0], sourceId };
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

export type PlayerKeyAction = 'toggle' | 'play' | 'pause' | 'stop' | 'select';

export function classifyPlayerKey(key: string, keyCode?: number): PlayerKeyAction | null {
    if (key === 'MediaPlayPause' || keyCode === 10252) return 'toggle';
    if (key === 'MediaPlay' || keyCode === 415) return 'play';
    if (key === 'MediaPause' || key === 'Pause') return 'pause';
    if (key === 'MediaStop' || keyCode === 413) return 'stop';
    if (key === 'Enter' || key === 'Select') return 'select';
    return null;
}
