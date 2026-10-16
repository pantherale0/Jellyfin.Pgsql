import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { extname } from 'node:path';
import { test } from 'node:test';

registerHooks({
    resolve(specifier, context, nextResolve) {
        return nextResolve(specifier.startsWith('.') && !extname(specifier) ? `${specifier}.ts` : specifier, context);
    }
});

const model = await import('../src/music-model.ts');
const settings = await import('../src/music-settings.ts');

const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual} != ${expected}`);

test('normalization gain converts dB to a linear factor that never amplifies', () => {
    close(model.gainFactor(-6), 0.501187, '-6 dB');
    assert.equal(model.gainFactor(0), 1);
    assert.equal(model.gainFactor(4), 1, 'positive gains clamp to 1');
    assert.equal(model.gainFactor(undefined), 1);
    assert.equal(model.gainFactor(Number.NaN), 1);
});

test('normalization mode picks track, album (falling back to track) or nothing', () => {
    const track = { NormalizationGain: -3 };
    assert.equal(model.normalizationDb(track, -5, 'album'), -5);
    assert.equal(model.normalizationDb(track, undefined, 'album'), -3);
    assert.equal(model.normalizationDb(track, -5, 'track'), -3);
    assert.equal(model.normalizationDb(track, -5, 'off'), undefined);
    assert.equal(model.normalizationDb({}, undefined, 'track'), undefined);
    close(model.elementVolume(0.5, -6, 1), 0.250594, 'volume × gain');
    assert.equal(model.elementVolume(2, 0, 1), 1);
    assert.equal(model.elementVolume(1, undefined, 0), 0);
});

test('crossfade is equal power and clamps its progress', () => {
    const mid = model.crossfadeEnvelope(0.5);
    close(mid.out ** 2 + mid.in ** 2, 1, 'power sum');
    assert.deepEqual(model.crossfadeEnvelope(-1), { out: 1, in: 0 });
    const end = model.crossfadeEnvelope(2);
    close(end.out, 0, 'out at end');
    assert.equal(end.in, 1);
});

test('album continuity follows track then disc order on the same album', () => {
    const a = { Id: '1', Name: 'a', AlbumId: 'al', IndexNumber: 4, ParentIndexNumber: 1 };
    assert.equal(model.continuesAlbum(a, { ...a, Id: '2', IndexNumber: 5 }), true);
    assert.equal(model.continuesAlbum(a, { ...a, Id: '2', IndexNumber: 7 }), false);
    assert.equal(model.continuesAlbum(a, { ...a, Id: '2', IndexNumber: 1, ParentIndexNumber: 2 }), true);
    assert.equal(model.continuesAlbum(a, { ...a, Id: '2', AlbumId: 'other', IndexNumber: 5 }), false);
    assert.equal(model.continuesAlbum({ ...a, AlbumId: undefined }, { ...a, AlbumId: undefined, IndexNumber: 5 }), false);
});

test('transition plans fade, preload and fall back to the ended event', () => {
    const base = { currentDuration: 200, nextDuration: 180, crossfadeSeconds: 6, gapless: true, albumContinues: false, volumeControl: true };
    assert.deepEqual(model.planTransition(base), { preloadAt: 174, startAt: 194, fadeSeconds: 6 });
    assert.deepEqual(model.planTransition({ ...base, albumContinues: true }), { preloadAt: 180, startAt: Infinity, fadeSeconds: 0 }, 'continuous albums stay gapless');
    assert.deepEqual(model.planTransition({ ...base, volumeControl: false }), { preloadAt: 180, startAt: Infinity, fadeSeconds: 0 }, 'no volume control, no fade');
    assert.deepEqual(model.planTransition({ ...base, crossfadeSeconds: 0, gapless: false }), { preloadAt: Infinity, startAt: Infinity, fadeSeconds: 0 });
    assert.equal(model.planTransition({ ...base, nextDuration: 8 }).fadeSeconds, 0, 'short next track');
    assert.equal(model.planTransition({ ...base, currentDuration: 10, crossfadeSeconds: 12 }).fadeSeconds, 5, 'fade capped at half the track');
    assert.equal(model.planTransition({ ...base, currentDuration: Number.NaN }).startAt, Infinity);
});

test('MediaSession metadata and position state are built defensively', () => {
    assert.deepEqual(model.mediaSessionMetadata({ Name: 'Song', Album: 'LP', Artists: [ 'A', 'B' ] }, 'http://img'), {
        title: 'Song', artist: 'A, B', album: 'LP', artwork: [ { src: 'http://img', sizes: '512x512', type: 'image/jpeg' } ]
    });
    assert.equal(model.mediaSessionMetadata({ Name: 'Song', AlbumArtists: [ { Name: 'Band' } ] }).artist, 'Band');
    assert.equal(model.mediaPositionState(5, Number.NaN), null);
    assert.deepEqual(model.mediaPositionState(500, 100), { duration: 100, position: 100, playbackRate: 1 });
    assert.equal(model.previousGoesBack(2), true);
    assert.equal(model.previousGoesBack(10), false);
});

test('music routing recognises tracks and music containers only', () => {
    assert.equal(model.isMusicTarget({ Type: 'Audio', MediaType: 'Audio' }), true);
    assert.equal(model.isMusicTarget({ Type: 'MusicAlbum' }), true);
    assert.equal(model.isMusicTarget({ Type: 'MusicArtist' }), true);
    assert.equal(model.isMusicTarget({ Type: 'Movie', MediaType: 'Video' }), false);
    assert.equal(model.isMusicTarget({ Type: 'MusicVideo', MediaType: 'Video' }), false);
});

test('music settings normalize and clamp stored values', () => {
    assert.deepEqual(settings.normalizeMusicSettings(null), settings.DEFAULT_MUSIC);
    assert.deepEqual(settings.normalizeMusicSettings({ normalization: 'loud', crossfadeSeconds: 40, gapless: 'yes', volume: 3 }), { normalization: 'album', crossfadeSeconds: 12, gapless: true, volume: 1 });
    assert.deepEqual(settings.normalizeMusicSettings({ normalization: 'track', crossfadeSeconds: '4.4', gapless: false, volume: 0.25 }), { normalization: 'track', crossfadeSeconds: 4, gapless: false, volume: 0.25 });
    assert.equal(settings.normalizeMusicSettings({ volume: -1 }).volume, 0);
});

if (typeof globalThis.document === 'undefined') globalThis.document = { createElement: () => ({ canPlayType: () => '' }) };
const queue = await import('../src/play-queue.ts');
const { buildDeviceProfile } = await import('../src/device-profile.ts');

const song = (id, extra = {}) => ({ Id: id, Name: id, Type: 'Audio', MediaType: 'Audio', ...extra });

test('the music queue accepts tracks only and keeps video queues free of them', () => {
    const items = [ song('a'), { Id: 'm', Name: 'Movie', Type: 'Movie', MediaType: 'Video' }, song('b') ];
    const music = queue.createQueue(items, 0, { accept: queue.audioQueueable });
    assert.deepEqual(music.queue.order.map(item => item.Id), [ 'a', 'b' ]);
    assert.equal(queue.createQueue([ song('a') ]), null, 'video queue rejects tracks');
    const next = queue.playNext(music.queue, song('c'), queue.audioQueueable);
    assert.deepEqual(next.order.map(item => item.Id), [ 'a', 'c', 'b' ]);
    assert.equal(queue.addToQueue(music.queue, { Id: 'm', Type: 'Movie', MediaType: 'Video' }, queue.audioQueueable), music.queue);
});

test('queue entries move and jump while the playing entry stays tracked', () => {
    const started = queue.createQueue([ song('a'), song('b'), song('c') ], 1, { accept: queue.audioQueueable }).queue;
    const moved = queue.moveInQueue(started, 1, 1);
    assert.deepEqual(moved.order.map(item => item.Id), [ 'a', 'c', 'b' ]);
    assert.equal(moved.position, 2, 'playing entry followed its move');
    const swapped = queue.moveInQueue(started, 0, 1);
    assert.equal(swapped.position, 0, 'entry moved past the playing one shifts it');
    assert.equal(queue.moveInQueue(started, 0, -1), started);
    const jumped = queue.jumpTo(started, 2);
    assert.equal(jumped.item.Id, 'c');
    assert.equal(jumped.queue.position, 2);
    assert.equal(queue.jumpTo(started, 9), null);
});

test('the device profile direct-plays browser audio containers and transcodes music to aac then mp3', () => {
    const profile = buildDeviceProfile({ canPlay: () => true, hdrDisplay: false, audioTrackSwitching: false, userAgent: 'Mozilla/5.0 Chrome/126.0' });
    const audio = profile.DirectPlayProfiles.filter(entry => entry.Type === 'Audio');
    assert.ok(audio.some(entry => entry.AudioCodec === 'flac' && entry.Container === 'flac'));
    assert.ok(audio.some(entry => entry.AudioCodec === 'opus' && entry.Container.includes('ogg')));
    assert.ok(audio.some(entry => entry.Container === 'wav'));
    const transcodes = profile.TranscodingProfiles.filter(entry => entry.Type === 'Audio').map(entry => entry.Container);
    assert.deepEqual(transcodes, [ 'aac', 'mp3' ]);
    assert.equal(profile.MusicStreamingTranscodingBitrate, 384000);
    assert.equal(buildDeviceProfile({ canPlay: () => true, hdrDisplay: false, audioTrackSwitching: false, userAgent: 'Chrome' }, { maxBitrate: 192000, maxHeight: 0, maxAudioChannels: 0, hlsContainer: 'ts', subtitleBurnIn: 'auto', layout: 'auto' }).MusicStreamingTranscodingBitrate, 192000);
});

const { readFileSync } = await import('node:fs');
const src = name => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');

test('the app shell owns one music engine: root mount, video handoff, sign-out and account changes', () => {
    const main = src('main.tsx');
    assert.match(main, /const music = useMusicPlayer\(api\);/, 'engine attaches at the root, outside any page');
    assert.match(main, /<MiniPlayer snapshot=\{music\}/, 'mini-player is mounted by the shell');
    assert.match(main, /view === 'nowplaying' && <NowPlaying/, 'Now Playing has its own view');
    assert.match(main, /if \(isMusicTarget\(item\)\) \{\s*void musicEngine\.playItem\(item\);/, 'music plays never open the video player');
    assert.match(main, /musicEngine\.suspend\(\);\s*const result = await api\.play\(/, 'a video start suspends music first');
    assert.match(main, /playbackSessions\.retire\(\);\s*musicEngine\.stop\(\);/, 'sign-out stops music');
    assert.match(main, /useEffect\(\(\) => musicEngine\.stop\(\), \[ session\?\.server, session\?\.user\.Id \]\)/, 'account switch clears the queue');
});

test('nowplaying is a restorable route', async () => {
    const routes = await import('../src/app-routes.ts');
    assert.deepEqual(routes.routeFor({ view: 'nowplaying' }), { view: 'nowplaying' });
    assert.deepEqual(routes.routeFromState({ uiNext: { view: 'nowplaying' } }), { view: 'nowplaying' });
});

test('album rows, audio playlists and library menus feed the music queue', () => {
    const sections = src('detail-sections.tsx');
    assert.match(sections, /api\.getAlbumTracks\(item\.Id\)/, 'album pages load tracks with music fields');
    assert.match(sections, /musicEngine\.playTracks\(children\.value, children\.value\.indexOf\(track\)\)/, 'a track row plays the album from that track');
    assert.match(sections, /if \(lead && audioQueueable\(lead\)\)/, 'audio-led lists become a music queue');
    const library = src('library.tsx');
    assert.match(library, /musicEngine\.instantMix\(item\)/, 'card menu offers Instant Mix');
    assert.match(library, /isMusicTarget\(item\)\) \{\s*void \(where === 'next' \? musicEngine\.playNext\(item\) : musicEngine\.addToQueue\(item\)\)/, 'Play next and Add to queue route music to the engine');
    assert.match(src('profile.tsx'), /saveMusicSettings\(\{ crossfadeSeconds/, 'crossfade is configurable per device');
});
