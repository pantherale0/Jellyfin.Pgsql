import { t } from './i18n';
export interface BrowserCapabilities {
    canPlay: (type: string) => boolean;
    userAgent: string;
    hdrDisplay: boolean;
    audioTrackSwitching: boolean;
}

export type HlsContainer = 'ts' | 'mp4';

export interface PlaybackPreferences {
    maxBitrate: number;
    maxHeight: number;
    maxAudioChannels: number;
    hlsContainer: HlsContainer;
    speed: number;
    fit: 'contain' | 'cover' | 'fill';
    volume: number;
    subtitleBurnIn: SubtitleBurnIn;
}

/** auto: text subtitles render in the browser and image subtitles are burned in; styled: ASS/SSA are burned in too, keeping their styling; all: every subtitle is burned in. */
export type SubtitleBurnIn = 'auto' | 'styled' | 'all';
export const SUBTITLE_BURN_IN_CHOICES: Array<{ value: SubtitleBurnIn; label: string }> = [
    { value: 'auto', label: t('Automatic (burn in image subtitles only)') },
    { value: 'styled', label: t('Also burn in styled ASS/SSA subtitles') },
    { value: 'all', label: t('Burn in all subtitles') }
];

export const PLAYBACK_PREFERENCES_KEY = 'jellyfin-ui-next-playback-preferences';
export const DEFAULT_MAX_BITRATE = 120_000_000;

export const DEFAULT_PLAYBACK_PREFERENCES: PlaybackPreferences = {
    maxBitrate: 0,
    maxHeight: 0,
    maxAudioChannels: 0,
    hlsContainer: 'ts',
    speed: 1,
    fit: 'contain',
    volume: 1,
    subtitleBurnIn: 'auto'
};

export const BITRATE_CHOICES: Array<{ value: number; label: string }> = [
    { value: 0, label: t('Auto') },
    { value: 60_000_000, label: t('60 Mbps') },
    { value: 20_000_000, label: t('20 Mbps') },
    { value: 10_000_000, label: t('10 Mbps') },
    { value: 8_000_000, label: t('8 Mbps') },
    { value: 4_000_000, label: t('4 Mbps') },
    { value: 2_000_000, label: t('2 Mbps') },
    { value: 1_000_000, label: t('1 Mbps') }
];

export const RESOLUTION_CHOICES: Array<{ value: number; label: string }> = [
    { value: 0, label: t('Auto') },
    { value: 2160, label: '4K' },
    { value: 1080, label: '1080p' },
    { value: 720, label: '720p' },
    { value: 480, label: '480p' }
];

export const AUDIO_CHANNEL_CHOICES: Array<{ value: number; label: string }> = [
    { value: 0, label: t('Auto') },
    { value: 8, label: '7.1' },
    { value: 6, label: '5.1' },
    { value: 2, label: t('Stereo') }
];

export const PLAYER_SPEEDS = [ 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3 ];

function numberIn(value: unknown, allowed: number[], fallback: number): number {
    return typeof value === 'number' && allowed.includes(value) ? value : fallback;
}

export function normalizePlaybackPreferences(raw: unknown): PlaybackPreferences {
    const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const volume = typeof value.volume === 'number' && Number.isFinite(value.volume) ? Math.min(1, Math.max(0, value.volume)) : 1;
    return {
        maxBitrate: numberIn(value.maxBitrate, BITRATE_CHOICES.map(choice => choice.value), 0),
        maxHeight: numberIn(value.maxHeight, RESOLUTION_CHOICES.map(choice => choice.value), 0),
        maxAudioChannels: numberIn(value.maxAudioChannels, AUDIO_CHANNEL_CHOICES.map(choice => choice.value), 0),
        hlsContainer: value.hlsContainer === 'mp4' ? 'mp4' : 'ts',
        speed: numberIn(value.speed, PLAYER_SPEEDS, 1),
        fit: value.fit === 'cover' || value.fit === 'fill' ? value.fit : 'contain',
        volume,
        subtitleBurnIn: value.subtitleBurnIn === 'styled' || value.subtitleBurnIn === 'all' ? value.subtitleBurnIn : 'auto'
    };
}

export function loadPlaybackPreferences(storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): PlaybackPreferences {
    try {
        const stored = storage?.getItem(PLAYBACK_PREFERENCES_KEY);
        return normalizePlaybackPreferences(stored ? JSON.parse(stored) : {});
    } catch (_error) {
        return { ...DEFAULT_PLAYBACK_PREFERENCES };
    }
}

export function savePlaybackPreferences(change: Partial<PlaybackPreferences>, storage: Pick<Storage, 'getItem' | 'setItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): PlaybackPreferences {
    const next = normalizePlaybackPreferences({ ...loadPlaybackPreferences(storage), ...change });
    try { storage?.setItem(PLAYBACK_PREFERENCES_KEY, JSON.stringify(next)); } catch (_error) { /* Private mode keeps the in-memory value. */ }
    return next;
}

export function browserCapabilities(): BrowserCapabilities {
    const video = document.createElement('video');
    const hdr = (query: string) => typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
    return {
        canPlay: type => Boolean(video.canPlayType && video.canPlayType(type).replace(/no/, '')),
        userAgent: navigator.userAgent,
        hdrDisplay: hdr('(dynamic-range: high)') || hdr('(video-dynamic-range: high)'),
        audioTrackSwitching: 'audioTracks' in video
    };
}

export interface BrowserFamily { chrome: boolean; opera: boolean; firefox: boolean; safari: boolean; tv: boolean; webos: boolean; tizen: boolean }

export function browserFamily(userAgent: string): BrowserFamily {
    const opera = /\bOPR\/|\bOpera\b/.test(userAgent);
    const webos = /web0s|webos/i.test(userAgent);
    const tizen = /tizen/i.test(userAgent);
    const firefox = /Firefox\//.test(userAgent);
    const chrome = !firefox && /Chrome\/|CriOS\//.test(userAgent);
    const safari = !chrome && !firefox && /Safari\//.test(userAgent);
    return { chrome, opera, firefox, safari, tv: webos || tizen, webos, tizen };
}

function supportedVideoCodecs(caps: BrowserCapabilities): string[] {
    const family = browserFamily(caps.userAgent);
    const codecs: string[] = [];
    if (caps.canPlay('video/mp4; codecs="avc1.640029"') || caps.canPlay('video/mp4; codecs="avc1.42E01E"')) codecs.push('h264');
    if (caps.canPlay('video/mp4; codecs="hvc1.1.L120"') || caps.canPlay('video/mp4; codecs="hev1.1.6.L120"') || family.tv) codecs.push('hevc');
    if (caps.canPlay('video/mp4; codecs="av01.0.08M.08"')) codecs.push('av1');
    if (caps.canPlay('video/webm; codecs="vp9"')) codecs.push('vp9');
    return codecs;
}

/** Containers each browser audio codec arrives in for music direct play. */
const AUDIO_CONTAINERS: Record<string, string> = { aac: 'm4a,m4b,aac,mp4', mp3: 'mp3', flac: 'flac', opus: 'ogg,oga,opus,webm,webma', vorbis: 'ogg,oga,webm,webma' };

export const MUSIC_TRANSCODE_BITRATE = 384_000;

function supportedAudioCodecs(caps: BrowserCapabilities): string[] {
    const family = browserFamily(caps.userAgent);
    const codecs: string[] = [];
    if (caps.canPlay('audio/mp4; codecs="mp4a.40.2"')) codecs.push('aac');
    if (caps.canPlay('audio/mpeg')) codecs.push('mp3');
    if (caps.canPlay('audio/ogg; codecs="opus"') || caps.canPlay('audio/webm; codecs="opus"')) codecs.push('opus');
    if (caps.canPlay('audio/flac')) codecs.push('flac');
    if (!family.firefox && (caps.canPlay('audio/mp4; codecs="ac-3"') || family.tv)) codecs.push('ac3');
    if (!family.firefox && (caps.canPlay('audio/mp4; codecs="ec-3"') || family.tv)) codecs.push('eac3');
    if (caps.canPlay('audio/webm; codecs="vorbis"')) codecs.push('vorbis');
    return codecs;
}

export function canDirectPlayMkv(caps: BrowserCapabilities): boolean {
    const family = browserFamily(caps.userAgent);
    if (family.tv) return true;
    // Chrome/Opera can claim Matroska support but fail DirectPlay silently.
    if (family.chrome || family.opera) return false;
    return caps.canPlay('video/x-matroska') || caps.canPlay('video/mkv');
}

/** Options the native wrapper passes to the device profile builder (Jellyfin Web's AppHost contract). */
export interface HostProfileOptions {
    /** The wrapper's reported HDR10 panel capability; null means "decide from the browser". */
    supportsHdr10: boolean | null;
}

const DEFAULT_HOST_PROFILE_OPTIONS: HostProfileOptions = { supportsHdr10: null };

/** Reads the wrapper's builder options; every field is optional and unknown-typed by contract. */
export function hostProfileOptions(raw: unknown): HostProfileOptions {
    const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    return { supportsHdr10: typeof value.supportsHdr10 === 'boolean' ? value.supportsHdr10 : null };
}

/**
 * TV engine generation, mirroring Jellyfin Web's `web0sVersion()` Chrome-token map and its
 * `Tizen x.y` parse. LG renumbered webOS from 6 to 22, so the mapping stays monotonic and
 * `>= 3` style comparisons keep working across both schemes. Null means "not recognised".
 */
export function tvVersion(userAgent: string, family: BrowserFamily = browserFamily(userAgent)): number | null {
    if (family.webos) {
        const engine = /Chrome\/(\d+)/.exec(userAgent);
        const major = engine ? Number(engine[1]) : 0;
        if (major >= 120) return 25;
        if (major >= 108) return 24;
        if (major >= 94) return 23;
        if (major >= 87) return 22;
        if (major >= 79) return 6;
        if (major >= 68) return 5;
        if (major >= 53) return 4;
        if (major >= 38) return 3;
        if (major >= 34) return 2;
        return major >= 26 ? 1 : null;
    }
    if (family.tizen) {
        const version = /Tizen (\d+)\.(\d+)/i.exec(userAgent);
        return version ? Number(version[1]) + Number(version[2]) / 10 : null;
    }
    return null;
}

/** webOS 3 (2017) is the oldest generation whose UHD and OLED panels are all HDR-capable. */
const MIN_WEBOS_HDR_VERSION = 3;
/** Jellyfin Web claims Dolby Vision fallback layers from webOS 4 and Tizen 3 onwards. */
const MIN_WEBOS_DOVI_VERSION = 4;
const MIN_TIZEN_DOVI_VERSION = 3;

function hdr10Capable(caps: BrowserCapabilities, host: HostProfileOptions | undefined, family: BrowserFamily = browserFamily(caps.userAgent)): boolean {
    if (host && host.supportsHdr10 !== null) return host.supportsHdr10;
    // TV engines before Chromium 98 (webOS 4.x runs Chromium 53) cannot report HDR through media
    // queries, so HDR-era engines get Jellyfin Web's assumption: the panel shows HDR10. Older or
    // unrecognised engines keep the media-query answer, and the wrapper's panel report always wins.
    if (family.webos) {
        const version = tvVersion(caps.userAgent, family);
        return caps.hdrDisplay || (version !== null && version >= MIN_WEBOS_HDR_VERSION);
    }
    return caps.hdrDisplay || family.tizen;
}

/**
 * Jellyfin Web advertises the Dolby Vision *fallback* layers on TV engines so the server does not
 * have to remux or transcode: the base layer plays even on panels without Dolby Vision. Pure
 * `DOVI` (profile 5) is deliberately left out — claiming it needs per-profile probing ui-next does
 * not do, and a wrong claim sends IPTPQc2 video to a panel that cannot map it. Unlike Jellyfin Web,
 * an SDR panel does not get `DOVIWithSDR` either; that content stays on the decodable transcode path.
 */
function doviFallbackCapable(caps: BrowserCapabilities, family: BrowserFamily): boolean {
    const version = tvVersion(caps.userAgent, family);
    if (version === null) return false;
    return family.tizen ? version >= MIN_TIZEN_DOVI_VERSION : version >= MIN_WEBOS_DOVI_VERSION;
}

const HDR_RANGE_TYPES = 'SDR|HDR10|HDR10Plus|HLG';
const DOVI_FALLBACK_RANGE_TYPES = 'DOVIWithSDR|DOVIWithHDR10|DOVIWithHDR10Plus|DOVIWithHLG|DOVIWithEL|DOVIWithELHDR10Plus|DOVIInvalid';
/** Jellyfin Web omits the SDR and HLG Dolby Vision bases for AV1 unless it detects DV profile 10. */
const DOVI_FALLBACK_AV1_RANGE_TYPES = 'DOVIWithHDR10|DOVIWithHDR10Plus|DOVIWithEL|DOVIWithELHDR10Plus|DOVIInvalid';

export function rangeTypes(codec: 'h264' | 'hevc' | 'vp9' | 'av1', caps: BrowserCapabilities, host: HostProfileOptions | undefined = DEFAULT_HOST_PROFILE_OPTIONS, family: BrowserFamily = browserFamily(caps.userAgent)): string {
    if (codec === 'h264' || !hdr10Capable(caps, host, family)) return 'SDR';
    // Jellyfin Web leaves VP9 without Dolby Vision fallbacks.
    if (codec === 'vp9' || !doviFallbackCapable(caps, family)) return HDR_RANGE_TYPES;
    return `${HDR_RANGE_TYPES}|${codec === 'av1' ? DOVI_FALLBACK_AV1_RANGE_TYPES : DOVI_FALLBACK_RANGE_TYPES}`;
}

export function buildDeviceProfile(caps: BrowserCapabilities, preferences: PlaybackPreferences = DEFAULT_PLAYBACK_PREFERENCES, host: HostProfileOptions = DEFAULT_HOST_PROFILE_OPTIONS) {
    const textMethod = preferences.subtitleBurnIn === 'all' ? 'Encode' : 'External';
    const styledMethod = preferences.subtitleBurnIn === 'auto' ? 'External' : 'Encode';
    const family = browserFamily(caps.userAgent);
    const video = supportedVideoCodecs(caps);
    const audio = supportedAudioCodecs(caps);
    const mp4Video = video.filter(codec => codec !== 'vp9' || family.chrome || family.firefox);
    const mp4Audio = audio.filter(codec => codec !== 'vorbis');
    const webmVideo = video.filter(codec => codec === 'vp9' || codec === 'av1');
    const webmAudio = audio.filter(codec => codec === 'opus' || codec === 'vorbis');
    const surround = audio.includes('ac3') || audio.includes('eac3');
    const maxAudioChannels = preferences.maxAudioChannels || (surround ? 6 : 2);
    const directPlayProfiles: Array<Record<string, string>> = [];
    if (mp4Video.length && mp4Audio.length) directPlayProfiles.push({ Container: 'mp4,m4v', Type: 'Video', VideoCodec: mp4Video.join(','), AudioCodec: mp4Audio.join(',') });
    if (webmVideo.length && webmAudio.length) directPlayProfiles.push({ Container: 'webm', Type: 'Video', VideoCodec: webmVideo.join(','), AudioCodec: webmAudio.join(',') });
    if (canDirectPlayMkv(caps) && video.length && audio.length) directPlayProfiles.push({ Container: 'mkv', Type: 'Video', VideoCodec: video.join(','), AudioCodec: audio.join(',') });
    audio.filter(codec => codec !== 'ac3' && codec !== 'eac3').forEach(codec => directPlayProfiles.push({ Container: AUDIO_CONTAINERS[codec] || codec, AudioCodec: codec, Type: 'Audio' }));
    if (caps.canPlay('audio/wav')) directPlayProfiles.push({ Container: 'wav', Type: 'Audio' });

    const transcodeVideo = [ 'h264', ...(preferences.hlsContainer === 'mp4' && video.includes('hevc') ? [ 'hevc' ] : []) ];
    const transcodeAudio = [ 'aac', 'mp3', ...(surround ? [ 'ac3' ] : []) ];
    const codecProfiles: Array<Record<string, unknown>> = [
        {
            Type: 'Video',
            Codec: 'h264',
            Conditions: [
                { Condition: 'EqualsAny', Property: 'VideoProfile', Value: 'high|main|baseline|constrained baseline', IsRequired: false },
                { Condition: 'LessThanEqual', Property: 'VideoLevel', Value: family.tv ? '51' : '52', IsRequired: false },
                { Condition: 'LessThanEqual', Property: 'VideoBitDepth', Value: '8', IsRequired: false },
                { Condition: 'EqualsAny', Property: 'VideoRangeType', Value: rangeTypes('h264', caps, host, family), IsRequired: false },
                { Condition: 'NotEquals', Property: 'IsAnamorphic', Value: 'true', IsRequired: false }
            ]
        }
    ];
    if (video.includes('hevc')) codecProfiles.push({
        Type: 'Video',
        Codec: 'hevc',
        Conditions: [
            { Condition: 'EqualsAny', Property: 'VideoProfile', Value: 'main|main 10', IsRequired: false },
            { Condition: 'LessThanEqual', Property: 'VideoLevel', Value: '183', IsRequired: false },
            { Condition: 'EqualsAny', Property: 'VideoRangeType', Value: rangeTypes('hevc', caps, host, family), IsRequired: false }
        ]
    });
    if (video.includes('vp9')) codecProfiles.push({ Type: 'Video', Codec: 'vp9', Conditions: [ { Condition: 'EqualsAny', Property: 'VideoRangeType', Value: rangeTypes('vp9', caps, host, family), IsRequired: false } ] });
    if (video.includes('av1')) codecProfiles.push({ Type: 'Video', Codec: 'av1', Conditions: [ { Condition: 'EqualsAny', Property: 'VideoRangeType', Value: rangeTypes('av1', caps, host, family), IsRequired: false } ] });
    if (preferences.maxHeight) codecProfiles.push({ Type: 'Video', Conditions: [ { Condition: 'LessThanEqual', Property: 'Height', Value: String(preferences.maxHeight), IsRequired: false } ] });
    const audioConditions: Array<Record<string, unknown>> = [ { Condition: 'LessThanEqual', Property: 'AudioChannels', Value: String(maxAudioChannels), IsRequired: false } ];
    if (!caps.audioTrackSwitching) audioConditions.push({ Condition: 'Equals', Property: 'IsSecondaryAudio', Value: 'false', IsRequired: false });
    codecProfiles.push({ Type: 'VideoAudio', Conditions: audioConditions });

    return {
        MaxStreamingBitrate: preferences.maxBitrate || DEFAULT_MAX_BITRATE,
        MaxStaticBitrate: 100_000_000,
        MusicStreamingTranscodingBitrate: Math.min(preferences.maxBitrate || MUSIC_TRANSCODE_BITRATE, MUSIC_TRANSCODE_BITRATE),
        DirectPlayProfiles: directPlayProfiles,
        TranscodingProfiles: [
            {
                Container: preferences.hlsContainer,
                Type: 'Video',
                VideoCodec: transcodeVideo.join(','),
                AudioCodec: transcodeAudio.join(','),
                Context: 'Streaming',
                Protocol: 'hls',
                MaxAudioChannels: String(maxAudioChannels),
                MinSegments: '1',
                BreakOnNonKeyFrames: true
            },
            ...(audio.includes('aac') ? [ { Container: 'aac', Type: 'Audio', AudioCodec: 'aac', Context: 'Streaming', Protocol: 'http', MaxAudioChannels: '2' } ] : []),
            { Container: 'mp3', Type: 'Audio', AudioCodec: 'mp3', Context: 'Streaming', Protocol: 'http', MaxAudioChannels: '2' }
        ],
        ContainerProfiles: [],
        CodecProfiles: codecProfiles,
        SubtitleProfiles: [
            { Format: 'vtt', Method: textMethod },
            { Format: 'webvtt', Method: textMethod },
            { Format: 'srt', Method: textMethod },
            { Format: 'subrip', Method: textMethod },
            { Format: 'ass', Method: styledMethod },
            { Format: 'ssa', Method: styledMethod },
            { Format: 'pgssub', Method: 'Encode' },
            { Format: 'pgs', Method: 'Encode' },
            { Format: 'dvdsub', Method: 'Encode' },
            { Format: 'dvbsub', Method: 'Encode' }
        ],
        ResponseProfiles: [ { Type: 'Video', Container: 'm4v', MimeType: 'video/mp4' } ]
    };
}
