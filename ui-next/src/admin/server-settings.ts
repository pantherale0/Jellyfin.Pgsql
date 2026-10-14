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
        if (!text.trim()) return field.nullable ? { value: null } : { error: `${field.label} is required.` };
        const shown = Number(text);
        if (!Number.isFinite(shown)) return { error: `${field.label} must be a number.` };
        if (field.min !== undefined && shown < field.min) return { error: `${field.label} must be at least ${field.min}.` };
        if (field.max !== undefined && shown > field.max) return { error: `${field.label} must be at most ${field.max}.` };
        if ((field.step ?? 1) >= 1 && !Number.isInteger(shown)) return { error: `${field.label} must be a whole number.` };
        return { value: field.scale ? Math.round(shown * field.scale) : shown };
    }
    if (field.kind === 'select' && field.values && text && !field.values.some(option => (Array.isArray(option) ? option[0] : option) === text)) {
        return { error: `${field.label} has an unsupported value.` };
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
    { key: 'MinResumePct', label: 'Minimum resume percentage', kind: 'number', min: 0, max: 100, unit: '%', note: 'Titles stopped before this point are treated as not started.' },
    { key: 'MaxResumePct', label: 'Maximum resume percentage', kind: 'number', min: 1, max: 100, unit: '%', note: 'Titles stopped after this point are marked played.' },
    { key: 'MinResumeDurationSeconds', label: 'Minimum resumable duration', kind: 'number', min: 0, unit: 'seconds', note: 'Shorter titles never store a resume position.' },
    { key: 'MinAudiobookResume', label: 'Audiobook minimum resume', kind: 'number', min: 0, unit: 'minutes' },
    { key: 'MaxAudiobookResume', label: 'Audiobook remaining before played', kind: 'number', min: 0, unit: 'minutes' },
];

export const STREAMING_FIELDS: FieldDef[] = [
    { key: 'RemoteClientBitrateLimit', label: 'Remote client bitrate limit', kind: 'number', min: 0, step: 0.1, unit: 'Mbps', scale: 1_000_000, note: '0 means unlimited. Per-user limits can be lower.' },
];

export const TRICKPLAY_FIELDS: FieldDef[] = [
    { key: 'TrickplayOptions.EnableHwAcceleration', label: 'Hardware decoding', kind: 'boolean' },
    { key: 'TrickplayOptions.EnableHwEncoding', label: 'Hardware MJPEG encoding', kind: 'boolean' },
    { key: 'TrickplayOptions.EnableKeyFrameOnlyExtraction', label: 'Key frames only', kind: 'boolean', note: 'Faster extraction with less accurate thumbnails.' },
    { key: 'TrickplayOptions.ScanBehavior', label: 'Scan behaviour', kind: 'select', values: [ [ 'NonBlocking', 'Non-blocking' ], [ 'Blocking', 'Blocking' ] ] },
    { key: 'TrickplayOptions.ProcessPriority', label: 'Process priority', kind: 'select', values: [ 'High', 'AboveNormal', 'Normal', 'BelowNormal', 'Idle' ] },
    { key: 'TrickplayOptions.Interval', label: 'Image interval', kind: 'number', min: 1, ...ms('ms') },
    { key: 'TrickplayOptions.WidthResolutions', label: 'Width resolutions', kind: 'list', note: 'Comma-separated pixel widths, e.g. 320.' },
    { key: 'TrickplayOptions.TileWidth', label: 'Tile width', kind: 'number', min: 1 },
    { key: 'TrickplayOptions.TileHeight', label: 'Tile height', kind: 'number', min: 1 },
    { key: 'TrickplayOptions.Qscale', label: 'Quality scale', kind: 'number', min: 2, max: 31, note: 'Lower is better quality.' },
    { key: 'TrickplayOptions.JpegQuality', label: 'JPEG quality', kind: 'number', min: 1, max: 100 },
    { key: 'TrickplayOptions.ProcessThreads', label: 'FFmpeg threads', kind: 'number', min: 0, note: '0 lets FFmpeg decide.' },
];

export const DVR_FIELDS: FieldDef[] = [
    { key: 'RecordingPath', label: 'Default recording path', kind: 'text' },
    { key: 'MovieRecordingPath', label: 'Movie recording path', kind: 'text', note: 'Empty uses the default path.' },
    { key: 'SeriesRecordingPath', label: 'Series recording path', kind: 'text', note: 'Empty uses the default path.' },
    { key: 'EnableRecordingSubfolders', label: 'Use subfolders for categories', kind: 'boolean' },
    { key: 'PrePaddingSeconds', label: 'Default pre-padding', kind: 'number', min: 0, unit: 'minutes', scale: 60 },
    { key: 'PostPaddingSeconds', label: 'Default post-padding', kind: 'number', min: 0, unit: 'minutes', scale: 60 },
    { key: 'GuideDays', label: 'Guide days to download', kind: 'number', min: 1, max: 14, nullable: true, note: 'Empty lets the server decide.' },
    { key: 'EnableOriginalAudioWithEncodedRecordings', label: 'Keep original audio in encoded recordings', kind: 'boolean' },
    { key: 'SaveRecordingNFO', label: 'Save recording NFO metadata', kind: 'boolean' },
    { key: 'SaveRecordingImages', label: 'Save recording images', kind: 'boolean' },
    { key: 'RecordingPostProcessor', label: 'Post-processing application', kind: 'text' },
    { key: 'RecordingPostProcessorArguments', label: 'Post-processor arguments', kind: 'text', note: '{path} is replaced with the recording path.' },
];

export const GENERAL_FIELDS: FieldDef[] = [
    { key: 'ServerName', label: 'Server name', kind: 'text' },
    { key: 'UICulture', label: 'Server language', kind: 'select' },
    { key: 'QuickConnectAvailable', label: 'Quick Connect', kind: 'boolean' },
    { key: 'CachePath', label: 'Cache path', kind: 'text', note: 'Empty uses the default cache directory. Takes effect after restart.' },
    { key: 'MetadataPath', label: 'Metadata path', kind: 'text', note: 'Empty uses the default metadata directory.' },
    { key: 'LibraryScanFanoutConcurrency', label: 'Parallel library scan tasks', kind: 'number', min: 0, note: '0 uses the CPU core count.' },
    { key: 'LibraryMetadataRefreshConcurrency', label: 'Parallel metadata refreshes', kind: 'number', min: 0, note: '0 uses the CPU core count.' },
    { key: 'ParallelImageEncodingLimit', label: 'Parallel image encodes', kind: 'number', min: 0, note: '0 uses the CPU core count.' },
];

export const LOGGING_FIELDS: FieldDef[] = [
    { key: 'EnableSlowResponseWarning', label: 'Log slow responses', kind: 'boolean' },
    { key: 'SlowResponseThresholdMs', label: 'Slow response threshold', kind: 'number', min: 0, unit: 'ms' },
    { key: 'ActivityLogRetentionDays', label: 'Activity log retention', kind: 'number', min: 0, nullable: true, unit: 'days', note: 'Empty keeps entries forever.' },
    { key: 'LogFileRetentionDays', label: 'Log file retention', kind: 'number', min: 1, unit: 'days' },
];

export const NETWORK_FIELDS: FieldDef[] = [
    { key: 'BaseUrl', label: 'Base URL', kind: 'text' },
    { key: 'InternalHttpPort', label: 'Local HTTP port', kind: 'number', min: 1, max: 65535 },
    { key: 'InternalHttpsPort', label: 'Local HTTPS port', kind: 'number', min: 1, max: 65535 },
    { key: 'PublicHttpPort', label: 'Public HTTP port', kind: 'number', min: 1, max: 65535 },
    { key: 'PublicHttpsPort', label: 'Public HTTPS port', kind: 'number', min: 1, max: 65535 },
    { key: 'EnableHttps', label: 'Enable HTTPS', kind: 'boolean' },
    { key: 'RequireHttps', label: 'Require HTTPS for remote connections', kind: 'boolean' },
    { key: 'CertificatePath', label: 'Custom SSL certificate path', kind: 'text', note: 'PKCS #12 file readable by the server.' },
    { key: 'CertificatePassword', label: 'Certificate password', kind: 'password' },
    { key: 'EnableRemoteAccess', label: 'Allow remote connections', kind: 'boolean' },
    { key: 'RemoteIPFilter', label: 'Remote IP filter', kind: 'list', note: 'Comma-separated IP addresses or CIDR ranges.' },
    { key: 'IsRemoteIPFilterBlacklist', label: 'Treat remote IP filter as a blocklist', kind: 'boolean' },
    { key: 'LocalNetworkSubnets', label: 'LAN networks', kind: 'list', note: 'Comma-separated CIDR ranges considered local.' },
    { key: 'LocalNetworkAddresses', label: 'Bind to local addresses', kind: 'list', note: 'Empty binds all interfaces.' },
    { key: 'EnableIPv4', label: 'Enable IPv4', kind: 'boolean' },
    { key: 'EnableIPv6', label: 'Enable IPv6', kind: 'boolean' },
    { key: 'AutoDiscovery', label: 'Client auto-discovery', kind: 'boolean' },
    { key: 'KnownProxies', label: 'Known proxies', kind: 'list' },
    { key: 'PublishedServerUriBySubnet', label: 'Published server URIs', kind: 'list', lines: true, note: 'One subnet=URL rule per line.' },
];

export const BRANDING_FIELDS: FieldDef[] = [
    { key: 'LoginDisclaimer', label: 'Login disclaimer', kind: 'textarea', note: 'Shown below the sign-in form as plain text in UI Next.' },
    { key: 'CustomCss', label: 'Custom CSS', kind: 'textarea', note: 'Served to every web client, including UI Next.' },
    { key: 'SplashscreenEnabled', label: 'Show splash screen image', kind: 'boolean', note: 'UI Next uses it as the sign-in backdrop.' },
];

export const POLICY_FIELDS: FieldDef[] = [
    { key: 'IsHidden', label: 'Hide from the login screen', kind: 'boolean' },
    { key: 'EnableUserPreferenceAccess', label: 'Can change own preferences', kind: 'boolean' },
    { key: 'EnableAudioPlaybackTranscoding', label: 'Audio transcoding', kind: 'boolean' },
    { key: 'EnableVideoPlaybackTranscoding', label: 'Video transcoding', kind: 'boolean' },
    { key: 'EnablePlaybackRemuxing', label: 'Remuxing', kind: 'boolean' },
    { key: 'ForceRemoteSourceTranscoding', label: 'Force transcoding of remote sources', kind: 'boolean' },
    { key: 'EnableContentDownloading', label: 'Downloads', kind: 'boolean' },
    { key: 'EnableContentDeletion', label: 'Delete media from all libraries', kind: 'boolean' },
    { key: 'EnableCollectionManagement', label: 'Manage collections', kind: 'boolean' },
    { key: 'EnableSubtitleManagement', label: 'Manage subtitles', kind: 'boolean' },
    { key: 'EnableLyricManagement', label: 'Manage lyrics', kind: 'boolean' },
    { key: 'EnableRemoteControlOfOtherUsers', label: 'Remote control of other users', kind: 'boolean' },
    { key: 'EnableSharedDeviceControl', label: 'Control shared devices', kind: 'boolean' },
    { key: 'EnablePublicSharing', label: 'Public sharing', kind: 'boolean' },
    { key: 'SyncPlayAccess', label: 'SyncPlay', kind: 'select', values: [ [ 'CreateAndJoinGroups', 'Create and join groups' ], [ 'JoinGroups', 'Join groups' ], [ 'None', 'Disabled' ] ] },
    { key: 'RemoteClientBitrateLimit', label: 'Remote bitrate limit', kind: 'number', min: 0, step: 0.1, unit: 'Mbps', scale: 1_000_000, note: '0 means unlimited.' },
    { key: 'MaxActiveSessions', label: 'Maximum active sessions', kind: 'number', min: 0, note: '0 means unlimited.' },
    { key: 'LoginAttemptsBeforeLockout', label: 'Failed logins before lockout', kind: 'number', min: -1, note: '0 uses the default, -1 never locks.' },
    { key: 'MaxParentalSubRating', label: 'Maximum parental sub-rating', kind: 'number', min: 0, nullable: true, note: 'Pairs with the maximum rating; empty means unrestricted.' },
    { key: 'AllowedTags', label: 'Allowed tags', kind: 'list', note: 'When set, only items with one of these tags are visible.' },
    { key: 'AuthenticationProviderId', label: 'Authentication provider', kind: 'select' },
    { key: 'PasswordResetProviderId', label: 'Password reset provider', kind: 'select' },
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
    optionalNumber('maxStreamingBitrate', 'Maximum streaming bitrate (bits/s)', 1, 1_000_000_000),
    onOff('allowDirectPlay', 'Direct play'), onOff('allowDirectStream', 'Direct stream'),
    onOff('allowVideoTranscoding', 'Video transcoding'), onOff('allowAudioTranscoding', 'Audio transcoding'),
    choice('preferredVideoCodec', 'Preferred video codec', [ 'h264', 'hevc', 'av1' ]),
    onOff('enableTonemapping', 'Tone mapping'), onOff('enableVppTonemapping', 'VPP tone mapping'), onOff('enableVideoToolboxTonemapping', 'VideoToolbox tone mapping'),
    choice('tonemappingAlgorithm', 'Tone-mapping algorithm', [ 'none', 'clip', 'linear', 'gamma', 'reinhard', 'hable', 'mobius', 'bt2390' ]),
    choice('tonemappingMode', 'Tone-mapping mode', [ 'auto', 'max', 'rgb', 'lum', 'itp' ]),
    choice('tonemappingRange', 'Tone-mapping range', [ 'auto', 'tv', 'pc' ]),
    optionalNumber('tonemappingDesat', 'Desaturation', 0, 1, 0.01), optionalNumber('tonemappingPeak', 'Source peak', 0, 1000, 0.1),
    optionalNumber('tonemappingParam', 'Tone-mapping parameter', 0, 10, 0.01),
    optionalNumber('vppTonemappingBrightness', 'VPP brightness', -100, 100, 0.1), optionalNumber('vppTonemappingContrast', 'VPP contrast', 0, 10, 0.01),
    onOff('enableAudioVbr', 'Variable-bitrate audio'), optionalNumber('downMixAudioBoost', 'Audio downmix boost', 0, 10, 0.1),
    choice('downMixStereoAlgorithm', 'Stereo downmix algorithm', [ 'None', 'Dave750', 'NightmodeDialogue', 'Rfc7845', 'Ac4' ]),
    optionalNumber('h264Crf', 'H.264 CRF', 0, 51), optionalNumber('h265Crf', 'HEVC CRF', 0, 51),
    choice('encoderPreset', 'Encoder preset', [ 'auto', 'placebo', 'veryslow', 'slower', 'slow', 'medium', 'fast', 'faster', 'veryfast', 'superfast', 'ultrafast' ]),
    onOff('deinterlaceDoubleRate', 'Double-rate deinterlacing'), choice('deinterlaceMethod', 'Deinterlacing method', [ 'yadif', 'bwdif' ]),
    choice('hlsAudioSeekStrategy', 'HLS audio seeking', [ 'TrimCopiedAudio', 'TranscodeAudio' ]),
    onOff('enableHardwareEncoding', 'Hardware encoding'), onOff('allowHevcEncoding', 'HEVC encoding'), onOff('allowAv1Encoding', 'AV1 encoding'),
    onOff('enableTranscodeCodecFallback', 'Codec fallback'), onOff('enableParallelCodecRace', 'Parallel codec race'),
    onOff('enableDecodingColorDepth10Hevc', '10-bit HEVC decode'), onOff('enableDecodingColorDepth10Vp9', '10-bit VP9 decode'),
    onOff('enableDecodingColorDepth10HevcRext', '10-bit HEVC RExt decode'), onOff('enableDecodingColorDepth12HevcRext', '12-bit HEVC RExt decode'),
    onOff('enableEnhancedNvdecDecoder', 'Enhanced NVDEC'), onOff('preferSystemNativeHwDecoder', 'Prefer native hardware decoder'),
    onOff('enableIntelLowPowerH264HwEncoder', 'Intel low-power H.264 encoder'), onOff('enableIntelLowPowerHevcHwEncoder', 'Intel low-power HEVC encoder'),
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
        if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return { error: 'Enter a time as HH:MM.' };
        trigger.TimeOfDayTicks = (Number(match[1]) * 60 + Number(match[2])) * TICKS_PER_MINUTE;
    }
    if (form.type === 'WeeklyTrigger') {
        if (!WEEK_DAYS.includes(form.day)) return { error: 'Choose a day of the week.' };
        trigger.DayOfWeek = form.day;
    }
    if (form.type === 'IntervalTrigger') {
        const hours = Number(form.intervalHours);
        if (!Number.isFinite(hours) || hours < 0.25) return { error: 'The interval must be at least 0.25 hours.' };
        trigger.IntervalTicks = Math.round(hours * TICKS_PER_HOUR);
    }
    if (form.maxRuntimeHours.trim()) {
        const hours = Number(form.maxRuntimeHours);
        if (!Number.isFinite(hours) || hours <= 0) return { error: 'The time limit must be a positive number of hours.' };
        trigger.MaxRuntimeTicks = Math.round(hours * TICKS_PER_HOUR);
    }
    return trigger;
}

/* Access schedules (user policy) */

export interface AccessSchedule { DayOfWeek: string; StartHour: number; EndHour: number }
export const SCHEDULE_DAYS = [ 'Everyday', 'Weekday', 'Weekend', ...WEEK_DAYS ];

export function validateSchedule(schedule: AccessSchedule): string {
    if (!SCHEDULE_DAYS.includes(schedule.DayOfWeek)) return 'Choose a day.';
    if (!(schedule.StartHour >= 0 && schedule.StartHour < 24 && schedule.EndHour > 0 && schedule.EndHour <= 24)) return 'Hours must be between 0 and 24.';
    if (schedule.EndHour <= schedule.StartHour) return 'The end hour must be after the start hour.';
    return '';
}
