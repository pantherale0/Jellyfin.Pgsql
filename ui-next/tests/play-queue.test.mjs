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

const q = await import('../src/play-queue.ts');
const source = path => readSource(new URL(`../src/${path}`, import.meta.url), 'utf8');
const video = (id, extra = {}) => ({ Id: id, Name: id, Type: 'Movie', MediaType: 'Video', ...extra });
const ids = items => items.map(item => item.Id);
const seeded = (...values) => { let index = 0; return () => values[index++ % values.length]; };

test('MISS-03: only finite video titles are queueable', () => {
    assert.equal(q.queueable(video('m')), true);
    assert.equal(q.queueable(video('e', { Type: 'Episode' })), true);
    assert.equal(q.queueable({ Type: 'Audio', MediaType: 'Audio' }), false);
    assert.equal(q.queueable({ Type: 'TvChannel', MediaType: 'Video' }), false);
    assert.equal(q.queueable({ Type: 'Series' }), false);
    assert.equal(q.createQueue([ { Id: 's', Type: 'Series' } ]), null);
});

test('MISS-03: titles queued while browsing wait for the current title to end', () => {
    let queue = q.addToQueue(q.emptyQueue(), video('a'));
    queue = q.addToQueue(queue, video('b'));
    queue = q.playNext(queue, video('first'));
    assert.deepEqual(ids(q.upcoming(queue)), [ 'first', 'a', 'b' ]);
    queue = q.syncQueue(queue, video('unrelated'));
    assert.equal(queue.active, false);
    const next = q.upNext(queue, { autoplay: true, nextEpisode: null, current: video('unrelated') });
    assert.equal(next.source, 'queue');
    assert.equal(next.item.Id, 'first');
    assert.equal(q.currentItem(next.queue).Id, 'first');
    assert.deepEqual(ids(q.upcoming(q.playNext(next.queue, video('x')))), [ 'x', 'a', 'b' ]);
});

test('MISS-03: repeat modes and manual skips', () => {
    const started = q.createQueue([ video('a'), video('b') ], 1, { repeat: 'all' });
    assert.equal(started.item.Id, 'b');
    const wrapped = q.advance(started.queue);
    assert.equal(wrapped.item.Id, 'a');
    assert.equal(q.previous(wrapped.queue).item.Id, 'b');
    const once = { ...started.queue, repeat: 'off' };
    assert.equal(q.advance(once), null);
    const one = q.createQueue([ video('a'), video('b') ], 0, { repeat: 'one' }).queue;
    assert.equal(q.advance(one).item.Id, 'a');
    assert.equal(q.advance(one, true).item.Id, 'b');
    assert.deepEqual([ 'off', 'all', 'one' ].map(q.cycleRepeat), [ 'all', 'one', 'off' ]);
});

test('MISS-03: shuffle keeps played titles and can be undone around the current title', () => {
    const items = [ 'a', 'b', 'c', 'd' ].map(id => video(id));
    const started = q.createQueue(items, 1);
    const shuffled = q.toggleShuffle(started.queue, seeded(0, 0));
    assert.deepEqual(ids(shuffled.order.slice(0, 2)), [ 'a', 'b' ]);
    assert.deepEqual(ids(shuffled.order.slice(2)).sort(), [ 'c', 'd' ]);
    assert.equal(q.currentItem(shuffled).Id, 'b');
    const restored = q.toggleShuffle(shuffled);
    assert.deepEqual(ids(restored.order), [ 'a', 'b', 'c', 'd' ]);
    assert.equal(q.currentItem(restored).Id, 'b');
    const fromShuffle = q.createQueue(items, -1, { shuffle: true, random: seeded(0.99, 0) });
    assert.equal(fromShuffle.item.Id, 'd');
    assert.equal(fromShuffle.queue.order[0].Id, 'd');
    assert.equal(fromShuffle.queue.order.length, 4);
});

test('MISS-03: next-episode autoplay honours EnableNextEpisodeAutoPlay', () => {
    const episode = video('e1', { Type: 'Episode' });
    const next = video('e2', { Type: 'Episode' });
    const empty = q.emptyQueue();
    assert.equal(q.upNext(empty, { autoplay: undefined, nextEpisode: next, current: episode }).item.Id, 'e2');
    assert.equal(q.upNext(empty, { autoplay: true, nextEpisode: next, current: episode }).source, 'episode');
    assert.equal(q.upNext(empty, { autoplay: false, nextEpisode: next, current: episode }), null);
    assert.equal(q.upNext(empty, { autoplay: true, nextEpisode: null, current: episode }), null);
    assert.equal(q.upNext(empty, { autoplay: true, nextEpisode: next, current: video('movie') }), null);
});

test('MISS-03: queue store notifies subscribers and removal keeps the current title', () => {
    const store = q.createQueueStore();
    const seen = [];
    const stop = store.subscribe(queue => seen.push(queue.order.length));
    store.update(queue => q.addToQueue(queue, video('a')));
    store.update(queue => q.addToQueue(queue, { Id: 'song', Type: 'Audio', MediaType: 'Audio' }));
    stop();
    store.clear();
    assert.deepEqual(seen, [ 1 ]);
    const started = q.createQueue([ video('a'), video('b'), video('c') ], 1).queue;
    assert.deepEqual(ids(q.removeFromQueue(started, 0).order), [ 'b', 'c' ]);
    assert.equal(q.currentItem(q.removeFromQueue(started, 0)).Id, 'b');
    assert.equal(q.removeFromQueue(started, 1), started);
});

test('MISS-03: the player counts down to the next title and drives the queue', () => {
    const player = source('player.tsx');
    assert.match(player, /reporter\.stop\(false\);\s+if \(owner\.isCurrent\(session\)\) endedRef\.current\(\);/);
    assert.match(player, /upNext\(playQueue\.get\(\), \{ autoplay: api\?\.session\.user\.Configuration\?\.EnableNextEpisodeAutoPlay, nextEpisode: neighbours\.next, current: item \}\)/);
    assert.match(player, /remaining: AUTOPLAY_COUNTDOWN_SECONDS/);
    assert.match(player, /if \(upNextCard && upNextCard\.remaining <= 0\) playQueued\(upNextCard\);/);
    assert.match(player, /class="player-up-next" role="dialog" aria-label="Up next"/);
    assert.match(player, />Play now<\/button>/);
    assert.match(player, /onClick=\{\(\) => setUpNextCard\(null\)\}>Cancel<\/button>/);
    assert.match(player, /if \(upNextRef\.current\) \{\s+setUpNextCard\(null\);/, 'Back cancels the countdown before leaving the player');
    assert.match(player, /playQueue\.set\(syncQueue\(playQueue\.get\(\), item\)\);/);
    assert.match(player, /aria-label="Shuffle queue"/);
    assert.match(player, /cycleRepeat\(current\.repeat\)/);
    assert.match(source('main.tsx'), /useEffect\(\(\) => playQueue\.clear\(\), \[ session\?\.server, session\?\.user\.Id \]\);/);
});

test('MISS-03: library and details expose queue entry points', () => {
    const library = source('library.tsx');
    assert.match(library, />Play next<\/button>/);
    assert.match(library, />Add to queue<\/button>/);
    const details = source('detail-sections.tsx');
    assert.match(details, /▶ Play all/);
    assert.match(details, /playFrom\(null, true\)/);
});
