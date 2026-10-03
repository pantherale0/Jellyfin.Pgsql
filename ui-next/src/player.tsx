import { useEffect, useRef, useState } from 'preact/hooks';
import { JellyfinApi, peekCachedImage, releaseCachedImage, retainCachedImage } from './api';
import type { MediaItem } from './types';
import { PlaybackReporter } from './playback-report';
import { isHlsUrl } from './live-model';
import { activeCue, cueBox, describeTranscode, formatBitrate, pickTrickplay, playbackTitle, seasonLabel, streamKind, streamLabel, timelineCues, trickplayFrame, type PlaybackChoice, type TimelineCue, type TrickplayLevel } from './player-model';

interface PlayerProps {
    url: string;
    item: MediaItem | null;
    playback: PlaybackChoice | null;
    api: JellyfinApi | null;
    tvClient: boolean;
    onBack: () => void;
    onError: () => void;
    onPlayItem: (item: MediaItem) => void;
    onPlaybackReported?: (itemId: string) => void;
}

type PlayerMenu = 'episodes' | 'captions' | 'settings' | null;
type AspectFit = 'contain' | 'cover' | 'fill';

const SPEEDS = [ 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2 ];
const PLAYBACK_ERROR = 'Playback could not start in this browser. Try another quality or playback method.';

let nativeHlsSupport: boolean | undefined;

function canPlayNativeHls(): boolean {
    if (nativeHlsSupport !== undefined) return nativeHlsSupport;
    const video = document.createElement('video');
    const supports = (type: string) => Boolean(video.canPlayType && video.canPlayType(type).replace(/no/, ''));
    nativeHlsSupport = supports('application/vnd.apple.mpegurl') || supports('application/x-mpegURL');
    return nativeHlsSupport;
}
const cueBases = new WeakMap<TextTrackCue, { start: number; end: number }>();

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

function applySubtitleOffset(video: HTMLVideoElement, offset: number) {
    for (let index = 0; index < video.textTracks.length; index++) {
        const cues = video.textTracks[index].cues;
        if (!cues) continue;
        for (let cueIndex = 0; cueIndex < cues.length; cueIndex++) {
            const cue = cues[cueIndex];
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

export function Player({ url, item, playback, api, tvClient, onBack, onError, onPlayItem, onPlaybackReported }: PlayerProps) {
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
    const positionRef = useRef(0);
    const durationRef = useRef(0);
    const offsetRef = useRef(0);
    const aliveRef = useRef(true);
    const tvRef = useRef(tvClient);
    const [ currentTime, setCurrentTime ] = useState(0);
    const [ duration, setDuration ] = useState(0);
    const [ paused, setPaused ] = useState(true);
    const [ muted, setMuted ] = useState(false);
    const [ volume, setVolume ] = useState(1);
    const [ osdOpen, setOsdOpen ] = useState(true);
    const [ fullscreen, setFullscreen ] = useState(false);
    const [ playbackError, setPlaybackError ] = useState('');
    const [ menu, setMenu ] = useState<PlayerMenu>(null);
    const [ episodes, setEpisodes ] = useState<MediaItem[]>([]);
    const [ episodeState, setEpisodeState ] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
    const [ season, setSeason ] = useState<number | undefined>(item?.ParentIndexNumber);
    const [ cues, setCues ] = useState<TimelineCue[]>([]);
    const [ trickplay, setTrickplay ] = useState<TrickplayLevel | null>(null);
    const [ seekHover, setSeekHover ] = useState<{ time: number; x: number; width: number } | null>(null);
    const [ subtitleIndex, setSubtitleIndex ] = useState<number | null>(null);
    const [ subtitleOffset, setSubtitleOffset ] = useState(0);
    const [ subtitleNote, setSubtitleNote ] = useState('');
    const [ audioIndex, setAudioIndex ] = useState<number | null>(null);
    const [ audioNote, setAudioNote ] = useState('');
    const [ speed, setSpeed ] = useState(1);
    const [ fit, setFit ] = useState<AspectFit>('contain');
    const compactControls = useCompactControls(tvClient);
    const focusable = osdOpen ? 'true' : undefined;
    const title = playbackTitle(item);
    const isEpisode = Boolean(item?.SeriesId || item?.Type === 'Episode');
    const orderedEpisodes = episodes.slice().sort((left, right) => (left.ParentIndexNumber ?? 0) - (right.ParentIndexNumber ?? 0) || (left.IndexNumber ?? 0) - (right.IndexNumber ?? 0));
    const episodeIndex = orderedEpisodes.findIndex(episode => episode.Id === item?.Id);
    const seasons = Array.from(new Set(orderedEpisodes.map(episode => episode.ParentIndexNumber))).sort((left, right) => (left ?? 999) - (right ?? 999));
    const visibleEpisodes = orderedEpisodes.filter(episode => episode.ParentIndexNumber === season);
    const audioStreams = (playback?.streams || []).filter(stream => streamKind(stream.Type) === 'audio');
    const subtitleStreams = (playback?.streams || []).filter(stream => streamKind(stream.Type) === 'subtitle');
    const videoStream = (playback?.streams || []).find(stream => streamKind(stream.Type) === 'video');
    const selectedSubtitle = subtitleStreams.find(stream => stream.Index === subtitleIndex);
    const subtitleUrl = api && item && playback && selectedSubtitle?.IsTextSubtitleStream
        ? api.subtitleUrl(item.Id, playback.mediaSourceId, selectedSubtitle.Index)
        : '';
    const skip = activeCue(cues, currentTime);
    const hoverFrame = seekHover && trickplay ? trickplayFrame(trickplay, seekHover.time) : null;
    const hoverTile = hoverFrame && api && item && playback ? api.trickplayTileUrl(item.Id, trickplay?.Width || hoverFrame.width, hoverFrame.tileIndex, playback.mediaSourceId) : '';
    onBackRef.current = onBack;
    onErrorRef.current = onError;
    onPlayItemRef.current = onPlayItem;
    onReportedRef.current = onPlaybackReported;
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

    const rememberPosition = (seconds: number, duration?: number) => {
        if (Number.isFinite(seconds) && seconds >= 0) positionRef.current = seconds;
        if (duration !== undefined && Number.isFinite(duration) && duration > 0) durationRef.current = duration;
    };

    const seekTo = (seconds: number) => {
        withVideo(video => {
            const limit = Number.isFinite(video.duration) ? video.duration : Math.max(0, seconds);
            const next = Math.min(Math.max(0, seconds), limit);
            video.currentTime = next;
            rememberPosition(next, video.duration);
            setCurrentTime(next);
        });
        reveal();
    };

    const seekBy = (delta: number) => {
        withVideo(video => seekTo(video.currentTime + delta));
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
        if (currentFullscreenElement() === root) exitStageFullscreen();
        else requestStageFullscreen(root);
        reveal();
    };

    const placeSeekHover = (clientX: number, time: number) => {
        const rect = seekWrapRef.current?.getBoundingClientRect();
        if (!rect) return;
        setSeekHover({ time, x: clientX - rect.left, width: rect.width });
    };

    const selectAudio = (index: number) => {
        setAudioIndex(index);
        withVideo(video => {
            const tracks = browserAudioTracks(video);
            const position = audioStreams.findIndex(stream => stream.Index === index);
            if (!tracks || position < 0 || position >= tracks.length) {
                setAudioNote('This browser is playing the file’s default audio and cannot switch tracks without transcoding.');
                return;
            }
            for (let trackIndex = 0; trackIndex < tracks.length; trackIndex++) tracks[trackIndex].enabled = trackIndex === position;
            setAudioNote('');
        });
        reveal();
    };

    const selectSubtitle = (index: number | null) => {
        const stream = subtitleStreams.find(candidate => candidate.Index === index);
        if (stream && !stream.IsTextSubtitleStream) {
            setSubtitleNote('Image subtitles have to be burned into the video. This player does not start a transcode for that.');
            return;
        }
        setSubtitleNote('');
        setSubtitleIndex(index);
        reveal();
    };

    const shiftSubtitles = (delta: number) => {
        const next = Math.min(10, Math.max(-10, Math.round((subtitleOffset + delta) * 10) / 10));
        setSubtitleOffset(next);
        offsetRef.current = next;
        withVideo(video => applySubtitleOffset(video, next));
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
                if (video.readyState > 0) rememberPosition(video.currentTime || 0, video.duration);
                reporterRef.current?.stop();
                hlsRef.current?.destroy();
                hlsRef.current = null;
                video.pause();
                video.removeAttribute('src');
                video.load();
            }
        };
    }, []);

    useEffect(() => {
        setCurrentTime(0);
        setDuration(0);
        setPlaybackError('');
        setSeekHover(null);
        closeMenu();
    }, [ url ]);

    useEffect(() => {
        const video = videoRef.current;
        if (!video || !hlsPlayback) return;
        let cancelled = false;
        video.removeAttribute('src');
        const fail = () => {
            if (cancelled || !aliveRef.current) return;
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
            const instance = new Hls();
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
    }, [ url, hlsPlayback ]);

    useEffect(() => {
        const video = videoRef.current;
        if (!api || !item?.Id || !video) return;
        const startedAtMs = Date.now();
        const playMethod = playback?.direct === false ? 'Transcode' : 'DirectPlay';
        const aspectRatio = (playback?.streams || []).find(stream => streamKind(stream.Type) === 'video')?.AspectRatio;
        const itemId = item.Id;
        const reporter = new PlaybackReporter(() => ({
            itemId,
            mediaSourceId: playback?.mediaSourceId,
            playSessionId: playback?.playSessionId,
            positionSeconds: positionRef.current,
            durationSeconds: durationRef.current,
            paused: video.paused,
            muted: video.muted,
            volume: video.volume,
            audioStreamIndex: audioIndexRef.current,
            subtitleStreamIndex: subtitleIndexRef.current,
            playMethod,
            aspectRatio,
            startedAtMs
        }), {
            start: report => api.reportPlaybackStart(report),
            progress: report => api.reportPlaybackProgress(report),
            stop: (report, keepalive) => api.reportPlaybackStopped(report, keepalive).then(() => {
                if (!keepalive) onReportedRef.current?.(itemId);
            })
        });
        reporterRef.current = reporter;
        const onPlay = () => {
            if (!reporter.isStarted) reporter.start();
            else reporter.pulse();
        };
        const onPulse = () => reporter.pulse();
        const onEnded = () => reporter.stop(false);
        const onMediaError = () => reporter.stop(true);
        const onHide = () => reporter.stop(false, true);
        const onShow = () => { if (!video.ended) reporter.resumeAfterHide(); };
        video.addEventListener('play', onPlay);
        video.addEventListener('pause', onPulse);
        video.addEventListener('seeked', onPulse);
        video.addEventListener('volumechange', onPulse);
        video.addEventListener('ended', onEnded);
        video.addEventListener('error', onMediaError);
        window.addEventListener('pagehide', onHide);
        window.addEventListener('pageshow', onShow);
        if (!video.paused) reporter.start();
        return () => {
            window.removeEventListener('pagehide', onHide);
            window.removeEventListener('pageshow', onShow);
            video.removeEventListener('play', onPlay);
            video.removeEventListener('pause', onPulse);
            video.removeEventListener('seeked', onPulse);
            video.removeEventListener('volumechange', onPulse);
            video.removeEventListener('ended', onEnded);
            video.removeEventListener('error', onMediaError);
            if (video.readyState > 0) rememberPosition(video.currentTime || 0, video.duration);
            reporter.stop(false);
            if (reporterRef.current === reporter) reporterRef.current = null;
        };
    }, [ api, item?.Id, url, playback?.direct, playback?.mediaSourceId, playback?.playSessionId, playback?.streams ]);

    useEffect(() => { reporterRef.current?.pulse(); }, [ audioIndex, subtitleIndex ]);

    useEffect(() => {
        const video = videoRef.current;
        if (video) video.playbackRate = speed;
    }, [ speed, url ]);

    useEffect(() => {
        const text = subtitleStreams.filter(stream => stream.IsTextSubtitleStream);
        const preferred = text.find(stream => stream.IsDefault);
        setSubtitleIndex(preferred ? preferred.Index : null);
        setSubtitleOffset(0);
        offsetRef.current = 0;
        setSubtitleNote('');
        setAudioIndex(audioStreams.find(stream => stream.IsDefault)?.Index ?? audioStreams[0]?.Index ?? null);
        setAudioNote('');
    }, [ playback?.mediaSourceId, url ]);

    useEffect(() => {
        if (!subtitleUrl) return;
        const video = videoRef.current;
        if (!video) return;
        const apply = () => applySubtitleOffset(video, offsetRef.current);
        video.textTracks.addEventListener('addtrack', apply);
        const timer = window.setTimeout(apply, 400);
        return () => {
            video.textTracks.removeEventListener('addtrack', apply);
            window.clearTimeout(timer);
        };
    }, [ subtitleUrl, subtitleOffset ]);

    useEffect(() => {
        if (!api || !item?.SeriesId) {
            setEpisodes([]);
            setEpisodeState('idle');
            return;
        }
        let active = true;
        setEpisodeState('loading');
        void api.getSeriesEpisodes(item.SeriesId).then(list => {
            if (!active) return;
            setEpisodes(list);
            setEpisodeState('ready');
        }).catch(() => {
            if (active) setEpisodeState('error');
        });
        return () => { active = false; };
    }, [ api, item?.SeriesId ]);

    useEffect(() => { setSeason(item?.ParentIndexNumber); }, [ item?.Id, item?.ParentIndexNumber ]);

    useEffect(() => {
        if (!api || !item?.Id) {
            setCues([]);
            setTrickplay(null);
            return;
        }
        let active = true;
        void api.getMediaSegments(item.Id).then(segments => {
            if (active) setCues(timelineCues(segments));
        }).catch(() => { if (active) setCues([]); });
        void api.getTrickplay(item.Id).then(manifest => {
            if (active) setTrickplay(pickTrickplay(manifest, playback?.mediaSourceId));
        }).catch(() => { if (active) setTrickplay(null); });
        return () => { active = false; };
    }, [ api, item?.Id, playback?.mediaSourceId ]);

    useEffect(() => {
        if (menu !== 'episodes') return;
        document.querySelector('.player-episode.current')?.scrollIntoView({ block: 'nearest' });
    }, [ menu, item?.Id, season ]);

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
                if (osdRef.current) hideOsd();
                else onBackRef.current();
                return;
            }
            const mediaToggle = key === 'MediaPlayPause' || event.keyCode === 10252;
            const mediaPlay = key === 'MediaPlay' || event.keyCode === 415;
            const mediaPause = key === 'MediaPause' || key === 'Pause';
            const mediaStop = key === 'MediaStop' || event.keyCode === 413;
            if (mediaToggle || mediaPlay || mediaPause || mediaStop) {
                event.preventDefault();
                withVideo(video => {
                    if (mediaStop) {
                        video.pause();
                        video.currentTime = 0;
                        setCurrentTime(0);
                    } else if (mediaPlay) void video.play();
                    else if (mediaPause) video.pause();
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
                    if (!Number.isFinite(video.duration)) return;
                    seekTo(video.duration * (Number(key) / 10));
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
            src={hlsPlayback ? undefined : url}
            autoPlay
            playsInline
            onTimeUpdate={event => {
                const video = event.target as HTMLVideoElement;
                if (video.readyState > 0) rememberPosition(video.currentTime || 0, video.duration);
                if (draggingRef.current) return;
                setCurrentTime(video.currentTime || 0);
            }}
            onLoadedMetadata={event => {
                const video = event.target as HTMLVideoElement;
                rememberPosition(video.currentTime || 0, video.duration);
                setDuration(video.duration || 0);
                video.playbackRate = speed;
            }}
            onDurationChange={event => setDuration((event.target as HTMLVideoElement).duration || 0)}
            onPlay={() => { setPaused(false); pausedRef.current = false; reveal(); }}
            onPause={() => { setPaused(true); pausedRef.current = true; reveal(); }}
            onVolumeChange={event => {
                const video = event.target as HTMLVideoElement;
                setVolume(video.volume);
                setMuted(video.muted);
            }}
            onError={() => {
                if (!aliveRef.current || hlsPlayback) return;
                setPaused(true);
                setPlaybackError(PLAYBACK_ERROR);
                reveal();
                onErrorRef.current();
            }}
        >
            {subtitleUrl && <track kind="subtitles" src={subtitleUrl} default label="Subtitles" />}
        </video>
        {playbackError && <p class="player-error" role="alert">{playbackError}</p>}
        <header class="player-osd player-osd-top">
            <button data-focusable={focusable} class="player-back" type="button" onClick={() => onBackRef.current()}>← <span>Back</span></button>
            <h1>{title}</h1>
            {isEpisode && <button data-focusable={focusable} class="player-control player-episodes" type="button" aria-label="Episodes" aria-expanded={menu === 'episodes'} onClick={() => chooseMenu('episodes')}>
                <svg viewBox="0 0 24 24" class="player-icon" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
            </button>}
        </header>
        <footer class="player-osd player-osd-bottom">
            {skip && <div class="player-skip-row"><button data-focusable={focusable} class="player-skip" type="button" onClick={() => seekTo(skip.end)}>{skip.label}</button></div>}
            <div class="player-timeline">
                <span class="player-time">{formatTime(currentTime)}</span>
                <div
                    class="player-seek-wrap"
                    ref={seekWrapRef}
                    onPointerMove={event => {
                        if (event.pointerType === 'touch' && !draggingRef.current) return;
                        const rect = seekWrapRef.current?.getBoundingClientRect();
                        if (!rect || !rect.width) return;
                        const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
                        placeSeekHover(event.clientX, ratio * (duration || 0));
                    }}
                    onPointerLeave={() => { if (!draggingRef.current) setSeekHover(null); }}
                >
                    <div class="player-cues" aria-hidden="true">
                        {cues.map(cue => {
                            const box = cueBox(cue, duration);
                            if (!box) return null;
                            return <span key={`${cue.kind}-${cue.start}`} class={cue.kind === 'credits' ? 'player-cue credits' : 'player-cue intro'} style={box} />;
                        })}
                    </div>
                    {seekHover && <div class="player-trickplay" style={hoverStyle}>
                        {hoverFrame && hoverTile && <div class="player-trickplay-frame" style={{ width: '176px', height: `${hoverFrame.height * frameScale}px`, backgroundImage: `url("${hoverTile}")`, backgroundPosition: `-${hoverFrame.x * frameScale}px -${hoverFrame.y * frameScale}px`, backgroundSize: `${hoverFrame.sheetWidth * frameScale}px ${hoverFrame.sheetHeight * frameScale}px` }} />}
                        <span>{formatTime(seekHover.time)}</span>
                    </div>}
                    <input
                        data-focusable={focusable}
                        class="player-slider player-seek"
                        type="range"
                        min="0"
                        max={duration || 0}
                        step="0.1"
                        value={Math.min(currentTime, duration || 0)}
                        aria-label="Seek"
                        disabled={!duration}
                        onPointerDown={() => holdUntilRelease(true)}
                        onInput={event => {
                            const next = Number((event.target as HTMLInputElement).value);
                            rememberPosition(next, videoRef.current?.duration);
                            setCurrentTime(next);
                            withVideo(video => { video.currentTime = next; });
                            const rect = seekWrapRef.current?.getBoundingClientRect();
                            if (rect) setSeekHover({ time: next, x: duration ? (next / duration) * rect.width : 0, width: rect.width });
                        }}
                        onFocus={() => {
                            const rect = seekWrapRef.current?.getBoundingClientRect();
                            if (!rect || !duration) return;
                            setSeekHover({ time: currentTime, x: (currentTime / duration) * rect.width, width: rect.width });
                        }}
                        onBlur={() => { if (!draggingRef.current) setSeekHover(null); }}
                    />
                </div>
                <span class="player-time">{formatTime(duration)}</span>
            </div>
            <div class="player-transport">
                {isEpisode && <button data-focusable={focusable} class="player-control" type="button" aria-label="Previous episode" disabled={episodeIndex <= 0} onClick={() => episodeIndex > 0 && onPlayItemRef.current(orderedEpisodes[episodeIndex - 1])}>|◀</button>}
                <button data-focusable={focusable} class="player-control" type="button" aria-label="Rewind 10 seconds" onClick={() => seekBy(-10)}>−10</button>
                <button data-focusable={focusable} class="player-control player-play" type="button" aria-label={paused ? 'Play' : 'Pause'} onClick={togglePlay}>{paused ? '▶' : '❚❚'}</button>
                <button data-focusable={focusable} class="player-control" type="button" aria-label="Fast forward 10 seconds" onClick={() => seekBy(10)}>+10</button>
                {isEpisode && <button data-focusable={focusable} class="player-control" type="button" aria-label="Next episode" disabled={episodeIndex < 0 || episodeIndex >= orderedEpisodes.length - 1} onClick={() => episodeIndex >= 0 && episodeIndex < orderedEpisodes.length - 1 && onPlayItemRef.current(orderedEpisodes[episodeIndex + 1])}>▶|</button>}
                <div class="player-pop">
                    <button data-focusable={focusable} class={menu === 'captions' ? 'player-control active' : 'player-control'} type="button" aria-label="Audio and subtitles" aria-expanded={menu === 'captions'} onClick={() => chooseMenu('captions')}>CC</button>
                    {menu === 'captions' && <div class="player-menu" role="dialog" aria-label="Audio and subtitles">
                        <p class="player-menu-label">Audio</p>
                        {audioStreams.length ? audioStreams.map(stream => <button data-focusable={focusable} key={stream.Index} class={audioIndex === stream.Index ? 'player-menu-item active' : 'player-menu-item'} type="button" onClick={() => selectAudio(stream.Index)}>{streamLabel(stream)}</button>) : <p class="player-menu-note">No alternate audio tracks were reported.</p>}
                        {audioNote && <p class="player-menu-note">{audioNote}</p>}
                        <p class="player-menu-label">Subtitles</p>
                        <button data-focusable={focusable} class={subtitleIndex === null ? 'player-menu-item active' : 'player-menu-item'} type="button" onClick={() => selectSubtitle(null)}>Off</button>
                        {subtitleStreams.map(stream => <button data-focusable={focusable} key={stream.Index} class={subtitleIndex === stream.Index ? 'player-menu-item active' : 'player-menu-item'} type="button" onClick={() => selectSubtitle(stream.Index)}>{streamLabel(stream)}{stream.IsTextSubtitleStream ? '' : ' · image'}</button>)}
                        {subtitleNote && <p class="player-menu-note">{subtitleNote}</p>}
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
                            {SPEEDS.map(value => <button data-focusable={focusable} key={value} class={speed === value ? 'player-menu-item active' : 'player-menu-item'} type="button" onClick={() => { setSpeed(value); withVideo(video => { video.playbackRate = value; }); reveal(); }}>{value}×</button>)}
                        </div>
                        <p class="player-menu-label">Aspect ratio</p>
                        <button data-focusable={focusable} class={fit === 'contain' ? 'player-menu-item active' : 'player-menu-item'} type="button" onClick={() => setFit('contain')}>Original</button>
                        <button data-focusable={focusable} class={fit === 'cover' ? 'player-menu-item active' : 'player-menu-item'} type="button" onClick={() => setFit('cover')}>Zoom</button>
                        <button data-focusable={focusable} class={fit === 'fill' ? 'player-menu-item active' : 'player-menu-item'} type="button" onClick={() => setFit('fill')}>Stretch</button>
                        {videoStream?.AspectRatio && <p class="player-menu-note">Source frame {videoStream.AspectRatio}.</p>}
                        <p class="player-menu-label">Bitrate</p>
                        <p class="player-menu-note">{formatBitrate(playback?.bitrate)} · {playback?.direct === false ? 'Transcoded stream' : 'Direct play'}. Changing bitrate needs a transcode, which this player does not start.</p>
                        <p class="player-menu-label">Transcode reasons</p>
                        <p class="player-menu-note">{describeTranscode(playback?.transcodeReasons, playback?.direct !== false)}</p>
                    </div>}
                </div>
                <button data-focusable={focusable} class="player-control" type="button" aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} onClick={toggleFullscreen}>{fullscreen ? '⤡' : '⛶'}</button>
            </div>
        </footer>
        {menu === 'episodes' && <aside class="player-drawer" role="dialog" aria-label="Episodes">
            <div class="player-drawer-head">
                <div>
                    <p class="eyebrow">EPISODES</p>
                    <h2>{item?.SeriesName || 'This series'}</h2>
                </div>
                <button data-focusable="true" class="player-control" type="button" aria-label="Close episodes" onClick={closeMenu}>×</button>
            </div>
            {seasons.length > 1 && <div class="player-season-row">
                {seasons.map(number => <button data-focusable="true" key={String(number)} class={number === season ? 'player-season active' : 'player-season'} type="button" onClick={() => setSeason(number)}>{seasonLabel(number)}</button>)}
            </div>}
            <div class="player-episode-list">
                {episodeState === 'error' && <p class="player-menu-note">Episodes could not be loaded.</p>}
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
