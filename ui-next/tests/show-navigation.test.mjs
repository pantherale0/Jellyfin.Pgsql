import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enterShowSeason, moveShowFocus } from '../src/show-navigation.ts';

const context = {
    seasons: [ { id: 's1', episodeIds: ['a', 'b'] }, { id: 's2', episodeIds: ['c', 'd'] } ],
    activeSeasonId: 's1', layout: 'sidebar', controls: ['art', 'title', 'play']
};
const episode = (seasonId, episodeId, control) => ({ kind: 'episode', seasonId, episodeId, control });
const season = id => ({ kind: 'season', id });

const cases = [
    ['art left returns to its season', episode('s2', 'c', 'art'), 'ArrowLeft', context, { kind: 'season', id: 's2' }],
    ['title left selects artwork', episode('s1', 'a', 'title'), 'ArrowLeft', context, { kind: 'episode', seasonId: 's1', episodeId: 'a', control: 'art' }],
    ['art right selects title in same row', episode('s1', 'b', 'art'), 'ArrowRight', context, { kind: 'episode', seasonId: 's1', episodeId: 'b', control: 'title' }],
    ['title right selects play in same row', episode('s1', 'a', 'title'), 'ArrowRight', context, { kind: 'episode', seasonId: 's1', episodeId: 'a', control: 'play' }],
    ['play left selects title', episode('s1', 'b', 'play'), 'ArrowLeft', context, { kind: 'episode', seasonId: 's1', episodeId: 'b', control: 'title' }],
    ['play right clamps', episode('s1', 'b', 'play'), 'ArrowRight', context, { kind: 'episode', seasonId: 's1', episodeId: 'b', control: 'play' }],
    ['down preserves title column', episode('s1', 'a', 'title'), 'ArrowDown', context, { kind: 'episode', seasonId: 's1', episodeId: 'b', control: 'title' }],
    ['up preserves play column', episode('s2', 'd', 'play'), 'ArrowUp', context, { kind: 'episode', seasonId: 's2', episodeId: 'c', control: 'play' }],
    ['down crosses season into first episode', episode('s1', 'b', 'play'), 'ArrowDown', context, { kind: 'episode', seasonId: 's2', episodeId: 'c', control: 'play' }],
    ['up crosses season into last episode', episode('s2', 'c', 'title'), 'ArrowUp', context, { kind: 'episode', seasonId: 's1', episodeId: 'b', control: 'title' }],
    ['overall first up reaches own season', episode('s1', 'a', 'art'), 'ArrowUp', context, { kind: 'season', id: 's1' }],
    ['overall last down clamps', episode('s2', 'd', 'title'), 'ArrowDown', context, { kind: 'episode', seasonId: 's2', episodeId: 'd', control: 'title' }],
    ['sidebar first up reaches back', season('s1'), 'ArrowUp', context, { kind: 'back' }],
    ['sidebar down changes season', season('s1'), 'ArrowDown', context, { kind: 'season', id: 's2' }],
    ['sidebar up changes season', season('s2'), 'ArrowUp', context, { kind: 'season', id: 's1' }],
    ['sidebar last down clamps', season('s2'), 'ArrowDown', context, { kind: 'season', id: 's2' }],
    ['sidebar left clamps', season('s1'), 'ArrowLeft', context, { kind: 'season', id: 's1' }],
    ['sidebar right enters own artwork', season('s2'), 'ArrowRight', context, { kind: 'episode', seasonId: 's2', episodeId: 'c', control: 'art' }],
    ['back up reaches header', { kind: 'back' }, 'ArrowUp', context, { kind: 'header' }],
    ['back down reaches active season', { kind: 'back' }, 'ArrowDown', { ...context, activeSeasonId: 's2' }, { kind: 'season', id: 's2' }],
    ['back left clamps', { kind: 'back' }, 'ArrowLeft', context, { kind: 'back' }],
    ['back right clamps', { kind: 'back' }, 'ArrowRight', context, { kind: 'back' }],
    ['header down enters back', { kind: 'header' }, 'ArrowDown', context, { kind: 'back' }],
    ['header up clamps locally', { kind: 'header' }, 'ArrowUp', context, { kind: 'header' }]
];
for (const [name, from, direction, snapshot, expected] of cases) {
    test(name, () => assert.deepEqual(moveShowFocus(from, direction, snapshot), expected));
}

const rail = { ...context, layout: 'rail', controls: ['art', 'title'] };
test('rail directions use visible navigator', () => {
    assert.deepEqual(moveShowFocus(season('s1'), 'ArrowLeft', rail), { kind: 'season', id: 's1' });
    assert.deepEqual(moveShowFocus(season('s1'), 'ArrowRight', rail), { kind: 'season', id: 's2' });
    assert.deepEqual(moveShowFocus(season('s2'), 'ArrowRight', rail), { kind: 'season', id: 's2' });
    assert.deepEqual(moveShowFocus(season('s2'), 'ArrowLeft', rail), { kind: 'season', id: 's1' });
    assert.deepEqual(moveShowFocus(season('s2'), 'ArrowUp', rail), { kind: 'back' });
    assert.deepEqual(moveShowFocus(season('s2'), 'ArrowDown', rail), { kind: 'episode', seasonId: 's2', episodeId: 'c', control: 'art' });
    assert.deepEqual(moveShowFocus(episode('s2', 'c', 'art'), 'ArrowLeft', rail), { kind: 'season', id: 's2' });
});
test('hidden play clamps right and normalizes vertical movement to title', () => {
    assert.deepEqual(moveShowFocus(episode('s1', 'a', 'title'), 'ArrowRight', rail), { kind: 'episode', seasonId: 's1', episodeId: 'a', control: 'title' });
    assert.deepEqual(moveShowFocus(episode('s1', 'a', 'play'), 'ArrowLeft', rail), { kind: 'episode', seasonId: 's1', episodeId: 'a', control: 'title' });
    assert.deepEqual(moveShowFocus(episode('s1', 'a', 'play'), 'ArrowDown', rail), { kind: 'episode', seasonId: 's1', episodeId: 'b', control: 'title' });
    assert.deepEqual(enterShowSeason(rail, 's2', 'last', 'play', 0), { kind: 'episode', seasonId: 's2', episodeId: 'd', control: 'title' });
});
test('unknown seasons return directional boundary intents', () => {
    const unknown = { ...context, seasons: [{ id: 's1', episodeIds: ['a'] }, { id: 's2', episodeIds: null }] };
    assert.deepEqual(moveShowFocus(episode('s1', 'a', 'title'), 'ArrowDown', unknown), { kind: 'boundary', seasonId: 's2', edge: 'first', control: 'title', step: 1 });
    assert.deepEqual(moveShowFocus(season('s2'), 'ArrowRight', unknown), { kind: 'boundary', seasonId: 's2', edge: 'first', control: 'art', step: 0 });
    assert.deepEqual(enterShowSeason(unknown, 's2', 'last', 'play', -1), { kind: 'boundary', seasonId: 's2', edge: 'last', control: 'play', step: -1 });
});
test('vertical crossing skips consecutive loaded empty seasons', () => {
    const empty = { ...context, seasons: [{ id: 's1', episodeIds: ['a'] }, { id: 'empty1', episodeIds: [] }, { id: 'empty2', episodeIds: [] }, { id: 's2', episodeIds: ['c'] }] };
    assert.deepEqual(moveShowFocus(episode('s1', 'a', 'play'), 'ArrowDown', empty), { kind: 'episode', seasonId: 's2', episodeId: 'c', control: 'play' });
    assert.deepEqual(moveShowFocus(episode('s2', 'c', 'title'), 'ArrowUp', empty), { kind: 'episode', seasonId: 's1', episodeId: 'a', control: 'title' });
    assert.deepEqual(enterShowSeason(empty, 'empty1', 'first', 'art', 0), { kind: 'season', id: 'empty1' });
});
test('empty seasons stop at unknown data rather than skipping it', () => {
    const mixed = { ...context, seasons: [{ id: 's1', episodeIds: ['a'] }, { id: 'empty', episodeIds: [] }, { id: 'unknown', episodeIds: null }, { id: 's2', episodeIds: ['c'] }] };
    assert.deepEqual(moveShowFocus(episode('s1', 'a', 'title'), 'ArrowDown', mixed), { kind: 'boundary', seasonId: 'unknown', edge: 'first', control: 'title', step: 1 });
    assert.deepEqual(moveShowFocus(episode('s2', 'c', 'art'), 'ArrowUp', mixed), { kind: 'boundary', seasonId: 'unknown', edge: 'last', control: 'art', step: -1 });
});
test('empty outer seasons do not change overall episode edge rules', () => {
    const edges = { ...context, seasons: [{ id: 'empty1', episodeIds: [] }, { id: 's1', episodeIds: ['a'] }, { id: 'empty2', episodeIds: [] }] };
    assert.deepEqual(moveShowFocus(episode('s1', 'a', 'title'), 'ArrowUp', edges), { kind: 'season', id: 's1' });
    assert.deepEqual(moveShowFocus(episode('s1', 'a', 'title'), 'ArrowDown', edges), { kind: 'episode', seasonId: 's1', episodeId: 'a', control: 'title' });
    assert.deepEqual(enterShowSeason(edges, 'empty2', 'first', 'title', 1), { kind: 'season', id: 'empty2' });
});
test('no seasons leaves back focus stable', () => {
    assert.deepEqual(moveShowFocus({ kind: 'back' }, 'ArrowDown', { ...context, seasons: [] }), { kind: 'back' });
});
