import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { extname } from 'node:path';
import { beforeEach, test } from 'node:test';

registerHooks({
    resolve(specifier, context, nextResolve) {
        return nextResolve(specifier.startsWith('.') && !extname(specifier) ? `${specifier}.ts` : specifier, context);
    }
});

const requests = [];
const responses = [];
const store = new Map();
beforeEach(() => { requests.length = 0; responses.length = 0; store.clear(); });
globalThis.window = { location: { href: 'https://jellyfin.example.test/web/', origin: 'https://jellyfin.example.test' }, setTimeout };
globalThis.localStorage = { getItem: key => store.has(key) ? store.get(key) : null, setItem: (key, value) => { store.set(key, String(value)); } };
if (typeof globalThis.document === 'undefined') globalThis.document = { createElement: () => ({ canPlayType: () => '' }) };
globalThis.XMLHttpRequest = class {
    open(method, url) { this.method = method; this.url = url; this.responseURL = url; }
    setRequestHeader() {}
    send(body) {
        requests.push({ method: this.method, url: this.url, body: body ? JSON.parse(body) : undefined });
        const response = responses.shift() || { status: 200, body: '{}' };
        queueMicrotask(() => {
            this.status = response.status;
            this.responseText = response.body;
            this.onload();
        });
    }
};
const model = await import('../src/player-model.ts');
const captions = await import('../src/caption-style.ts');
const { buildDeviceProfile, normalizePlaybackPreferences } = await import('../src/device-profile.ts');
const { JellyfinApi } = await import('../src/api.ts');
const session = { server: 'https://jellyfin.example.test', token: 'token', user: { Id: 'user-id', Name: 'Viewer' }, serverId: 'server-id' };
const source = file => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
const CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';
const everything = { canPlay: () => true, hdrDisplay: false, audioTrackSwitching: false, userAgent: CHROME };
const TICKS = 10_000_000;

test('MISS-04: alternate versions are offered and the chosen version carries to the next episode', async () => {
    const sources = [
        { Id: 'a', Name: 'Theatrical', SupportsDirectPlay: true, Container: 'mkv', MediaStreams: [ { Index: 0, Type: 'Video', Height: 1080 } ] },
        { Id: 'b', Name: "Director's Cut", SupportsDirectPlay: true, Container: 'mkv', MediaStreams: [] },
    ];
    assert.deepEqual(model.mediaVersions([ { Id: 'x', Container: 'mp4', Bitrate: 8_000_000, MediaStreams: [ { Index: 0, Type: 'Video', Height: 2160 } ] }, { Name: 'no id' } ]), [ { id: 'x', name: '2160p · MP4 · 8.0 Mbps' } ]);
    const api = new JellyfinApi(session);
    responses.push({ status: 200, body: JSON.stringify({ MediaSources: sources, PlaySessionId: 'p1' }) });
    const first = await api.play({ Id: 'ep1', SeriesId: 'show', Type: 'Episode' });
    assert.equal(first.mediaSourceId, 'a');
    assert.deepEqual(first.versions.map(version => version.name), [ 'Theatrical', "Director's Cut" ]);

    model.rememberVersion('show', "Director's Cut");
    responses.push({ status: 200, body: JSON.stringify({ MediaSources: [ { ...sources[0], Id: 'c' }, { ...sources[1], Id: 'd' } ], PlaySessionId: 'p2' }) });
    const next = await api.play({ Id: 'ep2', SeriesId: 'show', Type: 'Episode' });
    assert.equal(next.mediaSourceId, 'd');
    responses.push({ status: 200, body: JSON.stringify({ MediaSources: [ sources[0] ], PlaySessionId: 'p3' }) });
    assert.equal((await api.play({ Id: 'movie', Type: 'Movie' })).versions, undefined);
    const player = source('player.tsx');
    assert.match(player, /rememberVersion\(item\?\.SeriesId, version\.name\)/);
    assert.match(player, /renegotiate\(\{ mediaSourceId: version\.id, audioStreamIndex: undefined, subtitleStreamIndex: undefined \}/);
});

test('MISS-07: chapters are normalized, navigated and shown with image fallback', () => {
    const chapters = model.chapterList([ { StartPositionTicks: 600 * TICKS, Name: 'Middle', ImageTag: 'img' }, { StartPositionTicks: 0, Name: ' ' }, { StartPositionTicks: 5000 * TICKS, Name: 'Past end' } ], 3600);
    assert.deepEqual(chapters, [ { index: 1, name: 'Chapter 2', start: 0, imageTag: undefined }, { index: 0, name: 'Middle', start: 600, imageTag: 'img' } ]);
    assert.deepEqual(model.chapterList([ { StartPositionTicks: 0 } ]), [], 'a single chapter offers no navigation');
    assert.equal(model.currentChapterIndex(chapters, 700), 1);
    assert.equal(model.adjacentChapterStart(chapters, 10, 1), 600);
    assert.equal(model.adjacentChapterStart(chapters, 700, 1), null);
    assert.equal(model.adjacentChapterStart(chapters, 700, -1), 600);
    assert.equal(model.adjacentChapterStart(chapters, 601, -1), 0);
    const api = new JellyfinApi(session);
    assert.equal(api.chapterImageUrl('item 1', 0, 'img', 176), 'https://jellyfin.example.test/Items/item%201/Images/Chapter/0?tag=img&maxWidth=176&quality=80');
    const player = source('player.tsx');
    assert.match(player, /aria-label="Previous chapter"/);
    assert.match(player, /aria-label="Chapters"/);
    assert.match(player, /player-chapter-mark/);
    assert.match(player, /!hoverTile && hoverChapter\?\.imageTag/);
});

test('MISS-08: caption appearance, secondary captions and burn-in management', () => {
    const style = captions.normalizeCaptionStyle({ size: 'large', color: 'yellow', edge: 'box', weight: 'bold', position: 99, font: 'comic' });
    assert.deepEqual(style, { size: 'large', font: 'sans', weight: 'bold', color: 'yellow', edge: 'box', position: 8 });
    const css = captions.captionCss(style);
    assert.match(css, /\.player-video::cue \{[^}]*color: #ffe14d;[^}]*background: rgba\(0,0,0,\.78\)[^}]*font-weight: 700/);
    assert.match(css, /\.caption-preview-text \{/);
    assert.equal(captions.primaryCueLine(style), -9);
    assert.equal(captions.primaryCueLine(captions.DEFAULT_CAPTION_STYLE), 'auto');
    captions.saveCaptionStyle({ color: 'cyan' });
    assert.equal(captions.loadCaptionStyle().color, 'cyan');

    const method = (preferences, format) => buildDeviceProfile(everything, normalizePlaybackPreferences(preferences)).SubtitleProfiles.find(profile => profile.Format === format).Method;
    assert.equal(method({}, 'ass'), 'External');
    assert.equal(method({ subtitleBurnIn: 'styled' }, 'ass'), 'Encode');
    assert.equal(method({ subtitleBurnIn: 'styled' }, 'srt'), 'External');
    assert.equal(method({ subtitleBurnIn: 'all' }, 'srt'), 'Encode');
    assert.equal(method({}, 'pgssub'), 'Encode');
    assert.equal(normalizePlaybackPreferences({ subtitleBurnIn: 'bogus' }).subtitleBurnIn, 'auto');

    const player = source('player.tsx');
    assert.match(player, /label=\{SECONDARY_TRACK_LABEL\}/);
    assert.match(player, /track\.label === SECONDARY_TRACK_LABEL \? 0 : primaryLine/);
    assert.match(player, /<style>\{captionCss\(captionStyle\)\}<\/style>/);
    assert.match(source('profile.tsx'), /class="caption-preview"/);
});

test('PART-07: every segment type is recognized with per-type ask/skip/ignore and a prompt outside the OSD', () => {
    const cues = model.timelineCues([ { Type: 'Recap', StartTicks: 0, EndTicks: 30 * TICKS }, { Type: 5, StartTicks: 40 * TICKS, EndTicks: 90 * TICKS }, { Type: 'Commercial', StartTicks: 100 * TICKS, EndTicks: 160 * TICKS }, { Type: 2, StartTicks: 170 * TICKS, EndTicks: 200 * TICKS }, { Type: 'Unknown', StartTicks: 0, EndTicks: 10 * TICKS } ]);
    assert.deepEqual(cues.map(cue => [ cue.kind, cue.label ]), [ [ 'recap', 'Skip recap' ], [ 'intro', 'Skip intro' ], [ 'commercial', 'Skip commercial' ], [ 'preview', 'Skip preview' ] ]);
    assert.deepEqual(model.loadSegmentActions(), { intro: 'ask', credits: 'ask', recap: 'ask', preview: 'ask', commercial: 'ask' });
    const actions = model.saveSegmentAction('commercial', 'skip');
    model.saveSegmentAction('recap', 'ignore');
    assert.equal(model.loadSegmentActions().recap, 'ignore');
    const skipped = new Set();
    const commercial = cues[2];
    assert.equal(model.segmentDecision(commercial, actions, skipped), 'skip');
    skipped.add(model.cueKey(commercial));
    assert.equal(model.segmentDecision(commercial, actions, skipped), 'prompt', 'seeking back into a skipped segment prompts instead of skipping again');
    assert.equal(model.segmentDecision(cues[0], model.loadSegmentActions(), skipped), 'none');
    assert.equal(model.segmentDecision(null, actions, skipped), 'none');

    assert.equal(model.skipPromptVisible(40, 45, false), true);
    assert.equal(model.skipPromptVisible(40, 40 + model.SKIP_PROMPT_SECONDS, false), false);
    assert.equal(model.skipPromptVisible(40, 60, true), true);
    assert.equal(model.skipPromptVisible(null, 60, false), false);
    const player = source('player.tsx');
    assert.match(player, /!osdOpen && skipPromptShown && skip && <div class="player-skip-prompt">/);
    assert.match(player, /!osdRef\.current && !onSkipPrompt/);
    assert.match(source('profile.tsx'), /Skip automatically/);
});
