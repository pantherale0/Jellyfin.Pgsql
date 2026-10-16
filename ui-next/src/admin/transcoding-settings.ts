import { changedFields, type FieldDef } from './server-settings';
import { t } from '../i18n';

/** Server-wide transcoding settings (`/System/Configuration/encoding`), mirroring Jellyfin Web's Transcoding page plus the fork's codec-fallback and live-stream options. */
export const ENCODING_CONFIG_PATH = '/System/Configuration/encoding';

export const HWA_TYPES: Array<[string, string]> = [
    [ 'none', 'None' ],
    [ 'amf', 'AMD AMF' ],
    [ 'nvenc', 'Nvidia NVENC' ],
    [ 'qsv', 'Intel Quicksync (QSV)' ],
    [ 'vaapi', 'Video Acceleration API (VAAPI)' ],
    [ 'rkmpp', 'Rockchip MPP (RKMPP)' ],
    [ 'videotoolbox', 'Apple VideoToolBox' ],
    [ 'v4l2m2m', 'Video4Linux2 (V4L2)' ],
];

/** Hardware decoders per acceleration type, as in Jellyfin Web's `CODECS`. */
export const DECODING_CODECS: Array<{ name: string; codec: string; types: string[] }> = [
    { name: 'H264', codec: 'h264', types: [ 'amf', 'nvenc', 'qsv', 'vaapi', 'rkmpp', 'videotoolbox', 'v4l2m2m' ] },
    { name: 'HEVC', codec: 'hevc', types: [ 'amf', 'nvenc', 'qsv', 'vaapi', 'rkmpp', 'videotoolbox' ] },
    { name: 'MPEG1', codec: 'mpeg1video', types: [ 'rkmpp' ] },
    { name: 'MPEG2', codec: 'mpeg2video', types: [ 'amf', 'nvenc', 'qsv', 'vaapi', 'rkmpp' ] },
    { name: 'MPEG4', codec: 'mpeg4', types: [ 'nvenc', 'rkmpp' ] },
    { name: 'VC1', codec: 'vc1', types: [ 'amf', 'nvenc', 'qsv', 'vaapi' ] },
    { name: 'VP8', codec: 'vp8', types: [ 'nvenc', 'qsv', 'vaapi', 'rkmpp', 'videotoolbox' ] },
    { name: 'VP9', codec: 'vp9', types: [ 'amf', 'nvenc', 'qsv', 'vaapi', 'rkmpp', 'videotoolbox' ] },
    { name: 'AV1', codec: 'av1', types: [ 'amf', 'nvenc', 'qsv', 'vaapi', 'rkmpp', 'videotoolbox' ] },
];

const HEVC_VP9_10BIT_TYPES = [ 'amf', 'nvenc', 'qsv', 'vaapi', 'rkmpp' ];
const HEVC_REXT_TYPES = [ 'nvenc', 'qsv', 'vaapi' ];
const FULL_HWA_TYPES = [ 'amf', 'nvenc', 'qsv', 'vaapi', 'rkmpp', 'videotoolbox' ];

/** Shape of `/System/MediaEncoder/Capabilities` from jellyfin_hwa_capabilities.patch. */
export interface EncoderCapabilities {
    AvailableAccelerationTypes?: string[];
    HardwareDecodingCodecs?: Record<string, string[]>;
    HardwareEncoding?: Record<string, { H264?: boolean; Hevc?: boolean; Av1?: boolean }>;
}

export interface TranscodingSection { title: string; fields: FieldDef[]; note?: string }

const toggle = (key: string, label: string, note?: string): FieldDef => ({ key, label, kind: 'boolean', note });
const pick = (key: string, label: string, values: Array<string | [string, string]>, note?: string): FieldDef => ({ key, label, kind: 'select', values, note });
const amount = (key: string, label: string, min: number, max: number | undefined, step = 1, extra: Partial<FieldDef> = {}): FieldDef => ({ key, label, kind: 'number', min, max, step, ...extra });

export const isFullHwa = (type: string): boolean => FULL_HWA_TYPES.indexOf(type) >= 0;

/** Sections and fields that apply to the chosen acceleration type, in Jellyfin Web's order. */
export function transcodingSections(type: string): TranscodingSection[] {
    const hardware: FieldDef[] = [];
    if (type === 'vaapi') hardware.push({ key: 'VaapiDevice', label: t('VA-API device'), kind: 'text', note: t('Render node used for hardware acceleration, for example /dev/dri/renderD128.') });
    if (type === 'qsv') hardware.push({ key: 'QsvDevice', label: t('QSV device'), kind: 'text', note: t('Optional render node for multi-GPU systems; leave empty for the default.') });
    if (HEVC_VP9_10BIT_TYPES.indexOf(type) >= 0) hardware.push(toggle('EnableDecodingColorDepth10Hevc', 'Hardware-decode 10-bit HEVC'), toggle('EnableDecodingColorDepth10Vp9', 'Hardware-decode 10-bit VP9'));
    if (HEVC_REXT_TYPES.indexOf(type) >= 0) hardware.push(toggle('EnableDecodingColorDepth10HevcRext', 'Hardware-decode HEVC RExt 8/10-bit'), toggle('EnableDecodingColorDepth12HevcRext', 'Hardware-decode HEVC RExt 12-bit'));
    if (type === 'nvenc') hardware.push(toggle('EnableEnhancedNvdecDecoder', 'Enhanced NVDEC decoder'));
    if (type === 'qsv') hardware.push(toggle('PreferSystemNativeHwDecoder', 'Prefer OS-native DXVA or VA-API decoders'));
    if (type !== 'none') hardware.push(toggle('EnableHardwareEncoding', 'Hardware encoding'));
    if (type === 'qsv' || type === 'vaapi') hardware.push(
        toggle('EnableIntelLowPowerH264HwEncoder', 'Intel low-power H.264 encoder'),
        toggle('EnableIntelLowPowerHevcHwEncoder', 'Intel low-power HEVC encoder', 'Low-power encoders need the right firmware and driver; leave off unless your platform supports them.'),
    );

    const formats: FieldDef[] = [
        toggle('AllowHevcEncoding', 'Allow HEVC encoding'),
        toggle('AllowAv1Encoding', 'Allow AV1 encoding'),
        toggle('EnableTranscodeCodecFallback', 'Transcode codec fallback', 'If the requested video encoder fails at start, try H.264, HEVC and software encoders before failing. Fallbacks are written to the activity log.'),
        toggle('EnableParallelCodecRace', 'Parallel AV1/H.264 start race', 'When a client accepts both, start AV1 and H.264 together and keep whichever produces the first segment. Briefly doubles GPU load; needs codec fallback.'),
    ];

    const tone: FieldDef[] = [];
    if (type === 'qsv' || type === 'vaapi') tone.push(
        toggle('EnableVppTonemapping', 'VPP tone mapping', 'Intel hardware tone mapping for HDR10 and HLG; other HDR formats use the tone-mapping settings below.'),
        amount('VppTonemappingBrightness', t('VPP brightness gain'), 0, 100, 0.00001),
        amount('VppTonemappingContrast', t('VPP contrast gain'), 1, 2, 0.00001),
    );
    if (type === 'videotoolbox') tone.push(toggle('EnableVideoToolboxTonemapping', 'VideoToolbox tone mapping'));
    if (type === 'none' || isFullHwa(type)) {
        if (isFullHwa(type)) tone.push(toggle('EnableTonemapping', 'Tone mapping', 'Converts HDR to SDR while keeping detail and colour. Needs a supported GPU and driver.'));
        tone.push(pick('TonemappingAlgorithm', 'Tone-mapping algorithm', [ [ 'none', 'None' ], [ 'clip', 'Clip' ], [ 'linear', 'Linear' ], [ 'gamma', 'Gamma' ], [ 'reinhard', 'Reinhard' ], [ 'hable', 'Hable' ], [ 'mobius', 'Mobius' ], [ 'bt2390', 'BT.2390' ] ]));
        if (isFullHwa(type)) tone.push(pick('TonemappingMode', 'Tone-mapping mode', [ [ 'auto', 'Auto' ], [ 'max', 'MAX' ], [ 'rgb', 'RGB' ], [ 'lum', 'LUM' ], [ 'itp', 'ITP' ] ]));
        tone.push(
            pick('TonemappingRange', 'Tone-mapping range', [ [ 'auto', 'Auto' ], [ 'tv', 'TV' ], [ 'pc', 'PC' ] ]),
            amount('TonemappingDesat', 'Desaturation', 0, undefined, 0.00001, { note: t('Desaturates highlights brighter than this; 0 disables.') }),
            amount('TonemappingPeak', 'Peak', 0, undefined, 0.00001, { note: t('Overrides the signal peak; 0 uses the stream metadata.') }),
            amount('TonemappingParam', t('Algorithm parameter'), 0, undefined, 0.00001, { note: t('Tunes the selected algorithm; 0 uses its default.') }),
        );
    }

    const sections: TranscodingSection[] = [];
    if (hardware.length) sections.push({ title: t('Decoding and encoding'), fields: hardware });
    sections.push({ title: t('Encoding formats'), fields: formats });
    if (tone.length) sections.push({ title: t('Tone mapping'), fields: tone });
    sections.push({ title: t('Encoder'), fields: [
        amount('EncodingThreadCount', t('Transcoding threads'), -1, 64, 1, { note: t('-1 picks automatically; 0 uses the maximum.') }),
        pick('EncoderPreset', t('Encoder preset'), [ [ 'auto', 'Auto' ], 'veryslow', 'slower', 'slow', 'medium', 'fast', 'faster', 'veryfast', 'superfast', 'ultrafast' ], 'Faster presets lower quality per bitrate; slower presets use more CPU.'),
        amount('H265Crf', t('HEVC CRF'), 0, 51),
        amount('H264Crf', 'H.264 CRF', 0, 51, 1, { note: t('Lower values mean higher quality and larger files. Software encoders only.') }),
        pick('DeinterlaceMethod', t('Deinterlacing method'), [ [ 'yadif', 'YADIF' ], [ 'bwdif', 'BWDIF' ] ]),
        toggle('DeinterlaceDoubleRate', 'Double the frame rate when deinterlacing'),
        amount('MaxMuxingQueueSize', t('Maximum muxing queue size'), 1, undefined, 1, { note: t('Raise if FFmpeg reports "Too many packets buffered for output stream".') }),
    ] });
    sections.push({ title: t('Audio'), fields: [
        toggle('EnableAudioVbr', 'Variable-bitrate audio'),
        amount('DownMixAudioBoost', t('Downmix audio boost'), 0.5, 3, 0.1, { note: t('Volume multiplier when downmixing to stereo; 1 keeps the original level.') }),
        pick('DownMixStereoAlgorithm', t('Stereo downmix algorithm'), [ 'None', 'Dave750', 'NightmodeDialogue', [ 'Rfc7845', 'RFC7845' ], [ 'Ac4', 'AC-4' ] ]),
        pick('HlsAudioSeekStrategy', t('HLS audio seeking'), [ [ 'TrimCopiedAudio', 'Trim copied audio' ], [ 'TranscodeAudio', 'Transcode audio' ] ]),
    ] });
    sections.push({ title: t('Paths and subtitles'), fields: [
        { key: 'TranscodingTempPath', label: t('Transcode path'), kind: 'text', note: t('Folder for transcode segments; it must be writable by the server. Empty uses the default under the cache folder.') },
        { key: 'FallbackFontPath', label: t('Fallback font folder'), kind: 'text', note: t('Fonts used when rendering subtitles that need missing glyphs.') },
        toggle('EnableFallbackFont', 'Use fallback fonts'),
        toggle('EnableSubtitleExtraction', 'Extract embedded subtitles on the fly'),
    ] });
    sections.push({ title: t('Throttling and segments'), fields: [
        toggle('EnableThrottling', 'Throttle transcodes', 'Pauses transcoding when far enough ahead of playback.'),
        amount('ThrottleDelaySeconds', t('Throttle after'), 10, 3600, 1, { unit: 'seconds' }),
        toggle('EnableSegmentDeletion', 'Delete old segments', 'Removes segments the client has already downloaded.'),
        amount('SegmentKeepSeconds', t('Keep segments for'), 10, 3600, 1, { unit: 'seconds' }),
    ] });
    sections.push({ title: t('Live TV streams'), note: t('Leave a number empty to use the server default.'), fields: [
        amount('LiveStreamKeepSeconds', t('Rewind buffer'), 0, 3600, 1, { unit: 'seconds', note: t('0 disables the rolling buffer and records into one growing file.') }),
        amount('LiveStreamProbeDelayMs', t('Probe delay'), 0, 30000, 100, { unit: 'ms', nullable: true, note: t('Default 500 ms.') }),
        amount('LiveStreamAnalyzeDurationMs', t('Analyze duration'), 0, 30000, 100, { unit: 'ms', nullable: true, note: t('Default 3000 ms. Raise if stream details are missing.') }),
        { key: 'LiveStreamProbeSize', label: t('Probe size'), kind: 'text', note: t('For example 10M. Empty uses the global FFmpeg probe size.') },
        amount('LiveStreamOpenTimeoutMs', t('Open timeout'), 0, 120000, 1000, { unit: 'ms', nullable: true, note: t('Default 15000 ms for shared M3U streams; 0 disables the deadline.') }),
    ] });
    return sections;
}

const CODEC_LIST_FIELD: FieldDef = { key: 'HardwareDecodingCodecs', label: t('Hardware decoding'), kind: 'list' };
const HWA_FIELD: FieldDef = { key: 'HardwareAccelerationType', label: t('Hardware acceleration'), kind: 'select', values: HWA_TYPES };

/** Every field any acceleration type can show, so hidden-but-edited values still save. */
export const ALL_TRANSCODING_FIELDS: FieldDef[] = (() => {
    const seen = new Map<string, FieldDef>([ [ HWA_FIELD.key, HWA_FIELD ], [ CODEC_LIST_FIELD.key, CODEC_LIST_FIELD ] ]);
    HWA_TYPES.forEach(([ type ]) => transcodingSections(type).forEach(section => section.fields.forEach(field => { if (!seen.has(field.key)) seen.set(field.key, field); })));
    return Array.from(seen.values());
})();

export function decodingCodecsFor(type: string) {
    return DECODING_CODECS.filter(codec => codec.types.indexOf(type) >= 0);
}

/** Codecs FFmpeg on this server can hardware-decode for the type; null when capabilities are unknown. */
export function detectedDecoders(capabilities: EncoderCapabilities | null, type: string): Set<string> | null {
    if (!capabilities?.HardwareDecodingCodecs) return null;
    return new Set(capabilities.HardwareDecodingCodecs[type] || []);
}

/** Unknown capabilities never block a choice; `none` is always available. */
export function accelerationDetected(capabilities: EncoderCapabilities | null, type: string): boolean {
    if (type === 'none' || !capabilities?.AvailableAccelerationTypes) return true;
    return capabilities.AvailableAccelerationTypes.indexOf(type) >= 0;
}

/** Encoders the selected type lacks, for "not detected" hints next to HEVC/AV1. */
export function missingHardwareEncoders(capabilities: EncoderCapabilities | null, type: string): string[] {
    const encoding = capabilities?.HardwareEncoding?.[type];
    if (type === 'none' || !encoding) return [];
    return [ [ 'H264', 'H.264' ], [ 'Hevc', 'HEVC' ], [ 'Av1', 'AV1' ] ].filter(([ key ]) => encoding[key as 'H264' | 'Hevc' | 'Av1'] === false).map(([ , label ]) => label);
}

export function toggleCodec(codecs: string[] | undefined, codec: string, on: boolean): string[] {
    const current = codecs || [];
    if (on) return current.indexOf(codec) >= 0 ? current : [ ...current, codec ];
    return current.filter(entry => entry !== codec);
}

/** The "Enable all supported" action: every codec the type offers that FFmpeg also detected. */
export function allSupportedCodecs(type: string, capabilities: EncoderCapabilities | null): string[] {
    const detected = detectedDecoders(capabilities, type);
    return decodingCodecsFor(type).map(codec => codec.codec).filter(codec => !detected || detected.has(codec));
}

/**
 * Changed fields only. When the type or decoder list is edited, decoders the chosen hardware type cannot
 * use are dropped; an untouched list (including Jellyfin's default on a `none` server) is left alone.
 */
export function encodingPatch(saved: Record<string, any>, draft: Record<string, any>): Record<string, unknown> {
    const type = String(draft.HardwareAccelerationType || 'none');
    const typeChanged = type !== String(saved.HardwareAccelerationType || 'none');
    const codecsChanged = JSON.stringify(draft.HardwareDecodingCodecs || []) !== JSON.stringify(saved.HardwareDecodingCodecs || []);
    if (type === 'none' || (!typeChanged && !codecsChanged)) return changedFields(ALL_TRANSCODING_FIELDS, saved, draft);
    const offered = new Set(decodingCodecsFor(type).map(codec => codec.codec));
    const pruned = { ...draft, HardwareDecodingCodecs: (draft.HardwareDecodingCodecs || []).filter((codec: string) => offered.has(codec)) };
    return changedFields(ALL_TRANSCODING_FIELDS, saved, pruned);
}

export function validateTranscoding(draft: Record<string, any>): string {
    if (draft.EnableParallelCodecRace === true && draft.EnableTranscodeCodecFallback === false) return t('The parallel codec race needs transcode codec fallback to be on.');
    if (draft.HardwareAccelerationType === 'vaapi' && !String(draft.VaapiDevice || '').trim()) return 'VA-API needs a device path, for example /dev/dri/renderD128.';
    return '';
}
