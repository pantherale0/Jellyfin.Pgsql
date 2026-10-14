import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { itemPosition, mediaPosition, type MediaStreamInfo } from './player-model';
import { JellyfinApi, peekCachedImage, releaseCachedImage, retainCachedImage } from './api';
import type { MediaItem } from './types';
import { PlaybackReporter } from './playback-report';
import type { PlaybackSessionSnapshot, PlaybackSessionTracker } from './playback-session';
import { isHlsUrl } from './live-model';
import { adjacentEpisodes } from './catalog-model';
import { userMessage } from './ui-errors';
import { advance, AUTOPLAY_COUNTDOWN_SECONDS, currentItem, cycleRepeat, playQueue, previous as previousInQueue, syncQueue, toggleShuffle, upcoming, upNext, type PlayQueue, type RepeatMode } from './play-queue';
import { activeCue, adjacentChapterStart, chapterList, cueKey, currentChapterIndex, loadSegmentActions, rememberVersion, SEGMENT_LABELS, segmentDecision, skipPromptVisible, type Chapter, clampSeek, classifyPlayerKey, cueBox, describePlayMethod, describeTranscode, formatBitrate, initialAudioIndex, initialSubtitleIndex, pickTrickplay, planAudioSelection, planSubtitleSelection, playbackTitle, rangesOf, seasonLabel, seekBounds, sessionPlayMethod, streamKind, streamLabel, timelineCues, trickplayFrame, type PlaybackChoice, type PlaybackOptions, type PlayMethod, type SessionTranscodingInfo, type TimelineCue, type TrickplayLevel, type TrickplayPreview } from './player-model';
import { BITRATE_CHOICES, loadPlaybackPreferences, PLAYER_SPEEDS, savePlaybackPreferences } from './device-profile';
import { captionCss, loadCaptionStyle, primaryCueLine, SECONDARY_TRACK_LABEL } from './caption-style';

interface PlayerProps {
    url: string;
    item: MediaItem | null;
    playback: PlaybackChoice | null;
    playbackSession: PlaybackSessionSnapshot | null;
    sessionOwner: Pick<PlaybackSessionTracker, 'isCurrent' | 'canRefresh' | 'claimLiveCleanup' | 'retainsLiveStream' | 'liveStreamFor' | 'markLiveReleased'>;
    api: JellyfinApi | null;
    tvClient: boolean;
    onBack: () => void;
    onError: () => void;
    onPlayItem: (item: MediaItem) => void;
    onPlaybackReported?: (itemId: string) => void;
    onRenegotiate?: (options: PlaybackOptions) => Promise<PlaybackChoice | null>;
}

type PlayerMenu = 'episodes' | 'chapters' | 'captions' | 'settings' | null;
type AspectFit = 'contain' | 'cover' | 'fill';

const PLAYBACK_ERROR = 'Playback stopped because this browser could not play the stream.';

/** Reporting state for one media load; a new URL gets a fresh object so the old stop report keeps its own position. */
interface MediaProgress { position: number; duration: number; pendingStart: number; offset: number; loaded: boolean; frozen: boolean }

function mediaProgress(playback: PlaybackChoice | null, item: MediaItem | null): MediaProgress {
    const offset = playback?.offsetSeconds || 0;
    const start = playback?.startSeconds || 0;
    return { position: offset + start, duration: item?.RunTimeTicks ? item.RunTimeTicks / 10_000_000 : 0, pendingStart: start, offset, loaded: false, frozen: false };
}

let nativeHlsSupport: boolean | undefined;

function canPlayNativeHls(): boolean {
    if (nativeHlsSupport !== undefined) return nativeHlsSupport;
    const video = document.createElement('video');
    const supports = (type: string) => Boolean(video.canPlayType && video.canPlayType(type).replace(/no/, ''));
    nativeHlsSupport = supports('application/vnd.apple.mpegurl') || supports('application/x-mpegURL');
    return nativeHlsSupport;
}
const cueBases = new WeakMap<TextTrackCue, { start: number; end: number }>();

type InlineVideo = HTMLVideoElement & {
    webkitEnterFullscreen?: () => void;
    webkitSupportsFullscreen?: boolean;
    requestPictureInPicture?: () => Promise<unknown>;
};

type PipDocument = Document & { pictureInPictureEnabled?: boolean; pictureInPictureElement?: Element | null; exitPictureInPicture?: () => Promise<void> };

type FullscreenHost = HTMLElement & {
    webkitRequestFullscreen?: () => void;
    mozRequestFullScreen?: () => void;
};

type FullscreenDocument = Document & {
    webkitFullscreenElement?: Element | null;
    mozFullScreenElement?: Element | null;
    webkitExitFullscreen?: () => void;
    mozCancelFullScreen?: () => void;
};

type BrowserAudioTracks = { length: number; [index: number]: { enabled: boolean } };

function currentFullscreenElement(): Element | null {
    const doc = document as FullscreenDocument;
    return document.fullscreenElement || doc.webkitFullscreenElement || doc.mozFullScreenElement || null;
}

function requestStageFullscreen(root: HTMLElement) {
    const host = root as FullscreenHost;
    const request = root.requestFullscreen || host.webkitRequestFullscreen || host.mozRequestFullScreen;
    if (request) void request.call(root);
}

function exitStageFullscreen() {
    const doc = document as FullscreenDocument;
    if (document.exitFullscreen && document.fullscreenElement) void document.exitFullscreen();
    else if (doc.webkitExitFullscreen) doc.webkitExitFullscreen();
    else if (doc.mozCancelFullScreen) doc.mozCancelFullScreen();
}

function formatTime(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const total = Math.floor(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const remainder = total % 60;
    const padded = (value: number) => (value < 10 ? `0${value}` : String(value));
    if (hours > 0) return `${hours}:${padded(minutes)}:${padded(remainder)}`;
    return `${minutes}:${padded(remainder)}`;
}

function applySubtitleOffset(video: HTMLVideoElement, offset: number, primaryLine: number | 'auto' = 'auto') {
    for (let index = 0; index < video.textTracks.length; index++) {
        const track = video.textTracks[index];
        const cues = track.cues;
        if (!cues) continue;
        const line = track.label === SECONDARY_TRACK_LABEL ? 0 : primaryLine;
        for (let cueIndex = 0; cueIndex < cues.length; cueIndex++) {
            const cue = cues[cueIndex];
            if ('line' in cue) (cue as VTTCue).line = line;
            let base = cueBases.get(cue);
            if (!base) {
                base = { start: cue.startTime, end: cue.endTime };
                cueBases.set(cue, base);
            }
            const start = Math.max(0, base.start + offset);
            cue.startTime = start;
            cue.endTime = Math.max(start, base.end + offset);
        }
    }
}

function browserAudioTracks(video: HTMLVideoElement): BrowserAudioTracks | null {
    const tracks = (video as HTMLVideoElement & { audioTracks?: BrowserAudioTracks }).audioTracks;
    return tracks && tracks.length ? tracks : null;
}

function applyEmbeddedSubtitle(video: HTMLVideoElement, streams: MediaStreamInfo[], index: number): boolean {
    const generated = Array.from(video.querySelectorAll('track')).map(element => element.track);
    const embedded = Array.from(video.textTracks).filter(track => !generated.includes(track));
    const position = streams.filter(stream => streamKind(stream.Type) === 'subtitle' && stream.DeliveryMethod === 'Embed')
        .findIndex(stream => stream.Index === index);
    if (position < 0 || !embedded[position]) return false;
    Array.from(video.textTracks).forEach(track => { track.mode = 'disabled'; });
    embedded[position].mode = 'showing';
    return true;
}

function useCompactControls(tvClient: boolean): boolean {
    const query = '(max-width: 720px)';
    const [ compact, setCompact ] = useState(tvClient || (typeof window !== 'undefined' && window.matchMedia(query).matches));
    useEffect(() => {
        if (tvClient) {
            setCompact(true);
            return;
        }
        const media = window.matchMedia(query);
        const apply = () => setCompact(media.matches);
        apply();
        if (media.addEventListener) media.addEventListener('change', apply);
        else media.addListener(apply);
        return () => {
            if (media.removeEventListener) media.removeEventListener('change', apply);
            else media.removeListener(apply);
        };
    }, [ tvClient ]);
    return compact;
}

function EpisodeThumb({ api, item }: { api: JellyfinApi; item: MediaItem }) {
    const [ src, setSrc ] = useState('');
    const held = useRef('');
    useEffect(() => {
        const key = api.imageUrl(item, 'Primary', 160);
        if (!key) return;
        let active = true;
        const bag: { cancel?: () => void } = {};
        const apply = (url: string) => {
            if (!active || !url) return;
            if (held.current && held.current !== key) releaseCachedImage(held.current);
            held.current = key;
            retainCachedImage(key);
            setSrc(url);
        };
        const cached = peekCachedImage(key);
        if (cached) apply(cached);
        else void api.loadImage(item, 'Primary', 160, 90, bag).then(apply);
        return () => {
            active = false;
            bag.cancel?.();
            if (held.current) releaseCachedImage(held.current);
            held.current = '';
        };
    }, [ api, item.Id ]);
    return src ? <img src={src} alt="" /> : <span class="player-episode-fallback" aria-hidden="true" />;
}

const REPEAT_LABELS: Record<RepeatMode, string> = { off: 'Repeat off', all: 'Repeat queue', one: 'Repeat this title' };

export function Player({ url, item, playback, playbackSession, sessionOwner, api, tvClient, onBack, onError, onPlayItem, onPlaybackReported, onRenegotiate }: PlayerProps) {
    const rootRef = useRef<HTMLDivElement>(null);
    const videoRef = useRef<HTMLVideoElement>(null);
    const hlsRef = useRef<{ destroy: () => void } | null>(null);
    const hlsPlayback = isHlsUrl(url) && !canPlayNativeHls();
    const seekWrapRef = useRef<HTMLDivElement>(null);
    const hideTimer = useRef<number>();
    const clickTimer = useRef<number>();
    const lastPointer = useRef<{ x: number; y: number } | null>(null);
    const releaseRef = useRef<(() => void) | null>(null);
    const draggingRef = useRef(false);
    const holdingRef = useRef(false);
    const pausedRef = useRef(false);
    const osdRef = useRef(true);
    const menuRef = useRef<PlayerMenu>(null);
    const onBackRef = useRef(onBack);
    const onErrorRef = useRef(onError);
    const onPlayItemRef = useRef(onPlayItem);
    const onReportedRef = useRef(onPlaybackReported);
    const reporterRef = useRef<PlaybackReporter | null>(null);
    const audioIndexRef = useRef<number | null>(null);
    const subtitleIndexRef = useRef<number | null>(null);
    const mediaRef = useRef<MediaProgress>(mediaProgress(playback, item));
    const methodRef = useRef<PlayMethod>(playback?.method || 'DirectPlay');
    const onRenegotiateRef = useRef(onRenegotiate);
    const preferences = useRef(loadPlaybackPreferences()).current;
    const offsetRef = useRef(0);
    const aliveRef = useRef(true);
    const tvRef = useRef(tvClient);
    const [ currentTime, setCurrentTime ] = useState(0);
    const [ duration, setDuration ] = useState(0);
    const [ liveRanges, setLiveRanges ] = useState<Array<[number, number]>>([]);
    const [ paused, setPaused ] = useState(true);
    const [ muted, setMuted ] = useState(false);
    const [ volume, setVolume ] = useState(preferences.volume);
    const [ switching, setSwitching ] = useState(false);
    const [ diagnostics, setDiagnostics ] = useState<SessionTranscodingInfo | null>(null);
    const [ pip, setPip ] = useState(false);
    const [ osdOpen, setOsdOpen ] = useState(true);
    const [ fullscreen, setFullscreen ] = useState(false);
    const [ playbackError, setPlaybackError ] = useState('');
    const [ menu, setMenu ] = useState<PlayerMenu>(null);
    const [ seasonList, setSeasonList ] = useState<MediaItem[]>([]);
    const [ episodesBySeason, setEpisodesBySeason ] = useState<Record<string, MediaItem[]>>({});
    const [ episodeState, setEpisodeState ] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
    const [ seasonId, setSeasonId ] = useState<string | undefined>(item?.SeasonId);
    const [ neighbours, setNeighbours ] = useState<{ previous: MediaItem | null; next: MediaItem | null }>({ previous: null, next: null });
    const [ queue, setQueue ] = useState<PlayQueue>(() => playQueue.get());
    const [ upNextCard, setUpNextCard ] = useState<{ item: MediaItem; queue: PlayQueue; source: 'queue' | 'episode'; remaining: number } | null>(null);
    const endedRef = useRef<() => void>(() => undefined);
    const upNextRef = useRef(false);
    const [ cues, setCues ] = useState<TimelineCue[]>([]);
    const [ chapters, setChapters ] = useState<Chapter[]>([]);
    const segmentActions = useRef(loadSegmentActions()).current;
    const skippedSegments = useRef(new Set<string>());
    const [ promptEntry, setPromptEntry ] = useState<{ key: string; at: number } | null>(null);
    const [ skipNote, setSkipNote ] = useState('');
    const captionStyle = useRef(loadCaptionStyle()).current;
    const cueLine = primaryCueLine(captionStyle);
    const [ secondaryIndex, setSecondaryIndex ] = useState<number | null>(null);
    const [ trickplay, setTrickplay ] = useState<TrickplayPreview | null>(null);
    const [ seekHover, setSeekHover ] = useState<{ time: number; x: number; width: number } | null>(null);
    const [ subtitleIndex, setSubtitleIndex ] = useState<number | null>(null);
    const [ subtitleOffset, setSubtitleOffset ] = useState(0);
    const [ subtitleNote, setSubtitleNote ] = useState('');
    const [ audioIndex, setAudioIndex ] = useState<number | null>(null);
    const [ audioNote, setAudioNote ] = useState('');
    const [ speed, setSpeed ] = useState(preferences.speed);
    const [ fit, setFit ] = useState<AspectFit>(preferences.fit);
    const compactControls = useCompactControls(tvClient);
    const focusable = osdOpen ? 'true' : undefined;
    const title = playbackTitle(item);
    const isEpisode = Boolean(item?.SeriesId || item?.Type === 'Episode');
    const visibleEpisodes = seasonId ? episodesBySeason[seasonId] || [] : [];
    const audioStreams = (playback?.streams || []).filter(stream => streamKind(stream.Type) === 'audio');
    const subtitleStreams = (playback?.streams || []).filter(stream => streamKind(stream.Type) === 'subtitle');
    const videoStream = (playback?.streams || []).find(stream => streamKind(stream.Type) === 'video');
    const selectedSubtitle = subtitleStreams.find(stream => stream.Index === subtitleIndex);
    const subtitlePlan = playback && subtitleIndex !== null ? planSubtitleSelection(subtitleIndex, playback.streams, playback.url) : null;
    const subtitleUrl = api && item && playback && selectedSubtitle && subtitlePlan?.action === 'track'
        ? api.subtitleUrl(item.Id, playback.mediaSourceId, selectedSubtitle.Index)
        : '';
    const bounds = seekBounds(duration, liveRanges);
    const crossOrigin = api && typeof window !== 'undefined' && new URL(api.session.server).origin !== window.location.origin ? 'anonymous' : undefined;
    const pipSupported = typeof document !== 'undefined' && Boolean((document as PipDocument).pictureInPictureEnabled);
    const playMethod = sessionPlayMethod({ method: playback?.method || 'DirectPlay' }, diagnostics);
    const activeSegment = activeCue(cues, currentTime);
    const activeSegmentKey = activeSegment ? cueKey(activeSegment) : '';
    const segmentChoice = segmentDecision(activeSegment, segmentActions, skippedSegments.current);
    const skip = segmentChoice === 'prompt' ? activeSegment : null;
    const skipPromptShown = Boolean(skip && skipPromptVisible(promptEntry?.key === activeSegmentKey ? promptEntry.at : null, currentTime, osdOpen));
    const chapterIndex = currentChapterIndex(chapters, currentTime);
    const hoverChapter = seekHover && chapters.length ? chapters[currentChapterIndex(chapters, seekHover.time)] : undefined;
    const secondarySubtitle = subtitleStreams.find(stream => stream.Index === secondaryIndex && stream.IsTextSubtitleStream && stream.Index !== subtitleIndex);
    const secondaryUrl = api && item && playback && secondarySubtitle ? api.subtitleUrl(item.Id, playback.mediaSourceId, secondarySubtitle.Index) : '';
    const styledSubtitle = selectedSubtitle && /^(ass|ssa)$/i.test(selectedSubtitle.Codec || '') && subtitlePlan?.action === 'track';
    const hoverFrame = seekHover && trickplay ? trickplayFrame(trickplay.level, seekHover.time) : null;
    const hoverTile = hoverFrame && api && item && playback ? api.trickplayTileUrl(item.Id, trickplay?.level.Width || hoverFrame.width, hoverFrame.tileIndex, trickplay?.sourceId || playback.mediaSourceId) : '';
    onBackRef.current = onBack;
    onErrorRef.current = onError;
    onPlayItemRef.current = onPlayItem;
    upNextRef.current = Boolean(upNextCard);
    const queueCurrent = currentItem(queue)?.Id === item?.Id ? currentItem(queue) : null;
    const queueNext = queueCurrent ? advance(queue, true) : null;
    const queuePrevious = queueCurrent ? previousInQueue(queue) : null;
    const playQueued = (step: { queue: PlayQueue; item: MediaItem } | null) => {
        if (!step) return;
        playQueue.set(step.queue);
        setUpNextCard(null);
        onPlayItemRef.current(step.item.Id === item?.Id ? { ...step.item, UserData: { ...step.item.UserData, PlaybackPositionTicks: 0 } } : step.item);
    };
    endedRef.current = () => {
        const next = upNext(playQueue.get(), { autoplay: api?.session.user.Configuration?.EnableNextEpisodeAutoPlay, nextEpisode: neighbours.next, current: item });
        if (next) setUpNextCard({ ...next, remaining: AUTOPLAY_COUNTDOWN_SECONDS });
    };
    onReportedRef.current = onPlaybackReported;
    onRenegotiateRef.current = onRenegotiate;
    methodRef.current = playMethod;
    audioIndexRef.current = audioIndex;
    subtitleIndexRef.current = subtitleIndex;
    tvRef.current = tvClient;
    pausedRef.current = paused;
    osdRef.current = osdOpen;
    offsetRef.current = subtitleOffset;

    const clearHideTimer = () => {
        if (hideTimer.current) {
            window.clearTimeout(hideTimer.current);
            hideTimer.current = undefined;
        }
    };

    const reveal = () => {
        if (!osdRef.current) {
            setOsdOpen(true);
            osdRef.current = true;
        }
        clearHideTimer();
        if (!pausedRef.current && !holdingRef.current && !menuRef.current) {
            hideTimer.current = window.setTimeout(() => {
                setOsdOpen(false);
                osdRef.current = false;
                const active = document.activeElement;
                if (active instanceof HTMLElement && rootRef.current?.contains(active)) rootRef.current.focus();
            }, 3000);
        }
    };

    const hideOsd = () => {
        clearHideTimer();
        setOsdOpen(false);
        osdRef.current = false;
        const active = document.activeElement;
        if (active instanceof HTMLElement && rootRef.current?.contains(active)) rootRef.current.focus();
    };

    const chooseMenu = (next: PlayerMenu) => {
        const value = menuRef.current === next ? null : next;
        menuRef.current = value;
        setMenu(value);
        reveal();
    };

    const closeMenu = () => {
        menuRef.current = null;
        setMenu(null);
        reveal();
    };

    const withVideo = (apply: (video: HTMLVideoElement) => void) => {
        const video = videoRef.current;
        if (video) apply(video);
    };

    const togglePlay = () => {
        withVideo(video => {
            if (video.paused) void video.play();
            else video.pause();
        });
        reveal();
    };

    const rememberPosition = (video: HTMLVideoElement) => {
        const media = mediaRef.current;
        if (media.frozen || media.pendingStart > 0 || video.readyState === 0) return;
        const seconds = video.currentTime || 0;
        if (Number.isFinite(seconds) && seconds >= 0) media.position = itemPosition(seconds, media.offset);
        if (Number.isFinite(video.duration) && video.duration > 0) media.duration = media.offset + video.duration;
    };

    const applyStartPosition = (video: HTMLVideoElement): boolean => {
        const media = mediaRef.current;
        if (media.pendingStart <= 0) return true;
        const window = seekBounds(video.duration, rangesOf(video.seekable));
        if (!window.seekable) return false;
        const target = clampSeek(media.pendingStart, window);
        try { video.currentTime = target; } catch (_error) { return false; }
        media.pendingStart = 0;
        media.position = itemPosition(target, media.offset);
        setCurrentTime(media.position);
        return true;
    };

    const seekTo = (seconds: number) => {
        if (seconds < mediaRef.current.offset && onRenegotiateRef.current) {
            void renegotiate({ startTicks: Math.round(Math.max(0, seconds) * 10_000_000) }, message => setPlaybackError(message));
            return;
        }
        withVideo(video => {
            const next = clampSeek(mediaPosition(seconds, mediaRef.current.offset), seekBounds(video.duration, rangesOf(video.seekable)));
            video.currentTime = next;
            rememberPosition(video);
            setCurrentTime(itemPosition(next, mediaRef.current.offset));
        });
        reveal();
    };

    const renegotiate = async (options: PlaybackOptions, onFailure: (message: string) => void): Promise<boolean> => {
        const request = onRenegotiateRef.current;
        if (!request || !playback) {
            onFailure('This player cannot request a new stream here.');
            return false;
        }
        const position = mediaRef.current.position;
        setSwitching(true);
        try {
            const result = await request({
                startTicks: Math.round(position * 10_000_000),
                audioStreamIndex: audioIndexRef.current,
                subtitleStreamIndex: subtitleIndexRef.current ?? -1,
                maxBitrate: playback.maxBitrate,
                mediaSourceId: playback.mediaSourceId,
                ...options
            });
            return Boolean(result);
        } catch (cause) {
            if (aliveRef.current) onFailure(userMessage(cause, 'The server could not prepare a new stream.'));
            return false;
        } finally {
            if (aliveRef.current) setSwitching(false);
        }
    };

    const seekBy = (delta: number) => {
        withVideo(video => seekTo(itemPosition(video.currentTime, mediaRef.current.offset) + delta));
    };

    const setPlayerVolume = (nextVolume: number, nextMuted = false) => {
        const clamped = Math.min(1, Math.max(0, nextVolume));
        withVideo(video => {
            video.volume = clamped;
            video.muted = nextMuted || clamped === 0;
            setVolume(video.volume);
            setMuted(video.muted);
        });
        reveal();
    };

    const toggleMute = () => {
        withVideo(video => {
            video.muted = !video.muted;
            setMuted(video.muted);
        });
        reveal();
    };

    const toggleFullscreen = () => {
        const root = rootRef.current;
        if (!root) return;
        const host = root as FullscreenHost;
        const video = videoRef.current as InlineVideo | null;
        if (currentFullscreenElement() === root) exitStageFullscreen();
        else if (!root.requestFullscreen && !host.webkitRequestFullscreen && !host.mozRequestFullScreen && video?.webkitEnterFullscreen) video.webkitEnterFullscreen();
        else requestStageFullscreen(root);
        reveal();
    };

    const togglePictureInPicture = () => {
        const doc = document as PipDocument;
        const video = videoRef.current as InlineVideo | null;
        if (doc.pictureInPictureElement) void doc.exitPictureInPicture?.().catch(() => undefined);
        else void video?.requestPictureInPicture?.().catch(() => undefined);
        reveal();
    };

    const choosePreference = (change: Parameters<typeof savePlaybackPreferences>[0]) => { savePlaybackPreferences(change); };

    const placeSeekHover = (clientX: number, time: number) => {
        const rect = seekWrapRef.current?.getBoundingClientRect();
        if (!rect) return;
        setSeekHover({ time, x: clientX - rect.left, width: rect.width });
    };

    const selectAudio = (index: number) => {
        const video = videoRef.current;
        if (!video || !playback || switching) return;
        const tracks = browserAudioTracks(video);
        const plan = planAudioSelection(index, audioIndex, playback.streams, tracks?.length || 0, methodRef.current);
        reveal();
        if (plan.action === 'none') return;
        if (plan.action === 'switch' && tracks) {
            for (let trackIndex = 0; trackIndex < tracks.length; trackIndex++) tracks[trackIndex].enabled = trackIndex === plan.trackPosition;
            if (tracks[plan.trackPosition]?.enabled) {
                setAudioIndex(index);
                setAudioNote('');
                return;
            }
        }
        setAudioNote('Switching audio track…');
        void renegotiate({ audioStreamIndex: index }, message => setAudioNote(`Audio track was not changed. ${message}`)).then(ok => { if (ok && aliveRef.current) setAudioNote(''); });
    };

    const selectSubtitle = (index: number | null) => {
        if (!playback || switching) return;
        const plan = planSubtitleSelection(index, playback.streams, playback.url);
        reveal();
        if (plan.action === 'none') return;
        setSubtitleNote('');
        if (plan.action === 'track') { setSubtitleIndex(plan.index); return; }
        if (plan.action === 'off') {
            withVideo(video => Array.from(video.textTracks).forEach(track => { track.mode = 'disabled'; }));
            setSecondaryIndex(null);
            setSubtitleIndex(null);
            return;
        }
        if (plan.action === 'embedded') {
            const video = videoRef.current;
            if (video && applyEmbeddedSubtitle(video, playback.streams, plan.index)) { setSubtitleIndex(plan.index); return; }
            void renegotiate({ subtitleStreamIndex: plan.index, forceTranscode: true }, message => setSubtitleNote(message));
            return;
        }
        setSubtitleNote(plan.subtitleStreamIndex < 0 ? 'Removing burned-in subtitles…' : 'Preparing subtitles on the server…');
        void renegotiate({ subtitleStreamIndex: plan.subtitleStreamIndex }, message => setSubtitleNote(`Subtitles were not changed. ${message}`)).then(ok => { if (ok && aliveRef.current) setSubtitleNote(''); });
    };

    const shiftSubtitles = (delta: number) => {
        const next = Math.min(10, Math.max(-10, Math.round((subtitleOffset + delta) * 10) / 10));
        setSubtitleOffset(next);
        offsetRef.current = next;
        withVideo(video => applySubtitleOffset(video, next - mediaRef.current.offset, cueLine));
        reveal();
    };

    useEffect(() => {
        aliveRef.current = true;
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        rootRef.current?.focus();
        const video = videoRef.current;
        return () => {
            aliveRef.current = false;
            document.body.style.overflow = previousOverflow;
            clearHideTimer();
            if (clickTimer.current) window.clearTimeout(clickTimer.current);
            if (releaseRef.current) {
                window.removeEventListener('pointerup', releaseRef.current);
                window.removeEventListener('pointercancel', releaseRef.current);
            }
            if (currentFullscreenElement() === rootRef.current) exitStageFullscreen();
            if (video) {
                rememberPosition(video);
                reporterRef.current?.stop();
                hlsRef.current?.destroy();
                hlsRef.current = null;
                video.pause();
                video.removeAttribute('src');
                video.load();
            }
        };
    }, []);

    useLayoutEffect(() => {
        mediaRef.current = mediaProgress(playback, item);
        setCurrentTime(mediaRef.current.position);
        setDuration(0);
        setLiveRanges([]);
        setDiagnostics(null);
        setPlaybackError('');
        setSeekHover(null);
        closeMenu();
    }, [ url, playbackSession?.key ]);

    useEffect(() => {
        const video = videoRef.current;
        if (!video || !hlsPlayback) return;
        let cancelled = false;
        video.removeAttribute('src');
        const fail = () => {
            if (cancelled || !aliveRef.current) return;
            reporterRef.current?.stop(true);
            hlsRef.current?.destroy();
            hlsRef.current = null;
            video.pause();
            setPlaybackError(PLAYBACK_ERROR);
            onErrorRef.current();
        };
        void import('hls.js').then(module => {
            if (cancelled) return;
            const Hls = module.default;
            if (!Hls.isSupported()) {
                fail();
                return;
            }
            const instance = new Hls({ startPosition: mediaRef.current.pendingStart > 0 ? mediaRef.current.pendingStart : -1 });
            hlsRef.current = instance;
            instance.on(Hls.Events.ERROR, (_event, data) => {
                if (data.fatal) fail();
            });
            instance.on(Hls.Events.MANIFEST_PARSED, () => {
                if (!cancelled) void video.play().catch(() => undefined);
            });
            instance.loadSource(url);
            instance.attachMedia(video);
        }).catch(() => fail());
        return () => {
            cancelled = true;
            hlsRef.current?.destroy();
            hlsRef.current = null;
        };
    }, [ url, hlsPlayback, playbackSession?.key ]);

    useEffect(() => {
        const video = videoRef.current;
        const client = api;
        const session = playbackSession;
        const owner = sessionOwner;
        if (!client || !item?.Id || !video || !session || !owner || !owner.isCurrent(session)) return;
        const startedAtMs = Date.now();
        const aspectRatio = (playback?.streams || []).find(stream => streamKind(stream.Type) === 'video')?.AspectRatio;
        const itemId = session.itemId;
        const media = mediaRef.current;
        const liveStreamId = session.liveStreamId;
        const onReported = onReportedRef.current;
        let reportAudio = playback ? initialAudioIndex(playback) : null;
        let reportSubtitle = playback ? initialSubtitleIndex(playback) : null;
        let reportMethod = playback?.method || 'DirectPlay';
        const reporter = new PlaybackReporter(() => {
            if (owner.isCurrent(session) && mediaRef.current === media) {
                reportAudio = audioIndexRef.current;
                reportSubtitle = subtitleIndexRef.current;
                reportMethod = methodRef.current;
            }
            return {
            itemId,
            mediaSourceId: session.mediaSourceId,
            playSessionId: session.playSessionId,
            liveStreamId,
            positionSeconds: media.position,
            durationSeconds: media.duration,
            canSeek: media.frozen ? undefined : seekBounds(video.duration, rangesOf(video.seekable)).seekable,
            paused: video.paused,
            muted: video.muted,
            volume: video.volume,
            audioStreamIndex: reportAudio,
            subtitleStreamIndex: reportSubtitle,
            playMethod: reportMethod,
            aspectRatio,
            startedAtMs
        }; }, {
            start: report => owner.isCurrent(session) ? client.reportPlaybackStart(report) : false,
            progress: report => owner.isCurrent(session) ? client.reportPlaybackProgress(report) : false,
            stop: (report, keepalive) => {
                const retained = owner.retainsLiveStream(session);
                return client.reportPlaybackStopped(retained ? { ...report, LiveStreamId: undefined } : report, keepalive).then(async saved => {
                    if (saved && !keepalive && owner.canRefresh(session)) onReported?.(itemId);
                    if (saved && liveStreamId && !retained) owner.markLiveReleased(session);
                    if (!saved && liveStreamId && owner.claimLiveCleanup(session)) {
                        if (await client.closeLiveStream(liveStreamId)) owner.markLiveReleased(session);
                    }
                    return saved;
                });
            }
        });
        reporterRef.current = reporter;
        const onPlay = () => {
            if (!owner.isCurrent(session)) return;
            if (liveStreamId && !owner.liveStreamFor(session)) return;
            if (!applyStartPosition(video)) return;
            rememberPosition(video);
            if (!reporter.isStarted) reporter.restart();
            else reporter.pulse();
        };
        const onPulse = () => { if (owner.isCurrent(session)) reporter.pulse(); };
        const onEnded = () => {
            reporter.stop(false);
            if (owner.isCurrent(session)) endedRef.current();
        };
        const onMediaError = () => reporter.stop(true);
        let pageHidden = false;
        const onHide = () => { pageHidden = true; reporter.stop(false, true); };
        const onShow = () => {
            if (!pageHidden || video.ended || !owner.isCurrent(session)) return;
            pageHidden = false;
            void reporter.stopAsync(false, true).then(() => {
                if (!owner.isCurrent(session)) return;
                if (liveStreamId) void renegotiate({}, message => setPlaybackError(message));
                else reporter.resumeAfterHide();
            });
        };
        video.addEventListener('play', onPlay);
        const onReady = () => { if (!video.paused) onPlay(); };
        video.addEventListener('canplay', onReady);
        video.addEventListener('pause', onPulse);
        video.addEventListener('seeked', onPulse);
        video.addEventListener('volumechange', onPulse);
        video.addEventListener('ended', onEnded);
        video.addEventListener('error', onMediaError);
        window.addEventListener('pagehide', onHide);
        window.addEventListener('pageshow', onShow);
        if (!video.paused && video.readyState >= 1) onPlay();
        return () => {
            window.removeEventListener('pagehide', onHide);
            window.removeEventListener('pageshow', onShow);
            video.removeEventListener('play', onPlay);
            video.removeEventListener('canplay', onReady);
            video.removeEventListener('pause', onPulse);
            video.removeEventListener('seeked', onPulse);
            video.removeEventListener('volumechange', onPulse);
            video.removeEventListener('ended', onEnded);
            video.removeEventListener('error', onMediaError);
            if (mediaRef.current === media) rememberPosition(video);
            // The stop report already carries LiveStreamId and lets the server
            // close the tuner. Close explicitly only when stop delivery fails.
            media.frozen = true;
            void reporter.stopAsync(false).then(async saved => {
                if (saved || !liveStreamId) return;
                if (!owner.claimLiveCleanup(session)) return;
                if (await client.closeLiveStream(liveStreamId)) owner.markLiveReleased(session);
            });
            if (reporterRef.current === reporter) reporterRef.current = null;
        };
    }, [ api, item?.Id, url, playback?.direct, playback?.streams, playbackSession?.key, playbackSession?.mediaSourceId, playbackSession?.playSessionId, playbackSession?.liveStreamId ]);

    useEffect(() => { reporterRef.current?.pulse(); }, [ audioIndex, subtitleIndex ]);

    useEffect(() => {
        const video = videoRef.current;
        if (video) video.playbackRate = speed;
    }, [ speed, url ]);

    useLayoutEffect(() => {
        subtitleIndexRef.current = playback ? initialSubtitleIndex(playback) : null;
        audioIndexRef.current = playback ? initialAudioIndex(playback) : null;
        setSubtitleIndex(subtitleIndexRef.current);
        setAudioIndex(audioIndexRef.current);
    }, [ playback?.mediaSourceId, url, playbackSession?.key ]);

    useEffect(() => {
        setSubtitleOffset(0);
        offsetRef.current = 0;
        setSubtitleNote('');
        setAudioNote('');
    }, [ item?.Id ]);

    useEffect(() => {
        if (!api || !playback || playback.method === 'DirectPlay') return;
        let active = true;
        const timer = window.setTimeout(() => {
            void api.getPlaybackDiagnostics().then(info => { if (active) setDiagnostics(info); }).catch(() => undefined);
        }, 3000);
        return () => { active = false; window.clearTimeout(timer); };
    }, [ api, url, playback?.method ]);

    useEffect(() => {
        if (menu !== 'settings' || !api || !playback || playback.method === 'DirectPlay') return;
        let active = true;
        void api.getPlaybackDiagnostics().then(info => { if (active) setDiagnostics(info); }).catch(() => undefined);
        return () => { active = false; };
    }, [ menu, api, url ]);

    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;
        const onEnter = () => setPip(true);
        const onLeave = () => setPip(false);
        video.addEventListener('enterpictureinpicture', onEnter);
        video.addEventListener('leavepictureinpicture', onLeave);
        return () => {
            video.removeEventListener('enterpictureinpicture', onEnter);
            video.removeEventListener('leavepictureinpicture', onLeave);
        };
    }, []);

    useEffect(() => {
        if (!subtitleUrl) return;
        const video = videoRef.current;
        if (!video) return;
        const apply = () => applySubtitleOffset(video, offsetRef.current - mediaRef.current.offset, cueLine);
        video.textTracks.addEventListener('addtrack', apply);
        const timer = window.setTimeout(apply, 400);
        return () => {
            video.textTracks.removeEventListener('addtrack', apply);
            window.clearTimeout(timer);
        };
    }, [ subtitleUrl, secondaryUrl, subtitleOffset ]);

    useEffect(() => {
        const video = videoRef.current;
        if (!video || !playback || subtitleIndex === null || selectedSubtitle?.DeliveryMethod !== 'Embed') return;
        let requested = false;
        const apply = () => {
            if (applyEmbeddedSubtitle(video, playback.streams, subtitleIndex)) return;
            if (video.readyState < 3 || requested) return;
            requested = true;
            void renegotiate({ subtitleStreamIndex: subtitleIndex, forceTranscode: true }, message => setSubtitleNote(message));
        };
        video.addEventListener('canplay', apply);
        video.textTracks.addEventListener('addtrack', apply);
        apply();
        return () => { video.removeEventListener('canplay', apply); video.textTracks.removeEventListener('addtrack', apply); };
    }, [ url, subtitleIndex, playbackSession?.key ]);

    useEffect(() => {
        if (!activeSegment) return;
        if (segmentChoice === 'skip') {
            skippedSegments.current.add(activeSegmentKey);
            withVideo(video => {
                video.currentTime = clampSeek(mediaPosition(activeSegment.end, mediaRef.current.offset), seekBounds(video.duration, rangesOf(video.seekable)));
                rememberPosition(video);
                setCurrentTime(itemPosition(video.currentTime, mediaRef.current.offset));
            });
            setSkipNote(`Skipped ${SEGMENT_LABELS[activeSegment.kind].toLowerCase()}`);
            const timer = window.setTimeout(() => setSkipNote(''), 3000);
            return () => window.clearTimeout(timer);
        }
        if (segmentChoice === 'prompt') setPromptEntry({ key: activeSegmentKey, at: currentTime });
    }, [ activeSegmentKey ]);

    useEffect(() => playQueue.subscribe(setQueue), []);
    useEffect(() => {
        setUpNextCard(null);
        playQueue.set(syncQueue(playQueue.get(), item));
    }, [ item?.Id ]);
    const upNextOpen = Boolean(upNextCard);
    useEffect(() => {
        if (!upNextOpen) return;
        rootRef.current?.querySelector<HTMLElement>('.player-up-next .button.primary')?.focus();
        const timer = window.setInterval(() => setUpNextCard(card => card && { ...card, remaining: card.remaining - 1 }), 1000);
        return () => window.clearInterval(timer);
    }, [ upNextOpen ]);
    useEffect(() => {
        if (upNextCard && upNextCard.remaining <= 0) playQueued(upNextCard);
    }, [ upNextCard?.remaining ]);

    const promptOutsideOsd = skipPromptShown && !osdOpen;
    useEffect(() => {
        if (promptOutsideOsd && tvRef.current) {
            rootRef.current?.querySelector<HTMLElement>('.player-skip-prompt button')?.focus();
            return;
        }
        const active = document.activeElement;
        if (!promptOutsideOsd && active instanceof Element && active.closest('.player-skip-prompt')) rootRef.current?.focus();
    }, [ promptOutsideOsd ]);

    useEffect(() => {
        skippedSegments.current = new Set();
        setPromptEntry(null);
        setSecondaryIndex(null);
    }, [ item?.Id ]);

    // Seasons and one season's episodes at a time keep long-running series reachable without loading every episode.
    useEffect(() => {
        setSeasonList([]);
        setEpisodesBySeason({});
        if (!api || !item?.SeriesId) return;
        let active = true;
        void api.getSeasons(item.SeriesId).then(response => {
            if (!active) return;
            const list = (response.Items || []).slice().sort((left, right) => (left.IndexNumber ?? 999) - (right.IndexNumber ?? 999));
            setSeasonList(list);
            setSeasonId(current => current || item.SeasonId || list.find(entry => entry.IndexNumber === item.ParentIndexNumber)?.Id || list[0]?.Id);
        }).catch(() => {
            if (active) setEpisodeState('error');
        });
        return () => { active = false; };
    }, [ api, item?.SeriesId ]);

    useEffect(() => { if (item?.SeasonId) setSeasonId(item.SeasonId); }, [ item?.Id, item?.SeasonId ]);

    useEffect(() => {
        if (!api || !item?.SeriesId || !seasonId) {
            setEpisodeState('idle');
            return;
        }
        if (episodesBySeason[seasonId]) {
            setEpisodeState('ready');
            return;
        }
        let active = true;
        setEpisodeState('loading');
        void api.getAllSeasonEpisodes(item.SeriesId, seasonId).then(list => {
            if (!active) return;
            setEpisodesBySeason(current => ({ ...current, [seasonId]: list }));
            setEpisodeState('ready');
        }).catch(() => {
            if (active) setEpisodeState('error');
        });
        return () => { active = false; };
    }, [ api, item?.SeriesId, seasonId, episodesBySeason ]);

    useEffect(() => {
        setNeighbours({ previous: null, next: null });
        if (!api || !item?.SeriesId || !item.Id) return;
        let active = true;
        void api.getAdjacentEpisodes(item.SeriesId, item.Id).then(list => {
            if (active) setNeighbours(adjacentEpisodes(list, item.Id));
        }).catch(() => undefined);
        return () => { active = false; };
    }, [ api, item?.SeriesId, item?.Id ]);

    useEffect(() => {
        if (!api || !item?.Id) {
            setCues([]);
            setChapters([]);
            setTrickplay(null);
            return;
        }
        let active = true;
        void api.getMediaSegments(item.Id).then(segments => {
            if (active) setCues(timelineCues(segments));
        }).catch(() => { if (active) setCues([]); });
        void api.getChapters(item.Id).then(raw => {
            if (active) setChapters(chapterList(raw, (item.RunTimeTicks || 0) / 10_000_000));
        }).catch(() => { if (active) setChapters([]); });
        void api.getTrickplay(item.Id).then(manifest => {
            if (active) setTrickplay(pickTrickplay(manifest, playback?.mediaSourceId));
        }).catch(() => { if (active) setTrickplay(null); });
        return () => { active = false; };
    }, [ api, item?.Id, playback?.mediaSourceId ]);

    useEffect(() => {
        if (menu !== 'episodes') return;
        document.querySelector('.player-episode.current')?.scrollIntoView({ block: 'nearest' });
    }, [ menu, item?.Id, seasonId, visibleEpisodes.length ]);

    useEffect(() => {
        const onFullscreenChange = () => setFullscreen(currentFullscreenElement() === rootRef.current);
        document.addEventListener('fullscreenchange', onFullscreenChange);
        document.addEventListener('webkitfullscreenchange', onFullscreenChange);
        document.addEventListener('mozfullscreenchange', onFullscreenChange);
        return () => {
            document.removeEventListener('fullscreenchange', onFullscreenChange);
            document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
            document.removeEventListener('mozfullscreenchange', onFullscreenChange);
        };
    }, []);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.ctrlKey || event.altKey || event.metaKey) return;
            if (event.key === 'Tab' && rootRef.current) {
                // Keyboard focus must never land on controls the user cannot see.
                if (!osdRef.current) {
                    event.preventDefault();
                    reveal();
                    window.requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>('.player-play, .player-control')?.focus());
                    return;
                }
                reveal();
                const controls = Array.from(rootRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')).filter(el => el.getClientRects().length);
                if (controls.length) {
                    const first = controls[0], last = controls[controls.length - 1];
                    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); return; }
                    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); return; }
                }
            }
            const key = event.key;
            const back = key === 'Escape' || key === 'Backspace' || key === 'Back' || key === 'BrowserBack' || key === 'GoBack' || event.keyCode === 461 || event.keyCode === 10009;
            if (back) {
                event.preventDefault();
                event.stopPropagation();
                if (menuRef.current) {
                    menuRef.current = null;
                    setMenu(null);
                    reveal();
                    return;
                }
                if (upNextRef.current) {
                    setUpNextCard(null);
                    reveal();
                    return;
                }
                if (osdRef.current) hideOsd();
                else onBackRef.current();
                return;
            }
            const action = classifyPlayerKey(key, event.keyCode);
            const onSkipPrompt = event.target instanceof Element && Boolean(event.target.closest('.player-skip-prompt, .player-up-next'));
            if (action === 'select' && !osdRef.current && !onSkipPrompt) {
                event.preventDefault();
                reveal();
                return;
            }
            if (action === 'toggle' || action === 'play' || action === 'pause' || action === 'stop') {
                event.preventDefault();
                if (action === 'stop') {
                    onBackRef.current();
                    return;
                }
                withVideo(video => {
                    if (action === 'play') void video.play();
                    else if (action === 'pause') video.pause();
                    else if (video.paused) void video.play();
                    else video.pause();
                });
                reveal();
                return;
            }
            const inOverlay = event.target instanceof Element && Boolean(event.target.closest('.player-drawer, .player-menu'));
            if (inOverlay) {
                reveal();
                return;
            }
            const arrow = key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown';
            if (tvRef.current && osdRef.current && arrow) return;
            if (event.target instanceof HTMLInputElement && (key === 'ArrowLeft' || key === 'ArrowRight')) {
                reveal();
                return;
            }
            if (key === ' ' || key === 'k' || key === 'K') {
                if (event.target instanceof HTMLButtonElement) {
                    reveal();
                    return;
                }
                event.preventDefault();
                togglePlay();
                return;
            }
            if (key === 'ArrowLeft' || key === 'j' || key === 'J') {
                event.preventDefault();
                seekBy(-10);
                return;
            }
            if (key === 'ArrowRight' || key === 'l' || key === 'L') {
                event.preventDefault();
                seekBy(10);
                return;
            }
            if (key === 'ArrowUp') {
                event.preventDefault();
                withVideo(video => setPlayerVolume((video.muted ? 0 : video.volume) + 0.05, false));
                return;
            }
            if (key === 'ArrowDown') {
                event.preventDefault();
                withVideo(video => setPlayerVolume((video.muted ? 0 : video.volume) - 0.05, false));
                return;
            }
            if (key === 'm' || key === 'M') {
                event.preventDefault();
                toggleMute();
                return;
            }
            if (key === 'f' || key === 'F') {
                event.preventDefault();
                toggleFullscreen();
                return;
            }
            if (/^[0-9]$/.test(key)) {
                event.preventDefault();
                withVideo(video => {
                    const range = seekBounds(video.duration, rangesOf(video.seekable));
                    if (!range.seekable) return;
                    seekTo(range.start + (range.end - range.start) * (Number(key) / 10));
                });
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, []);

    const onPointerMove = (event: PointerEvent) => {
        if (event.pointerType === 'touch') return;
        const previous = lastPointer.current;
        const point = { x: event.clientX, y: event.clientY };
        lastPointer.current = point;
        if (!osdRef.current && previous && Math.hypot(point.x - previous.x, point.y - previous.y) < 8) return;
        reveal();
    };

    const onPointerDown = (event: PointerEvent) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest('.player-osd, .player-drawer, .player-error')) {
            reveal();
            return;
        }
        if (menuRef.current) {
            closeMenu();
            reveal();
            return;
        }
        if (event.pointerType === 'touch') {
            if (osdRef.current) hideOsd();
            else reveal();
            return;
        }
        if (event.button !== 0) return;
        if (clickTimer.current) {
            window.clearTimeout(clickTimer.current);
            clickTimer.current = undefined;
            return;
        }
        clickTimer.current = window.setTimeout(() => {
            clickTimer.current = undefined;
            togglePlay();
        }, 250);
    };

    const onDoubleClick = (event: MouseEvent) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest('.player-osd, .player-drawer, .player-error')) return;
        if (clickTimer.current) {
            window.clearTimeout(clickTimer.current);
            clickTimer.current = undefined;
        }
        toggleFullscreen();
    };

    const holdUntilRelease = (alsoDragging: boolean) => {
        if (alsoDragging) draggingRef.current = true;
        holdingRef.current = true;
        clearHideTimer();
        if (releaseRef.current) return;
        const release = () => {
            draggingRef.current = false;
            holdingRef.current = false;
            window.removeEventListener('pointerup', release);
            window.removeEventListener('pointercancel', release);
            releaseRef.current = null;
            if (!draggingRef.current) setSeekHover(null);
            if (aliveRef.current) reveal();
        };
        releaseRef.current = release;
        window.addEventListener('pointerup', release);
        window.addEventListener('pointercancel', release);
    };

    const hoverStyle = seekHover ? { left: `${Math.min(Math.max(seekHover.x, 90), Math.max(90, seekHover.width - 90))}px` } : undefined;
    const frameScale = hoverFrame ? 176 / hoverFrame.width : 1;

    return <div
        ref={rootRef}
        class="player-stage"
        tabIndex={-1}
        data-osd-open={osdOpen ? 'true' : 'false'}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onDblClick={onDoubleClick}
    >
        <video
            ref={videoRef}
            class="player-video"
            data-fit={fit}
            crossOrigin={crossOrigin}
            src={hlsPlayback ? undefined : url}
            autoPlay
            playsInline
            onEmptied={() => { if (mediaRef.current.loaded) mediaRef.current.frozen = true; }}
            onTimeUpdate={event => {
                const video = event.target as HTMLVideoElement;
                rememberPosition(video);
                if (!Number.isFinite(video.duration)) setLiveRanges(rangesOf(video.seekable));
                if (draggingRef.current || mediaRef.current.pendingStart > 0) return;
                setCurrentTime(itemPosition(video.currentTime || 0, mediaRef.current.offset));
            }}
            onLoadedMetadata={event => {
                const video = event.target as HTMLVideoElement;
                const media = mediaRef.current;
                media.loaded = true;
                applyStartPosition(video);
                rememberPosition(video);
                setDuration(itemPosition(video.duration || 0, media.offset));
                setLiveRanges(rangesOf(video.seekable));
                video.playbackRate = speed;
                video.volume = volume;
                const tracks = browserAudioTracks(video);
                const selected = audioStreams.findIndex(stream => stream.Index === audioIndexRef.current);
                if (playback?.method === 'DirectPlay' && tracks?.length === audioStreams.length && selected >= 0) {
                    for (let index = 0; index < tracks.length; index++) tracks[index].enabled = index === selected;
                }
            }}
            onDurationChange={event => setDuration(itemPosition((event.target as HTMLVideoElement).duration || 0, mediaRef.current.offset))}
            onPlay={() => { setPaused(false); pausedRef.current = false; reveal(); }}
            onPause={() => { setPaused(true); pausedRef.current = true; reveal(); }}
            onVolumeChange={event => {
                const video = event.target as HTMLVideoElement;
                setVolume(video.volume);
                setMuted(video.muted);
                choosePreference({ volume: video.volume });
            }}
            onError={() => {
                if (!aliveRef.current || hlsPlayback) return;
                setPaused(true);
                setPlaybackError(PLAYBACK_ERROR);
                reveal();
                onErrorRef.current();
            }}
        >
            {subtitleUrl && <track kind="subtitles" src={subtitleUrl} default label="Subtitles" onError={() => setSubtitleNote(crossOrigin
                ? 'Subtitles could not be loaded. The server must allow this site in its CORS hosts setting.'
                : 'Subtitles could not be loaded from the server.')} onLoad={() => withVideo(video => applySubtitleOffset(video, offsetRef.current - mediaRef.current.offset, cueLine))} />}
            {secondaryUrl && <track kind="subtitles" src={secondaryUrl} label={SECONDARY_TRACK_LABEL} onLoad={event => {
                (event.currentTarget as HTMLTrackElement).track.mode = 'showing';
                withVideo(video => applySubtitleOffset(video, offsetRef.current - mediaRef.current.offset, cueLine));
            }} onError={() => setSubtitleNote('Secondary subtitles could not be loaded from the server.')} />}
        </video>
        <style>{captionCss(captionStyle)}</style>
        {!osdOpen && skipPromptShown && skip && <div class="player-skip-prompt"><button data-focusable="true" class="player-skip" type="button" onClick={() => seekTo(skip.end)}>{skip.label}</button></div>}
        {skipNote && <p class="player-skip-note" role="status">{skipNote}</p>}
        {upNextCard && <div class="player-up-next" role="dialog" aria-label="Up next" data-focusable="scope">
            {api && <img src={api.imageUrl(upNextCard.item, 'Primary', 320)} alt="" />}
            <div>
                <p class="player-up-next-label">{upNextCard.source === 'queue' ? 'Next in queue' : 'Next episode'}</p>
                <strong>{playbackTitle(upNextCard.item)}</strong>
                <p role="status" aria-live="polite">Playing in {Math.max(0, upNextCard.remaining)}s</p>
                <div class="player-up-next-actions">
                    <button data-focusable="true" class="button primary" type="button" onClick={() => playQueued(upNextCard)}>Play now</button>
                    <button data-focusable="true" class="button secondary" type="button" onClick={() => setUpNextCard(null)}>Cancel</button>
                </div>
            </div>
        </div>}
        {playbackError && <div class="player-error" role="alert">
            <p>{playbackError}</p>
            {onRenegotiate && <div class="player-error-actions">
                <button data-focusable="true" class="button secondary" type="button" disabled={switching} onClick={() => { setPlaybackError(''); void renegotiate({}, message => setPlaybackError(message)); }}>Retry from {formatTime(mediaRef.current.position)}</button>
                {playback?.method !== 'Transcode' || !diagnostics || diagnostics.IsVideoDirect ? <button data-focusable="true" class="button secondary" type="button" disabled={switching} onClick={() => { setPlaybackError(''); void renegotiate({ forceTranscode: true }, message => setPlaybackError(message)); }}>Convert the stream</button> : null}
                <button data-focusable="true" class="button secondary" type="button" disabled={switching} onClick={() => { setPlaybackError(''); void renegotiate({ forceTranscode: true, maxBitrate: 4_000_000 }, message => setPlaybackError(message)); }}>Try lower quality</button>
            </div>}
        </div>}
        <header class="player-osd player-osd-top">
            <button data-focusable={focusable} class="player-back" type="button" onClick={() => onBackRef.current()}>← <span>Back</span></button>
            <h1>{title}</h1>
            {chapters.length > 0 && <button data-focusable={focusable} class="player-control player-chapters" type="button" aria-label="Chapters" aria-expanded={menu === 'chapters'} onClick={() => chooseMenu('chapters')}>
                <svg viewBox="0 0 24 24" class="player-icon" aria-hidden="true"><path d="M5 5v14M10 5h9M10 12h9M10 19h9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
            </button>}
            {isEpisode && <button data-focusable={focusable} class="player-control player-episodes" type="button" aria-label="Episodes" aria-expanded={menu === 'episodes'} onClick={() => chooseMenu('episodes')}>
                <svg viewBox="0 0 24 24" class="player-icon" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
            </button>}
        </header>
        <footer class="player-osd player-osd-bottom">
            {skip && <div class="player-skip-row"><button data-focusable={focusable} class="player-skip" type="button" onClick={() => seekTo(skip.end)}>{skip.label}</button></div>}
            <div class="player-timeline">
                <span class="player-time">{bounds.live ? (bounds.seekable ? `−${formatTime(Math.max(0, bounds.end - currentTime))}` : 'LIVE') : formatTime(currentTime)}</span>
                <div
                    class="player-seek-wrap"
                    ref={seekWrapRef}
                    onPointerMove={event => {
                        if (event.pointerType === 'touch' && !draggingRef.current) return;
                        const rect = seekWrapRef.current?.getBoundingClientRect();
                        if (!rect || !rect.width) return;
                        const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
                        if (!bounds.seekable) return;
                        placeSeekHover(event.clientX, bounds.start + ratio * (bounds.end - bounds.start));
                    }}
                    onPointerLeave={() => { if (!draggingRef.current) setSeekHover(null); }}
                >
                    <div class="player-cues" aria-hidden="true">
                        {cues.map(cue => {
                            const box = bounds.live ? null : cueBox(cue, duration);
                            if (!box) return null;
                            return <span key={`${cue.kind}-${cue.start}`} class={`player-cue ${cue.kind}`} style={box} />;
                        })}
                        {!bounds.live && duration > 0 && chapters.slice(1).map(chapter => <span key={chapter.index} class="player-chapter-mark" style={{ left: `${Math.min(100, chapter.start / duration * 100)}%` }} />)}
                    </div>
                    {seekHover && <div class="player-trickplay" style={hoverStyle}>
                        {!hoverTile && hoverChapter?.imageTag && api && item && <img class="player-chapter-thumb" src={api.chapterImageUrl(item.Id, hoverChapter.index, hoverChapter.imageTag, 176)} alt="" />}
                        {hoverChapter && <strong class="player-chapter-name">{hoverChapter.name}</strong>}
                        {hoverFrame && hoverTile && <div class="player-trickplay-frame" style={{ width: '176px', height: `${hoverFrame.height * frameScale}px`, backgroundImage: `url("${hoverTile}")`, backgroundPosition: `-${hoverFrame.x * frameScale}px -${hoverFrame.y * frameScale}px`, backgroundSize: `${hoverFrame.sheetWidth * frameScale}px ${hoverFrame.sheetHeight * frameScale}px` }} />}
                        <span>{formatTime(seekHover.time)}</span>
                    </div>}
                    <input
                        data-focusable={focusable}
                        class="player-slider player-seek"
                        type="range"
                        min={bounds.start}
                        max={bounds.end}
                        step="0.1"
                        value={Math.min(Math.max(currentTime, bounds.start), bounds.end)}
                        aria-label={bounds.live ? 'Seek within the live buffer' : 'Seek'}
                        disabled={!bounds.seekable}
                        onPointerDown={() => holdUntilRelease(true)}
                        onInput={event => {
                            const next = clampSeek(Number((event.target as HTMLInputElement).value), bounds);
                            setCurrentTime(next);
                            seekTo(next);
                            const rect = seekWrapRef.current?.getBoundingClientRect();
                            const span = bounds.end - bounds.start;
                            if (rect) setSeekHover({ time: next, x: span > 0 ? ((next - bounds.start) / span) * rect.width : 0, width: rect.width });
                        }}
                        onFocus={() => {
                            const rect = seekWrapRef.current?.getBoundingClientRect();
                            const span = bounds.end - bounds.start;
                            if (!rect || span <= 0) return;
                            setSeekHover({ time: currentTime, x: ((currentTime - bounds.start) / span) * rect.width, width: rect.width });
                        }}
                        onBlur={() => { if (!draggingRef.current) setSeekHover(null); }}
                    />
                </div>
                {bounds.live
                    ? <button data-focusable={focusable} class="player-time player-live-edge" type="button" disabled={!bounds.seekable || bounds.end - currentTime < 10} onClick={() => seekTo(bounds.end)}>Go live</button>
                    : <span class="player-time">{formatTime(duration)}</span>}
            </div>
            <div class="player-transport">
                {queueCurrent
                    ? <button data-focusable={focusable} class="player-control" type="button" aria-label="Previous in queue" disabled={!queuePrevious} onClick={() => playQueued(queuePrevious)}>|◀</button>
                    : isEpisode && <button data-focusable={focusable} class="player-control" type="button" aria-label="Previous episode" disabled={!neighbours.previous} onClick={() => neighbours.previous && onPlayItemRef.current(neighbours.previous)}>|◀</button>}
                {chapters.length > 0 && <button data-focusable={focusable} class="player-control" type="button" aria-label="Previous chapter" onClick={() => { const target = adjacentChapterStart(chapters, currentTime, -1); if (target !== null) seekTo(target); }}>⏮</button>}
                <button data-focusable={focusable} class="player-control" type="button" aria-label="Rewind 10 seconds" onClick={() => seekBy(-10)}>−10</button>
                <button data-focusable={focusable} class="player-control player-play" type="button" aria-label={paused ? 'Play' : 'Pause'} onClick={togglePlay}>{paused ? '▶' : '❚❚'}</button>
                <button data-focusable={focusable} class="player-control" type="button" aria-label="Fast forward 10 seconds" onClick={() => seekBy(10)}>+10</button>
                {chapters.length > 0 && <button data-focusable={focusable} class="player-control" type="button" aria-label="Next chapter" disabled={adjacentChapterStart(chapters, currentTime, 1) === null} onClick={() => { const target = adjacentChapterStart(chapters, currentTime, 1); if (target !== null) seekTo(target); }}>⏭</button>}
                {queueCurrent
                    ? <button data-focusable={focusable} class="player-control" type="button" aria-label={queueNext ? `Next in queue: ${playbackTitle(queueNext.item)}` : 'Next in queue'} disabled={!queueNext} onClick={() => playQueued(queueNext)}>▶|</button>
                    : isEpisode && <button data-focusable={focusable} class="player-control" type="button" aria-label="Next episode" disabled={!neighbours.next} onClick={() => neighbours.next && onPlayItemRef.current(neighbours.next)}>▶|</button>}
                {queueCurrent && queue.order.length > 1 && <button data-focusable={focusable} class={queue.shuffle ? 'player-control active' : 'player-control'} type="button" aria-label="Shuffle queue" aria-pressed={queue.shuffle} onClick={() => playQueue.update(current => toggleShuffle(current))}>⤮</button>}
                {queueCurrent && <button data-focusable={focusable} class={queue.repeat !== 'off' ? 'player-control active' : 'player-control'} type="button" aria-label={REPEAT_LABELS[queue.repeat]} title={`${upcoming(queue).length} more in queue`} onClick={() => playQueue.update(current => ({ ...current, repeat: cycleRepeat(current.repeat) }))}>{queue.repeat === 'one' ? '🔂' : '🔁'}</button>}
                <div class="player-pop">
                    <button data-focusable={focusable} class={menu === 'captions' ? 'player-control active' : 'player-control'} type="button" aria-label="Audio and subtitles" aria-expanded={menu === 'captions'} onClick={() => chooseMenu('captions')}>CC</button>
                    {menu === 'captions' && <div class="player-menu" role="dialog" aria-label="Audio and subtitles">
                        <p class="player-menu-label">Audio</p>
                        {audioStreams.length ? audioStreams.map(stream => <button data-focusable={focusable} key={stream.Index} class={audioIndex === stream.Index ? 'player-menu-item active' : 'player-menu-item'} aria-pressed={audioIndex === stream.Index} type="button" onClick={() => selectAudio(stream.Index)}>{streamLabel(stream)}</button>) : <p class="player-menu-note">No alternate audio tracks were reported.</p>}
                        {audioNote && <p class="player-menu-note">{audioNote}</p>}
                        <p class="player-menu-label">Subtitles</p>
                        <button data-focusable={focusable} class={subtitleIndex === null ? 'player-menu-item active' : 'player-menu-item'} aria-pressed={subtitleIndex === null} type="button" onClick={() => selectSubtitle(null)}>Off</button>
                        {subtitleStreams.map(stream => <button data-focusable={focusable} key={stream.Index} class={subtitleIndex === stream.Index ? 'player-menu-item active' : 'player-menu-item'} aria-pressed={subtitleIndex === stream.Index} type="button" disabled={switching} onClick={() => selectSubtitle(stream.Index)}>{streamLabel(stream)}{stream.IsTextSubtitleStream ? '' : ' · burned in'}</button>)}
                        {subtitleNote && <p class="player-menu-note">{subtitleNote}</p>}
                        {styledSubtitle && <p class="player-menu-note">Styled ASS/SSA subtitles show as plain text here. To keep their styling, choose “Also burn in styled ASS/SSA subtitles” under Subtitle preferences.</p>}
                        {subtitleStreams.some(stream => stream.IsTextSubtitleStream && stream.Index !== subtitleIndex) && <>
                            <p class="player-menu-label">Secondary subtitles</p>
                            <button data-focusable={focusable} class={secondaryIndex === null ? 'player-menu-item active' : 'player-menu-item'} aria-pressed={secondaryIndex === null} type="button" onClick={() => { setSecondaryIndex(null); reveal(); }}>Off</button>
                            {subtitleStreams.filter(stream => stream.IsTextSubtitleStream && stream.Index !== subtitleIndex).map(stream => <button data-focusable={focusable} key={stream.Index} class={secondaryIndex === stream.Index ? 'player-menu-item active' : 'player-menu-item'} aria-pressed={secondaryIndex === stream.Index} type="button" onClick={() => { setSecondaryIndex(stream.Index); reveal(); }}>{streamLabel(stream)}</button>)}
                            <p class="player-menu-note">Secondary subtitles appear at the top of the picture.</p>
                        </>}
                        <div class="player-offset">
                            <span>Subtitle offset</span>
                            <button data-focusable={focusable} type="button" onClick={() => shiftSubtitles(-0.5)} aria-label="Shift subtitles earlier">−0.5s</button>
                            <strong>{subtitleOffset > 0 ? `+${subtitleOffset.toFixed(1)}s` : `${subtitleOffset.toFixed(1)}s`}</strong>
                            <button data-focusable={focusable} type="button" onClick={() => shiftSubtitles(0.5)} aria-label="Shift subtitles later">+0.5s</button>
                        </div>
                    </div>}
                </div>
                <div class="player-volume-pop">
                    <button data-focusable={focusable} class="player-control" type="button" aria-label={muted || volume === 0 ? 'Unmute' : 'Mute'} onClick={toggleMute}>{muted || volume === 0 ? '🔇' : '🔊'}</button>
                    {!compactControls && <div class="player-volume-flyout">
                        <input
                            data-focusable={focusable}
                            class="player-slider player-volume"
                            type="range"
                            min="0"
                            max="100"
                            step="1"
                            value={Math.round((muted ? 0 : volume) * 100)}
                            aria-label="Volume"
                            onPointerDown={() => holdUntilRelease(false)}
                            onInput={event => setPlayerVolume(Number((event.target as HTMLInputElement).value) / 100, false)}
                        />
                    </div>}
                </div>
                <div class="player-pop">
                    <button data-focusable={focusable} class={menu === 'settings' ? 'player-control active' : 'player-control'} type="button" aria-label="Playback settings" aria-expanded={menu === 'settings'} onClick={() => chooseMenu('settings')}>⚙</button>
                    {menu === 'settings' && <div class="player-menu" role="dialog" aria-label="Playback settings">
                        <p class="player-menu-label">Playback speed</p>
                        <div class="player-speed-row">
                            {PLAYER_SPEEDS.map(value => <button data-focusable={focusable} key={value} class={speed === value ? 'player-menu-item active' : 'player-menu-item'} aria-pressed={speed === value} type="button" onClick={() => { setSpeed(value); choosePreference({ speed: value }); withVideo(video => { video.playbackRate = value; }); reveal(); }}>{value}×</button>)}
                        </div>
                        <p class="player-menu-label">Aspect ratio</p>
                        {([ [ 'contain', 'Original' ], [ 'cover', 'Zoom' ], [ 'fill', 'Stretch' ] ] as Array<[AspectFit, string]>).map(([ value, label ]) => <button data-focusable={focusable} key={value} class={fit === value ? 'player-menu-item active' : 'player-menu-item'} aria-pressed={fit === value} type="button" onClick={() => { setFit(value); choosePreference({ fit: value }); }}>{label}</button>)}
                        {videoStream?.AspectRatio && <p class="player-menu-note">Source frame {videoStream.AspectRatio}.</p>}
                        {playback?.versions && <>
                            <p class="player-menu-label">Version</p>
                            {playback.versions.map(version => <button data-focusable={focusable} key={version.id} class={playback.mediaSourceId === version.id ? 'player-menu-item active' : 'player-menu-item'} aria-pressed={playback.mediaSourceId === version.id} type="button" disabled={switching || !onRenegotiate} onClick={() => {
                                if (playback.mediaSourceId === version.id) return;
                                rememberVersion(item?.SeriesId, version.name);
                                void renegotiate({ mediaSourceId: version.id, audioStreamIndex: undefined, subtitleStreamIndex: undefined }, message => setPlaybackError(message));
                            }}>{version.name}</button>)}
                        </>}
                        <p class="player-menu-label">Quality</p>
                        <div class="player-speed-row">
                            {BITRATE_CHOICES.map(choice => <button data-focusable={focusable} key={choice.value} class={(playback?.maxBitrate || 0) === choice.value ? 'player-menu-item active' : 'player-menu-item'} type="button" disabled={switching || !onRenegotiate} onClick={() => { if ((playback?.maxBitrate || 0) !== choice.value) void renegotiate({ maxBitrate: choice.value || undefined }, message => setPlaybackError(message)); }}>{choice.label}</button>)}
                        </div>
                        <p class="player-menu-note">{formatBitrate(diagnostics?.Bitrate || playback?.bitrate)} · {describePlayMethod(playMethod, diagnostics)}. The default quality is set under Playback preferences.</p>
                        <p class="player-menu-label">Transcode reasons</p>
                        <p class="player-menu-note">{describeTranscode(diagnostics?.TranscodeReasons ?? playback?.transcodeReasons, playMethod === 'DirectPlay')}</p>
                    </div>}
                </div>
                {pipSupported && <button data-focusable={focusable} class={pip ? 'player-control active' : 'player-control'} type="button" aria-pressed={pip} aria-label={pip ? 'Exit picture-in-picture' : 'Picture-in-picture'} onClick={togglePictureInPicture}>⧉</button>}
                <button data-focusable={focusable} class="player-control" type="button" aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} onClick={toggleFullscreen}>{fullscreen ? '⤡' : '⛶'}</button>
            </div>
        </footer>
        {menu === 'chapters' && <aside class="player-drawer" role="dialog" aria-label="Chapters">
            <div class="player-drawer-head">
                <div><p class="eyebrow">CHAPTERS</p><h2>{title}</h2></div>
                <button data-focusable="true" class="player-control" type="button" aria-label="Close chapters" onClick={closeMenu}>×</button>
            </div>
            <div class="player-episode-list">
                {chapters.map((chapter, position) => <button data-focusable="true" key={chapter.index} class={position === chapterIndex ? 'player-episode current' : 'player-episode'} type="button" onClick={() => { seekTo(chapter.start); closeMenu(); }}>
                    <span class="player-episode-art">{chapter.imageTag && api && item ? <img src={api.chapterImageUrl(item.Id, chapter.index, chapter.imageTag)} alt="" loading="lazy" /> : <span class="player-chapter-number">{position + 1}</span>}</span>
                    <span class="player-episode-copy"><strong>{chapter.name}</strong><small>{formatTime(chapter.start)}</small></span>
                </button>)}
            </div>
        </aside>}
        {menu === 'episodes' && <aside class="player-drawer" role="dialog" aria-label="Episodes">
            <div class="player-drawer-head">
                <div>
                    <p class="eyebrow">EPISODES</p>
                    <h2>{item?.SeriesName || 'This series'}</h2>
                </div>
                <button data-focusable="true" class="player-control" type="button" aria-label="Close episodes" onClick={closeMenu}>×</button>
            </div>
            {seasonList.length > 1 && <div class="player-season-row">
                {seasonList.map(entry => <button data-focusable="true" key={entry.Id} class={entry.Id === seasonId ? 'player-season active' : 'player-season'} type="button" aria-pressed={entry.Id === seasonId} onClick={() => setSeasonId(entry.Id)}>{entry.Name || seasonLabel(entry.IndexNumber)}</button>)}
            </div>}
            <div class="player-episode-list">
                {episodeState === 'error' && <p class="player-menu-note">Episodes could not be loaded. <button data-focusable="true" class="button secondary" type="button" onClick={() => { setEpisodeState('idle'); setEpisodesBySeason(current => ({ ...current })); }}>Retry</button></p>}
                {episodeState === 'loading' && <p class="player-menu-note">Loading episodes…</p>}
                {episodeState === 'ready' && !visibleEpisodes.length && <p class="player-menu-note">No episodes in this season.</p>}
                {visibleEpisodes.map(episode => <button data-focusable="true" key={episode.Id} class={episode.Id === item?.Id ? 'player-episode current' : 'player-episode'} type="button" onClick={() => { if (episode.Id !== item?.Id) onPlayItemRef.current(episode); }}>
                    {api && <span class="player-episode-art">{<EpisodeThumb api={api} item={episode} />}</span>}
                    <span class="player-episode-copy">
                        <strong>{episode.IndexNumber !== undefined ? `${episode.IndexNumber}. ` : ''}{episode.Name}</strong>
                        {episode.RunTimeTicks ? <small>{Math.round(episode.RunTimeTicks / 600000000)} min</small> : null}
                    </span>
                </button>)}
            </div>
        </aside>}
    </div>;
}
