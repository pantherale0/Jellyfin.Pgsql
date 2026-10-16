import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { extname } from 'node:path';
import { test } from 'node:test';
import { readSource } from './source.mjs';

registerHooks({
    resolve(specifier, context, nextResolve) {
        return nextResolve(specifier.startsWith('.') && !extname(specifier) ? `${specifier}.ts` : specifier, context);
    }
});

const t = await import('../src/admin/transcoding-settings.ts');
const settings = await import('../src/admin/server-settings.ts');
const { createAdminApi } = await import('../src/admin/admin-api.ts');
const source = path => readSource(new URL(`../src/${path}`, import.meta.url), 'utf8');

const keysFor = type => t.transcodingSections(type).flatMap(section => section.fields.map(field => field.key));
const titlesFor = type => t.transcodingSections(type).map(section => section.title);

function fakeApi(responses = {}) {
    const calls = [];
    return {
        calls,
        session: { server: 'https://jf.test', token: 't', user: { Id: 'admin-id', Name: 'Admin' }, serverId: 's' },
        request(path, init = {}) {
            calls.push({ path, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined });
            const value = responses[`${init.method || 'GET'} ${path}`];
            return Promise.resolve(typeof value === 'function' ? value() : value);
        },
    };
}

test('MISS-29: every Jellyfin Web transcoding option and the fork options are editable', () => {
    const classic = [
        'AllowAv1Encoding', 'AllowHevcEncoding', 'DeinterlaceDoubleRate', 'DeinterlaceMethod', 'DownMixAudioBoost', 'DownMixStereoAlgorithm', 'EnableAudioVbr',
        'EnableDecodingColorDepth10Hevc', 'EnableDecodingColorDepth10HevcRext', 'EnableDecodingColorDepth10Vp9', 'EnableDecodingColorDepth12HevcRext',
        'EnableEnhancedNvdecDecoder', 'EnableFallbackFont', 'EnableHardwareEncoding', 'EnableIntelLowPowerH264HwEncoder', 'EnableIntelLowPowerHevcHwEncoder',
        'EnableSegmentDeletion', 'EnableSubtitleExtraction', 'EnableThrottling', 'EnableTonemapping', 'EnableVideoToolboxTonemapping', 'EnableVppTonemapping',
        'EncoderPreset', 'EncodingThreadCount', 'FallbackFontPath', 'H264Crf', 'H265Crf', 'HardwareAccelerationType', 'HardwareDecodingCodecs', 'HlsAudioSeekStrategy',
        'MaxMuxingQueueSize', 'PreferSystemNativeHwDecoder', 'QsvDevice', 'SegmentKeepSeconds', 'ThrottleDelaySeconds', 'TonemappingAlgorithm', 'TonemappingDesat',
        'TonemappingMode', 'TonemappingParam', 'TonemappingPeak', 'TonemappingRange', 'TranscodingTempPath', 'VaapiDevice', 'VppTonemappingBrightness', 'VppTonemappingContrast',
    ];
    const fork = [ 'EnableTranscodeCodecFallback', 'EnableParallelCodecRace', 'LiveStreamKeepSeconds', 'LiveStreamProbeDelayMs', 'LiveStreamAnalyzeDurationMs', 'LiveStreamProbeSize', 'LiveStreamOpenTimeoutMs' ];
    const all = t.ALL_TRANSCODING_FIELDS.map(field => field.key);
    for (const key of [ ...classic, ...fork ]) assert.ok(all.includes(key), `${key} is editable`);
    assert.equal(new Set(all).size, all.length, 'no duplicate fields');
});

test('MISS-29: fields follow the selected acceleration type like Jellyfin Web', () => {
    assert.ok(!titlesFor('none').includes('Decoding and encoding'));
    assert.ok(titlesFor('vaapi').includes('Decoding and encoding'));
    assert.ok(keysFor('none').includes('TonemappingAlgorithm'));
    assert.ok(!keysFor('none').includes('EnableTonemapping'));
    assert.ok(!keysFor('none').includes('TonemappingMode'));
    const vaapi = keysFor('vaapi');
    for (const key of [ 'VaapiDevice', 'EnableVppTonemapping', 'EnableIntelLowPowerH264HwEncoder', 'EnableDecodingColorDepth12HevcRext', 'EnableTonemapping', 'TonemappingMode' ]) assert.ok(vaapi.includes(key), key);
    assert.ok(!vaapi.includes('QsvDevice'));
    assert.ok(keysFor('qsv').includes('PreferSystemNativeHwDecoder'));
    assert.ok(keysFor('nvenc').includes('EnableEnhancedNvdecDecoder'));
    assert.ok(!keysFor('amf').includes('EnableDecodingColorDepth10HevcRext'));
    assert.ok(keysFor('videotoolbox').includes('EnableVideoToolboxTonemapping'));
    assert.ok(!titlesFor('v4l2m2m').includes('Tone mapping'), 'V4L2 has no tone mapping');
    assert.deepEqual(t.decodingCodecsFor('v4l2m2m').map(codec => codec.codec), [ 'h264' ]);
    assert.ok(t.decodingCodecsFor('rkmpp').some(codec => codec.codec === 'mpeg1video'));
    assert.deepEqual(t.decodingCodecsFor('none'), []);
});

test('MISS-29: number fields enforce Jellyfin Web bounds; live stream defaults can be cleared', () => {
    const field = key => t.ALL_TRANSCODING_FIELDS.find(entry => entry.key === key);
    assert.match(settings.parseInput(field('H264Crf'), '52').error, /at most 51/);
    assert.match(settings.parseInput(field('ThrottleDelaySeconds'), '5').error, /at least 10/);
    assert.deepEqual(settings.parseInput(field('DownMixAudioBoost'), '1.5'), { value: 1.5 });
    assert.match(settings.parseInput(field('VppTonemappingContrast'), '2.5').error, /at most 2/);
    assert.deepEqual(settings.parseInput(field('LiveStreamProbeDelayMs'), ''), { value: null });
    assert.deepEqual(settings.parseInput(field('LiveStreamProbeSize'), ''), { value: '' }, 'empty probe size means the global FFmpeg value, not the default');
    assert.deepEqual(settings.parseInput(field('EncodingThreadCount'), '-1'), { value: -1 });
});

test('MISS-29: saves only changed fields and drops codecs the chosen type cannot decode', () => {
    const saved = { HardwareAccelerationType: 'nvenc', HardwareDecodingCodecs: [ 'h264', 'mpeg4', 'vc1' ], H264Crf: 23, EnableTranscodeCodecFallback: true };
    assert.deepEqual(t.encodingPatch(saved, { ...saved }), {});
    const draft = { ...saved, HardwareAccelerationType: 'vaapi', H264Crf: 20 };
    assert.deepEqual(t.encodingPatch(saved, draft), { HardwareAccelerationType: 'vaapi', HardwareDecodingCodecs: [ 'h264', 'vc1' ], H264Crf: 20 });
    const fresh = { HardwareAccelerationType: 'none', HardwareDecodingCodecs: [ 'h264', 'vc1' ], H264Crf: 23 };
    assert.deepEqual(t.encodingPatch(fresh, { ...fresh }), {}, "Jellyfin's default decoder list on a none server is not a pending change");
    assert.deepEqual(t.encodingPatch(fresh, { ...fresh, H264Crf: 21 }), { H264Crf: 21 }, 'unrelated saves keep the stored decoder list');
    const untouched = { HardwareAccelerationType: 'vaapi', HardwareDecodingCodecs: [ 'h264', 'mpeg4' ] };
    assert.deepEqual(t.encodingPatch(untouched, { ...untouched }), {}, 'an untouched list is never rewritten');
    assert.deepEqual(t.toggleCodec([ 'h264' ], 'hevc', true), [ 'h264', 'hevc' ]);
    assert.deepEqual(t.toggleCodec([ 'h264', 'hevc' ], 'h264', false), [ 'hevc' ]);
    assert.deepEqual(t.toggleCodec([ 'h264' ], 'h264', true), [ 'h264' ]);
});

test('MISS-29: detected encoder capabilities gate choices without blocking unknown servers', () => {
    const caps = { AvailableAccelerationTypes: [ 'vaapi', 'qsv' ], HardwareDecodingCodecs: { vaapi: [ 'h264', 'hevc', 'av1' ] }, HardwareEncoding: { vaapi: { H264: true, Hevc: true, Av1: false } } };
    assert.equal(t.accelerationDetected(caps, 'vaapi'), true);
    assert.equal(t.accelerationDetected(caps, 'nvenc'), false);
    assert.equal(t.accelerationDetected(caps, 'none'), true);
    assert.equal(t.accelerationDetected(null, 'nvenc'), true);
    assert.deepEqual(t.allSupportedCodecs('vaapi', caps), [ 'h264', 'hevc', 'av1' ]);
    assert.deepEqual(t.allSupportedCodecs('vaapi', null), t.decodingCodecsFor('vaapi').map(codec => codec.codec));
    assert.equal(t.detectedDecoders(null, 'vaapi'), null);
    assert.deepEqual(t.missingHardwareEncoders(caps, 'vaapi'), [ 'AV1' ]);
    assert.deepEqual(t.missingHardwareEncoders(caps, 'qsv'), []);
});

test('MISS-29: validation blocks contradictory or incomplete hardware settings', () => {
    assert.equal(t.validateTranscoding({ HardwareAccelerationType: 'none' }), '');
    assert.match(t.validateTranscoding({ EnableTranscodeCodecFallback: false, EnableParallelCodecRace: true }), /codec fallback/);
    assert.match(t.validateTranscoding({ HardwareAccelerationType: 'vaapi', VaapiDevice: ' ' }), /device path/);
    assert.equal(t.validateTranscoding({ HardwareAccelerationType: 'vaapi', VaapiDevice: '/dev/dri/renderD128' }), '');
});

test('MISS-29: saving merges onto a fresh encoding document and keeps fields the form does not show', async () => {
    const fresh = { HardwareAccelerationType: 'none', EncoderAppPath: '/usr/lib/jellyfin-ffmpeg/ffmpeg', EncoderAppPathDisplay: '/usr/lib/jellyfin-ffmpeg/ffmpeg', H264Crf: 23, LiveStreamKeepSeconds: 300 };
    const api = fakeApi({ [`GET ${t.ENCODING_CONFIG_PATH}`]: () => ({ ...fresh }) });
    const next = await createAdminApi(api).saveConfigPatch(t.ENCODING_CONFIG_PATH, t.encodingPatch(fresh, { ...fresh, HardwareAccelerationType: 'qsv', HardwareDecodingCodecs: [ 'h264' ] }));
    const post = api.calls.find(call => call.method === 'POST');
    assert.equal(post.path, t.ENCODING_CONFIG_PATH);
    assert.equal(post.body.EncoderAppPath, '/usr/lib/jellyfin-ffmpeg/ffmpeg');
    assert.equal(post.body.LiveStreamKeepSeconds, 300);
    assert.equal(post.body.HardwareAccelerationType, 'qsv');
    assert.deepEqual(post.body.HardwareDecodingCodecs, [ 'h264' ]);
    assert.deepEqual(next, post.body);
});

test('MISS-29: the Transcoding tab renders the settings editor with capability hints and a guarded save', () => {
    const page = source('admin/pages/admin-transcoding.tsx');
    assert.match(page, /disabled=\{value !== type && !accelerationDetected\(capabilities, value\)\}/);
    assert.match(page, />Enable all supported<\/button>/);
    assert.match(page, /disabled=\{draft\.EnableTranscodeCodecFallback === false\}/);
    assert.match(page, /const problem = validateTranscoding\(draft\);/);
    assert.match(page, /api\.saveConfigPatch\(ENCODING_CONFIG_PATH, patch\)/);
    assert.match(page, /saved\.EncoderAppPathDisplay/);
    assert.match(source('admin/pages/admin-playback.tsx'), /<TranscodingSettings api=\{api\} \/>/);
});
