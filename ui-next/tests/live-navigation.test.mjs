import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as liveModel from '../src/live-model.ts';

const channel = channelId => ({ kind: 'channel', channelId });
const favorite = channelId => ({ kind: 'favorite', channelId });
const program = (channelId, programId, start, end) => ({ kind: 'program', channelId, programId, start, end });
const minute = 60000;
const guide = {
    channels: ['one', 'two'],
    programsByChannel: {
        one: [ program('one', 'one-a', 0, 30 * minute), program('one', 'one-b', 30 * minute, 60 * minute) ],
        two: [ program('two', 'two-a', 0, 20 * minute), program('two', 'two-b', 35 * minute, 70 * minute) ]
    },
    visibleStart: 0,
    canExtendForward: false
};

function move(from, direction, context = guide) {
    assert.equal(typeof liveModel.moveGuideFocus, 'function', 'live guide directional navigation model must exist');
    return liveModel.moveGuideFocus({ from, direction, context });
}

test('channel right enters its favorite control', () => {
    assert.deepEqual(move(channel('one'), 'ArrowRight'), { kind: 'focus', target: favorite('one') });
});

test('favorite left returns to its channel control', () => {
    assert.deepEqual(move(favorite('one'), 'ArrowLeft'), { kind: 'focus', target: channel('one') });
});

test('favorite right enters the first program', () => {
    assert.deepEqual(move(favorite('one'), 'ArrowRight'), { kind: 'focus', target: program('one', 'one-a', 0, 30 * minute) });
});

test('favorite right skips programs before the visible time', () => {
    const context = { ...guide, visibleStart: 35 * minute };
    assert.deepEqual(move(favorite('one'), 'ArrowRight', context), { kind: 'focus', target: program('one', 'one-b', 30 * minute, 60 * minute) });
});

test('first program left returns to its favorite control', () => {
    assert.deepEqual(move(program('one', 'one-a', 0, 30 * minute), 'ArrowLeft'), { kind: 'focus', target: favorite('one') });
});

test('program left and right move along the timeline', () => {
    assert.deepEqual(move(program('one', 'one-b', 30 * minute, 60 * minute), 'ArrowLeft'), { kind: 'focus', target: program('one', 'one-a', 0, 30 * minute) });
    assert.deepEqual(move(program('one', 'one-a', 0, 30 * minute), 'ArrowRight'), { kind: 'focus', target: program('one', 'one-b', 30 * minute, 60 * minute) });
});

test('channel left exits the guide toward the filter', () => {
    assert.deepEqual(move(channel('one'), 'ArrowLeft'), { kind: 'toolbar', control: 'filter' });
});

test('program edges keep focus stable instead of panning an empty row', () => {
    const scrollable = { ...guide, canExtendForward: false };
    assert.deepEqual(move(program('one', 'one-a', 0, 30 * minute), 'ArrowLeft', scrollable), { kind: 'focus', target: favorite('one') });
    assert.deepEqual(move(program('one', 'one-b', 30 * minute, 60 * minute), 'ArrowRight', scrollable), { kind: 'clamp' });
});

test('the last loaded program requests another time chunk without shifting the guide', () => {
    const more = { ...guide, canExtendForward: true };
    assert.deepEqual(move(program('one', 'one-b', 30 * minute, 60 * minute), 'ArrowRight', more), { kind: 'extend', direction: 'forward', channelId: 'one', time: 60 * minute });
});

test('channel and favorite edges clamp when there is nowhere to move', () => {
    assert.deepEqual(move(program('one', 'one-b', 30 * minute, 60 * minute), 'ArrowRight'), { kind: 'clamp' });
    assert.deepEqual(move(channel('two'), 'ArrowDown'), { kind: 'clamp' });
    assert.deepEqual(move(favorite('one'), 'ArrowUp'), { kind: 'clamp' });
});

test('vertical channel movement preserves channel and favorite roles', () => {
    assert.deepEqual(move(channel('one'), 'ArrowDown'), { kind: 'focus', target: channel('two') });
    assert.deepEqual(move(favorite('one'), 'ArrowDown'), { kind: 'focus', target: favorite('two') });
});

test('vertical program movement aligns by time and falls back to channel when empty', () => {
    assert.deepEqual(move(program('one', 'one-b', 30 * minute, 60 * minute), 'ArrowDown'), { kind: 'focus', target: program('two', 'two-b', 35 * minute, 70 * minute) });
    const noLaterProgram = { ...guide, programsByChannel: { ...guide.programsByChannel, two: [program('two', 'two-a', 0, 20 * minute)] } };
    assert.deepEqual(move(program('one', 'one-b', 30 * minute, 60 * minute), 'ArrowDown', noLaterProgram), { kind: 'focus', target: channel('two') });
});

test('directional modal focus selects the nearest candidate and reports a trapped edge', () => {
    assert.equal(typeof liveModel.directionalFocusIndex, 'function', 'modal directional focus helper must exist');
    const rects = [
        { left: 0, top: 0, width: 40, height: 40 },
        { left: 50, top: 0, width: 40, height: 40 },
        { left: 0, top: 50, width: 40, height: 40 },
        { left: 50, top: 50, width: 40, height: 40 }
    ];
    assert.equal(liveModel.directionalFocusIndex(rects, 0, 'ArrowRight'), 1);
    assert.equal(liveModel.directionalFocusIndex(rects, 0, 'ArrowDown'), 2);
    assert.equal(liveModel.directionalFocusIndex(rects, 0, 'ArrowLeft'), null);
});

function moveToolbar(from, direction, dayCount = 3) {
    assert.equal(typeof liveModel.moveGuideToolbar, 'function', 'guide toolbar navigation model must exist');
    return liveModel.moveGuideToolbar({ from, direction, dayCount });
}

test('guide day controls stay together and the last day enters the filter', () => {
    assert.deepEqual(moveToolbar({ kind: 'day', index: 0 }, 'ArrowRight'), { kind: 'focus', target: { kind: 'day', index: 1 } });
    assert.deepEqual(moveToolbar({ kind: 'day', index: 2 }, 'ArrowRight'), { kind: 'focus', target: { kind: 'filter' } });
    assert.deepEqual(moveToolbar({ kind: 'day', index: 0 }, 'ArrowLeft'), { kind: 'clamp' });
});

test('guide toolbar connects to tabs and channels without geometric jumps', () => {
    assert.deepEqual(moveToolbar({ kind: 'day', index: 1 }, 'ArrowUp'), { kind: 'tabs' });
    assert.deepEqual(moveToolbar({ kind: 'day', index: 1 }, 'ArrowDown'), { kind: 'channels' });
    assert.deepEqual(moveToolbar({ kind: 'filter' }, 'ArrowLeft'), { kind: 'focus', target: { kind: 'day', index: 2 } });
    assert.deepEqual(moveToolbar({ kind: 'filter' }, 'ArrowRight'), { kind: 'clamp' });
});

test('guide filter keeps native up and down option selection', () => {
    assert.deepEqual(moveToolbar({ kind: 'filter' }, 'ArrowUp'), { kind: 'native' });
    assert.deepEqual(moveToolbar({ kind: 'filter' }, 'ArrowDown'), { kind: 'native' });
});
