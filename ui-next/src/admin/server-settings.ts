import { t } from '../i18n';
/**
 * Declarative server/user/device setting fields shared by the admin settings forms.
 * Keys may be dotted paths into nested configuration objects (e.g. `TrickplayOptions.Interval`).
 * Saves only send fields the administrator changed, merged onto a freshly loaded document.
 */

export type FieldKind = 'boolean' | 'number' | 'text' | 'textarea' | 'password' | 'select' | 'list';

export interface FieldDef {
    key: string;
    label: string;
    kind: FieldKind;
    min?: number;
    max?: number;
    step?: number;
    /** Display unit; `scale` converts stored values to it (stored = shown × scale). */
    unit?: string;
    scale?: number;
    values?: Array<string | [string, string]>;
    note?: string;
    /** Empty input stores null (inherit / unrestricted) instead of failing validation. */
    nullable?: boolean;
    /** List fields: split on newlines only (values may contain commas). */
    lines?: boolean;
}

export function getPath(source: unknown, path: string): unknown {
    return path.split('.').reduce<unknown>((value, key) => (value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined), source);
}

export function setPath<T extends Record<string, unknown>>(target: T, path: string, value: unknown): T {
    const keys = path.split('.');
    const copy: Record<string, unknown> = { ...target };
    let cursor = copy;
    keys.slice(0, -1).forEach(key => {
        const next = cursor[key];
        cursor[key] = next && typeof next === 'object' && !Array.isArray(next) ? { ...(next as Record<string, unknown>) } : {};
        cursor = cursor[key] as Record<string, unknown>;
    });
    cursor[keys[keys.length - 1]] = value;
    return copy as T;
}

/** The text an input shows for a stored value. */
export function displayValue(field: FieldDef, stored: unknown): string | boolean {
    if (field.kind === 'boolean') return stored === true;
    if (stored === null || stored === undefined) return '';
    if (field.kind === 'list') return Array.isArray(stored) ? stored.join(field.lines ? '\n' : ', ') : '';
    if (field.kind === 'number' && typeof stored === 'number' && field.scale) return String(Number((stored / field.scale).toFixed(6)));
    return String(stored);
}

/** Parses an input into the stored value, or returns an error message. */
export function parseInput(field: FieldDef, input: string | boolean): { value: unknown } | { error: string } {
    if (field.kind === 'boolean') return { value: input === true };
    const text = String(input);
    if (field.kind === 'list') return { value: text.split(field.lines ? /\n/ : /[\n,]/).map(value => value.trim()).filter(Boolean) };
    if (field.kind === 'number') {
        if (!text.trim()) return field.nullable ? { value: null } : { error: t('{0} is required.', field.label) };
        const shown = Number(text);
        if (!Number.isFinite(shown)) return { error: t('{0} must be a number.', field.label) };
        if (field.min !== undefined && shown < field.min) return { error: t('{0} must be at least {1}.', field.label, field.min) };
        if (field.max !== undefined && shown > field.max) return { error: t('{0} must be at most {1}.', field.label, field.max) };
        if ((field.step ?? 1) >= 1 && !Number.isInteger(shown)) return { error: t('{0} must be a whole number.', field.label) };
        return { value: field.scale ? Math.round(shown * field.scale) : shown };
    }
    if (field.kind === 'select' && field.values && text && !field.values.some(option => (Array.isArray(option) ? option[0] : option) === text)) {
        return { error: t('{0} has an unsupported value.', field.label) };
    }
    if (field.nullable && !text) return { value: null };
    return { value: text };
}

/** Changed fields only, as dotted path → stored value. */
export function changedFields(fields: FieldDef[], saved: unknown, draft: unknown): Record<string, unknown> {
    const patch: Record<string, unknown> = {};
    fields.forEach(field => {
        const before = getPath(saved, field.key), after = getPath(draft, field.key);
        if (JSON.stringify(before ?? null) !== JSON.stringify(after ?? null)) patch[field.key] = after;
    });
    return patch;
}

export function applyPatch<T extends Record<string, unknown>>(fresh: T, patch: Record<string, unknown>): T {
    return Object.entries(patch).reduce<T>((next, [path, value]) => setPath(next, path, value), fresh);
}

const ms = (label: string) => ({ unit: label });

export const RESUME_FIELDS: FieldDef[] = [
    { key: 'MinResumePct', label: t('Minimum resume percentage'), kind: 'number', min: 0, max: 100, unit: '%', note: t('Titles stopped before this point are treated as not started.') },
    { key: 'MaxResumePct', label: t('Maximum resume percentage'), kind: 'number', min: 1, max: 100, unit: '%', note: t('Titles stopped after this point are marked played.') },
    { key: 'MinResumeDurationSeconds', label: t('Minimum resumable duration'), kind: 'number', min: 0, unit: 'seconds', note: t('Shorter titles never store a resume position.') },
    { key: 'MinAudiobookResume', label: t('Audiobook minimum resume'), kind: 'number', min: 0, unit: 'minutes' },
    { key: 'MaxAudiobookResume', label: t('Audiobook remaining before played'), kind: 'number', min: 0, unit: 'minutes' },
];

export const STREAMING_FIELDS: FieldDef[] = [
    { key: 'RemoteClientBitrateLimit', label: t('Remote client bitrate limit'), kind: 'number', min: 0, step: 0.1, unit: 'Mbps', scale: 1_000_000, note: t('0 means unlimited. Per-user limits can be lower.') },
];

export const TRICKPLAY_FIELDS: FieldDef[] = [
    { key: 'TrickplayOptions.EnableHwAcceleration', label: t('Hardware decoding'), kind: 'boolean' },
    { key: 'TrickplayOptions.EnableHwEncoding', label: t('Hardware MJPEG encoding'), kind: 'boolean' },
    { key: 'TrickplayOptions.EnableKeyFrameOnlyExtraction', label: t('Key frames only'), kind: 'boolean', note: t('Faster extraction with less accurate thumbnails.') },
    { key: 'TrickplayOptions.ScanBehavior', label: t('Scan behaviour'), kind: 'select', values: [ [ 'NonBlocking', 'Non-blocking' ], [ 'Blocking', 'Blocking' ] ] },
    { key: 'TrickplayOptions.ProcessPriority', label: t('Process priority'), kind: 'select', values: [ 'High', 'AboveNormal', 'Normal', 'BelowNormal', 'Idle' ] },
    { key: 'TrickplayOptions.Interval', label: t('Image interval'), kind: 'number', min: 1, ...ms('ms') },
    { key: 'TrickplayOptions.WidthResolutions', label: t('Width resolutions'), kind: 'list', note: t('Comma-separated pixel widths, e.g. 320.') },
    { key: 'TrickplayOptions.TileWidth', label: t('Tile width'), kind: 'number', min: 1 },
    { key: 'TrickplayOptions.TileHeight', label: t('Tile height'), kind: 'number', min: 1 },
    { key: 'TrickplayOptions.Qscale', label: t('Quality scale'), kind: 'number', min: 2, max: 31, note: t('Lower is better quality.') },
    { key: 'TrickplayOptions.JpegQuality', label: t('JPEG quality'), kind: 'number', min: 1, max: 100 },
    { key: 'TrickplayOptions.ProcessThreads', label: t('FFmpeg threads'), kind: 'number', min: 0, note: t('0 lets FFmpeg decide.') },
];

export const DVR_FIELDS: FieldDef[] = [
    { key: 'RecordingPath', label: t('Default recording path'), kind: 'text' },
    { key: 'MovieRecordingPath', label: t('Movie recording path'), kind: 'text', note: t('Empty uses the default path.') },
    { key: 'SeriesRecordingPath', label: t('Series recording path'), kind: 'text', note: t('Empty uses the default path.') },
    { key: 'EnableRecordingSubfolders', label: t('Use subfolders for categories'), kind: 'boolean' },
    { key: 'PrePaddingSeconds', label: t('Default pre-padding'), kind: 'number', min: 0, unit: 'minutes', scale: 60 },
    { key: 'PostPaddingSeconds', label: t('Default post-padding'), kind: 'number', min: 0, unit: 'minutes', scale: 60 },
    { key: 'GuideDays', label: t('Guide days to download'), kind: 'number', min: 1, max: 14, nullable: true, note: t('Empty lets the server decide.') },
    { key: 'EnableOriginalAudioWithEncodedRecordings', label: t('Keep original audio in encoded recordings'), kind: 'boolean' },
    { key: 'SaveRecordingNFO', label: t('Save recording NFO metadata'), kind: 'boolean' },
    { key: 'SaveRecordingImages', label: t('Save recording images'), kind: 'boolean' },
    { key: 'RecordingPostProcessor', label: t('Post-processing application'), kind: 'text' },
    { key: 'RecordingPostProcessorArguments', label: t('Post-processor arguments'), kind: 'text', note: t('{path} is replaced with the recording path.') },
];

export const GENERAL_FIELDS: FieldDef[] = [
    { key: 'ServerName', label: t('Server name'), kind: 'text' },
    { key: 'UICulture', label: t('Server language'), kind: 'select' },
    { key: 'QuickConnectAvailable', label: t('Quick Connect'), kind: 'boolean' },
    { key: 'CachePath', label: t('Cache path'), kind: 'text', note: t('Empty uses the default cache directory. Takes effect after restart.') },
    { key: 'MetadataPath', label: t('Metadata path'), kind: 'text', note: t('Empty uses the default metadata directory.') },
    { key: 'LibraryScanFanoutConcurrency', label: t('Parallel library scan tasks'), kind: 'number', min: 0, note: t('0 uses the CPU core count.') },
    { key: 'LibraryMetadataRefreshConcurrency', label: t('Parallel metadata refreshes'), kind: 'number', min: 0, note: t('0 uses the CPU core count.') },
    { key: 'ParallelImageEncodingLimit', label: t('Parallel image encodes'), kind: 'number', min: 0, note: t('0 uses the CPU core count.') },
];

export const LOGGING_FIELDS: FieldDef[] = [
    { key: 'EnableSlowResponseWarning', label: t('Log slow responses'), kind: 'boolean' },
    { key: 'SlowResponseThresholdMs', label: t('Slow response threshold'), kind: 'number', min: 0, unit: 'ms' },
    { key: 'ActivityLogRetentionDays', label: t('Activity log retention'), kind: 'number', min: 0, nullable: true, unit: 'days', note: t('Empty keeps entries forever.') },
    { key: 'LogFileRetentionDays', label: t('Log file retention'), kind: 'number', min: 1, unit: 'days' },
];

export const DISPLAY_FIELDS: FieldDef[] = [
    { key: 'EnableFolderView', label: t('Show a Folders view'), kind: 'boolean', note: t('Lets users browse plain media folders.') },
    { key: 'DisplaySpecialsWithinSeasons', label: t('Show specials within the seasons they aired in'), kind: 'boolean' },
    { key: 'EnableGroupingMoviesIntoCollections', label: t('Group movies into collections'), kind: 'boolean', note: t('Movies in a collection appear as one grouped item in movie lists.') },
    { key: 'EnableGroupingShowsIntoCollections', label: t('Group shows into collections'), kind: 'boolean' },
    { key: 'EnableExternalContentInSuggestions', label: t('Include external content in suggestions'), kind: 'boolean', note: t('Allows Live TV and internet content in suggestions.') },
];

export const DATE_ADDED_FIELDS: FieldDef[] = [
    { key: 'UseFileCreationTimeForDateAdded', label: t('Use the file creation date as the date added'), kind: 'boolean', note: t('Off uses the date the item was first scanned into the library.') },
];

export const CHAPTER_IMAGE_RESOLUTIONS: Array<[string, string]> = [
    [ 'MatchSource', 'Match source' ], [ 'P144', '144p' ], [ 'P240', '240p' ], [ 'P360', '360p' ], [ 'P480', '480p' ], [ 'P720', '720p' ], [ 'P1080', '1080p' ], [ 'P1440', '1440p' ], [ 'P2160', '2160p' ],
];

export const METADATA_DEFAULT_FIELDS: FieldDef[] = [
    { key: 'PreferredMetadataLanguage', label: t('Preferred metadata language'), kind: 'select' },
    { key: 'MetadataCountryCode', label: t('Metadata country'), kind: 'select' },
    { key: 'DummyChapterDuration', label: t('Generated chapter interval'), kind: 'number', min: 0, unit: 'seconds', note: t('0 turns off generated chapters for files without chapters.') },
    { key: 'ChapterImageResolution', label: t('Chapter image resolution'), kind: 'select', values: CHAPTER_IMAGE_RESOLUTIONS },
];

export const NFO_FIELDS: FieldDef[] = [
    { key: 'UserId', label: t('Save watch data for user'), kind: 'select', note: t('Writes this user\'s watched state and favourites into NFO files.') },
    { key: 'ReleaseDateFormat', label: t('Release date format'), kind: 'text', note: t('A .NET date format such as yyyy-MM-dd.') },
    { key: 'SaveImagePathsInNfo', label: t('Save image paths in NFO files'), kind: 'boolean' },
    { key: 'EnablePathSubstitution', label: t('Use path substitution for image paths'), kind: 'boolean' },
    { key: 'EnableExtraThumbsDuplication', label: t('Copy extrafanart into extrathumbs'), kind: 'boolean' },
];

export const NETWORK_FIELDS: FieldDef[] = [
    { key: 'BaseUrl', label: t('Base URL'), kind: 'text' },
    { key: 'InternalHttpPort', label: t('Local HTTP port'), kind: 'number', min: 1, max: 65535 },
    { key: 'InternalHttpsPort', label: t('Local HTTPS port'), kind: 'number', min: 1, max: 65535 },
    { key: 'PublicHttpPort', label: t('Public HTTP port'), kind: 'number', min: 1, max: 65535 },
    { key: 'PublicHttpsPort', label: t('Public HTTPS port'), kind: 'number', min: 1, max: 65535 },
    { key: 'EnableHttps', label: t('Enable HTTPS'), kind: 'boolean' },
    { key: 'RequireHttps', label: t('Require HTTPS for remote connections'), kind: 'boolean' },
    { key: 'CertificatePath', label: t('Custom SSL certificate path'), kind: 'text', note: t('PKCS #12 file readable by the server.') },
    { key: 'CertificatePassword', label: t('Certificate password'), kind: 'password' },
    { key: 'EnableRemoteAccess', label: t('Allow remote connections'), kind: 'boolean' },
    { key: 'RemoteIPFilter', label: t('Remote IP filter'), kind: 'list', note: t('Comma-separated IP addresses or CIDR ranges.') },
    { key: 'IsRemoteIPFilterBlacklist', label: t('Treat remote IP filter as a blocklist'), kind: 'boolean' },
    { key: 'LocalNetworkSubnets', label: t('LAN networks'), kind: 'list', note: t('Comma-separated CIDR ranges considered local.') },
    { key: 'LocalNetworkAddresses', label: t('Bind to local addresses'), kind: 'list', note: t('Empty binds all interfaces.') },
    { key: 'EnableIPv4', label: t('Enable IPv4'), kind: 'boolean' },
    { key: 'EnableIPv6', label: t('Enable IPv6'), kind: 'boolean' },
    { key: 'AutoDiscovery', label: t('Client auto-discovery'), kind: 'boolean' },
    { key: 'KnownProxies', label: t('Known proxies'), kind: 'list' },
    { key: 'PublishedServerUriBySubnet', label: t('Published server URIs'), kind: 'list', lines: true, note: t('One subnet=URL rule per line.') },
];

export const BRANDING_FIELDS: FieldDef[] = [
    { key: 'LoginDisclaimer', label: t('Login disclaimer'), kind: 'textarea', note: t('Shown below the sign-in form as plain text in UI Next.') },
    { key: 'CustomCss', label: t('Custom CSS'), kind: 'textarea', note: t('Served to every web client, including UI Next.') },
    { key: 'SplashscreenEnabled', label: t('Show splash screen image'), kind: 'boolean', note: t('UI Next uses it as the sign-in backdrop.') },
];

export const POLICY_FIELDS: FieldDef[] = [
    { key: 'IsHidden', label: t('Hide from the login screen'), kind: 'boolean' },
    { key: 'EnableUserPreferenceAccess', label: t('Can change own preferences'), kind: 'boolean' },
    { key: 'EnableAudioPlaybackTranscoding', label: t('Audio transcoding'), kind: 'boolean' },
    { key: 'EnableVideoPlaybackTranscoding', label: t('Video transcoding'), kind: 'boolean' },
    { key: 'EnablePlaybackRemuxing', label: t('Remuxing'), kind: 'boolean' },
    { key: 'ForceRemoteSourceTranscoding', label: t('Force transcoding of remote sources'), kind: 'boolean' },
    { key: 'EnableContentDownloading', label: t('Downloads'), kind: 'boolean' },
    { key: 'EnableContentDeletion', label: t('Delete media from all libraries'), kind: 'boolean' },
    { key: 'EnableCollectionManagement', label: t('Manage collections'), kind: 'boolean' },
    { key: 'EnableSubtitleManagement', label: t('Manage subtitles'), kind: 'boolean' },
    { key: 'EnableLyricManagement', label: t('Manage lyrics'), kind: 'boolean' },
    { key: 'EnableRemoteControlOfOtherUsers', label: t('Remote control of other users'), kind: 'boolean' },
    { key: 'EnableSharedDeviceControl', label: t('Control shared devices'), kind: 'boolean' },
    { key: 'EnablePublicSharing', label: t('Public sharing'), kind: 'boolean' },
    { key: 'SyncPlayAccess', label: t('SyncPlay'), kind: 'select', values: [ [ 'CreateAndJoinGroups', 'Create and join groups' ], [ 'JoinGroups', 'Join groups' ], [ 'None', 'Disabled' ] ] },
    { key: 'RemoteClientBitrateLimit', label: t('Remote bitrate limit'), kind: 'number', min: 0, step: 0.1, unit: 'Mbps', scale: 1_000_000, note: t('0 means unlimited.') },
    { key: 'MaxActiveSessions', label: t('Maximum active sessions'), kind: 'number', min: 0, note: t('0 means unlimited.') },
    { key: 'LoginAttemptsBeforeLockout', label: t('Failed logins before lockout'), kind: 'number', min: -1, note: t('0 uses the default, -1 never locks.') },
    { key: 'MaxParentalSubRating', label: t('Maximum parental sub-rating'), kind: 'number', min: 0, nullable: true, note: t('Pairs with the maximum rating; empty means unrestricted.') },
    { key: 'AllowedTags', label: t('Allowed tags'), kind: 'list', note: t('When set, only items with one of these tags are visible.') },
    { key: 'AuthenticationProviderId', label: t('Authentication provider'), kind: 'select' },
    { key: 'PasswordResetProviderId', label: t('Password reset provider'), kind: 'select' },
];

export const UNRATED_ITEM_KINDS: Array<[string, string]> = [
    [ 'Book', 'Books' ], [ 'ChannelContent', 'Channels' ], [ 'LiveTvChannel', 'Live TV' ], [ 'Movie', 'Movies' ],
    [ 'Music', 'Music' ], [ 'Trailer', 'Trailers' ], [ 'Series', 'Shows' ],
];

/** The permission set the SSO RBAC server patch accepts (mirrors jellyfin_web_rbac). */
export const RBAC_PERMISSIONS: Array<[string, string]> = [
    [ 'IsAdministrator', 'Administrator' ], [ 'EnableContentDeletion', 'Content deletion' ], [ 'EnableSubtitleManagement', 'Subtitle management' ],
    [ 'EnableLyricManagement', 'Lyric management' ], [ 'EnableLiveTvAccess', 'Live TV access' ], [ 'EnableLiveTvManagement', 'Live TV management' ],
    [ 'EnableLiveTvMultiview', 'Live TV Multiview' ], [ 'EnableMediaPlayback', 'Media playback' ], [ 'EnableAudioPlaybackTranscoding', 'Audio transcoding' ],
    [ 'EnableVideoPlaybackTranscoding', 'Video transcoding' ], [ 'EnableContentDownloading', 'Downloads' ], [ 'EnablePublicSharing', 'Public sharing' ],
    [ 'EnableRemoteAccess', 'Remote access' ],
];

const onOff = (key: string, label: string): FieldDef => ({ key, label, kind: 'select', nullable: true, values: [ [ '', 'Inherit' ], [ 'true', 'On' ], [ 'false', 'Off' ] ] });
const choice = (key: string, label: string, values: string[]): FieldDef => ({ key, label, kind: 'select', nullable: true, values: [ [ '', 'Inherit' ], ...values.map(value => [ value, value ] as [string, string]) ] });
const optionalNumber = (key: string, label: string, min: number, max: number, step = 1): FieldDef => ({ key, label, kind: 'number', min, max, step, nullable: true });

/** Sparse per-device overrides from jellyfin_zzzzz_device_playback_options; empty means inherit. */
export const DEVICE_PLAYBACK_FIELDS: FieldDef[] = [
    optionalNumber('maxStreamingBitrate', t('Maximum streaming bitrate (bits/s)'), 1, 1_000_000_000),
    onOff('allowDirectPlay', t('Direct play')), onOff('allowDirectStream', t('Direct stream')),
    onOff('allowVideoTranscoding', t('Video transcoding')), onOff('allowAudioTranscoding', t('Audio transcoding')),
    choice('preferredVideoCodec', t('Preferred video codec'), [ 'h264', 'hevc', 'av1' ]),
    onOff('enableTonemapping', t('Tone mapping')), onOff('enableVppTonemapping', t('VPP tone mapping')), onOff('enableVideoToolboxTonemapping', t('VideoToolbox tone mapping')),
    choice('tonemappingAlgorithm', 'Tone-mapping algorithm', [ 'none', 'clip', 'linear', 'gamma', 'reinhard', 'hable', 'mobius', 'bt2390' ]),
    choice('tonemappingMode', 'Tone-mapping mode', [ 'auto', 'max', 'rgb', 'lum', 'itp' ]),
    choice('tonemappingRange', 'Tone-mapping range', [ 'auto', 'tv', 'pc' ]),
    optionalNumber('tonemappingDesat', 'Desaturation', 0, 1, 0.01), optionalNumber('tonemappingPeak', t('Source peak'), 0, 1000, 0.1),
    optionalNumber('tonemappingParam', 'Tone-mapping parameter', 0, 10, 0.01),
    optionalNumber('vppTonemappingBrightness', t('VPP brightness'), -100, 100, 0.1), optionalNumber('vppTonemappingContrast', t('VPP contrast'), 0, 10, 0.01),
    onOff('enableAudioVbr', 'Variable-bitrate audio'), optionalNumber('downMixAudioBoost', t('Audio downmix boost'), 0, 10, 0.1),
    choice('downMixStereoAlgorithm', t('Stereo downmix algorithm'), [ 'None', 'Dave750', 'NightmodeDialogue', 'Rfc7845', 'Ac4' ]),
    optionalNumber('h264Crf', 'H.264 CRF', 0, 51), optionalNumber('h265Crf', t('HEVC CRF'), 0, 51),
    choice('encoderPreset', t('Encoder preset'), [ 'auto', 'placebo', 'veryslow', 'slower', 'slow', 'medium', 'fast', 'faster', 'veryfast', 'superfast', 'ultrafast' ]),
    onOff('deinterlaceDoubleRate', 'Double-rate deinterlacing'), choice('deinterlaceMethod', t('Deinterlacing method'), [ 'yadif', 'bwdif' ]),
    choice('hlsAudioSeekStrategy', t('HLS audio seeking'), [ 'TrimCopiedAudio', 'TranscodeAudio' ]),
    onOff('enableHardwareEncoding', t('Hardware encoding')), onOff('allowHevcEncoding', t('HEVC encoding')), onOff('allowAv1Encoding', 'AV1 encoding'),
    onOff('enableTranscodeCodecFallback', t('Codec fallback')), onOff('enableParallelCodecRace', t('Parallel codec race')),
    onOff('enableDecodingColorDepth10Hevc', '10-bit HEVC decode'), onOff('enableDecodingColorDepth10Vp9', '10-bit VP9 decode'),
    onOff('enableDecodingColorDepth10HevcRext', '10-bit HEVC RExt decode'), onOff('enableDecodingColorDepth12HevcRext', '12-bit HEVC RExt decode'),
    onOff('enableEnhancedNvdecDecoder', t('Enhanced NVDEC')), onOff('preferSystemNativeHwDecoder', t('Prefer native hardware decoder')),
    onOff('enableIntelLowPowerH264HwEncoder', t('Intel low-power H.264 encoder')), onOff('enableIntelLowPowerHevcHwEncoder', t('Intel low-power HEVC encoder')),
];

/** Device override form values → sparse payload (inherit fields omitted, tri-state selects become booleans). */
export function devicePlaybackPayload(draft: Record<string, unknown>): Record<string, unknown> {
    const payload: Record<string, unknown> = {};
    DEVICE_PLAYBACK_FIELDS.forEach(field => {
        const value = draft[field.key];
        if (value === null || value === undefined || value === '') return;
        payload[field.key] = value === 'true' ? true : value === 'false' ? false : value;
    });
    return payload;
}

/** Stored overrides → form values (booleans become the tri-state select strings). */
export function devicePlaybackDraft(options: Record<string, unknown> | null | undefined): Record<string, unknown> {
    const draft: Record<string, unknown> = {};
    Object.entries(options || {}).forEach(([key, value]) => {
        if (value === null || value === undefined) return;
        draft[key] = typeof value === 'boolean' ? String(value) : value;
    });
    return draft;
}

/* Scheduled task triggers */

export type TriggerType = 'DailyTrigger' | 'WeeklyTrigger' | 'IntervalTrigger' | 'StartupTrigger';

export interface TaskTrigger {
    Type: TriggerType;
    TimeOfDayTicks?: number;
    IntervalTicks?: number;
    DayOfWeek?: string;
    MaxRuntimeTicks?: number;
}

export const TICKS_PER_MINUTE = 600_000_000;
export const TICKS_PER_HOUR = 60 * TICKS_PER_MINUTE;
export const WEEK_DAYS = [ 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday' ];

function clock(ticks = 0): string {
    const minutes = Math.round(ticks / TICKS_PER_MINUTE) % (24 * 60);
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function describeTrigger(trigger: TaskTrigger): string {
    const limit = trigger.MaxRuntimeTicks ? ` (stops after ${Number((trigger.MaxRuntimeTicks / TICKS_PER_HOUR).toFixed(2))} h)` : '';
    if (trigger.Type === 'DailyTrigger') return `Daily at ${clock(trigger.TimeOfDayTicks)}${limit}`;
    if (trigger.Type === 'WeeklyTrigger') return `Every ${trigger.DayOfWeek || 'week'} at ${clock(trigger.TimeOfDayTicks)}${limit}`;
    if (trigger.Type === 'IntervalTrigger') {
        const hours = (trigger.IntervalTicks || 0) / TICKS_PER_HOUR;
        return `Every ${hours >= 1 ? `${Number(hours.toFixed(2))} h` : `${Math.round(hours * 60)} min`}${limit}`;
    }
    return `On server startup${limit}`;
}

export interface TriggerForm { type: TriggerType; time: string; day: string; intervalHours: string; maxRuntimeHours: string }

export function buildTrigger(form: TriggerForm): TaskTrigger | { error: string } {
    const trigger: TaskTrigger = { Type: form.type };
    if (form.type === 'DailyTrigger' || form.type === 'WeeklyTrigger') {
        const match = /^(\d{1,2}):(\d{2})$/.exec(form.time.trim());
        if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return { error: t('Enter a time as HH:MM.') };
        trigger.TimeOfDayTicks = (Number(match[1]) * 60 + Number(match[2])) * TICKS_PER_MINUTE;
    }
    if (form.type === 'WeeklyTrigger') {
        if (!WEEK_DAYS.includes(form.day)) return { error: t('Choose a day of the week.') };
        trigger.DayOfWeek = form.day;
    }
    if (form.type === 'IntervalTrigger') {
        const hours = Number(form.intervalHours);
        if (!Number.isFinite(hours) || hours < 0.25) return { error: t('The interval must be at least 0.25 hours.') };
        trigger.IntervalTicks = Math.round(hours * TICKS_PER_HOUR);
    }
    if (form.maxRuntimeHours.trim()) {
        const hours = Number(form.maxRuntimeHours);
        if (!Number.isFinite(hours) || hours <= 0) return { error: t('The time limit must be a positive number of hours.') };
        trigger.MaxRuntimeTicks = Math.round(hours * TICKS_PER_HOUR);
    }
    return trigger;
}

/* Access schedules (user policy) */

export interface AccessSchedule { DayOfWeek: string; StartHour: number; EndHour: number }
export const SCHEDULE_DAYS = [ 'Everyday', 'Weekday', 'Weekend', ...WEEK_DAYS ];

export function validateSchedule(schedule: AccessSchedule): string {
    if (!SCHEDULE_DAYS.includes(schedule.DayOfWeek)) return t('Choose a day.');
    if (!(schedule.StartHour >= 0 && schedule.StartHour < 24 && schedule.EndHour > 0 && schedule.EndHour <= 24)) return t('Hours must be between 0 and 24.');
    if (schedule.EndHour <= schedule.StartHour) return t('The end hour must be after the start hour.');
    return '';
}
