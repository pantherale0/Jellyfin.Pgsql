import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { extname } from 'node:path';
import { test } from 'node:test';

registerHooks({
    resolve(specifier, context, nextResolve) {
        return nextResolve(specifier.startsWith('.') && !extname(specifier) ? `${specifier}.ts` : specifier, context);
    }
});

test('UX-13 cards describe kind, context, and resume state for assistive technology', async () => {
    const { describeCard, mediaKind } = await import('../src/media-labels.ts');
    assert.equal(typeof mediaKind, 'function', 'kind model must be shared, not copied per card');
    assert.equal(describeCard({ Id: 'm', Name: 'Movie', Type: 'Movie', ProductionYear: 2026 }), 'Movie · 2026');
    assert.equal(
        describeCard({ Id: 'e', Name: 'Ep', Type: 'Episode', SeriesName: 'Show', ParentIndexNumber: 1, IndexNumber: 2 }),
        'S01E02 · Show'
    );
    const liveStart = new Date(Date.now() - 10 * 60000).toISOString();
    const liveEnd = new Date(Date.now() + 50 * 60000).toISOString();
    assert.equal(
        describeCard({ Id: 'p', Name: 'Match', Type: 'Program', ChannelName: 'One', IsLive: true, StartDate: liveStart, EndDate: liveEnd }),
        'Live · One'
    );
    assert.equal(
        describeCard({ Id: 'm', Name: 'Movie', Type: 'Movie', UserData: { PlayedPercentage: 45 } }),
        'Movie · Resume 45 percent'
    );
    assert.equal(describeCard({ Id: 'x', Name: 'Plain' }), null);
});

test('CAT-09 leftover spotlights append after the rails instead of disappearing', async () => {
    const { buildHomeFeedBlocks } = await import('../src/home-feed-blocks.ts');
    const old = { Id: 'old', Name: 'Old Gem', Type: 'Movie', CommunityRating: 9, DateCreated: '2019-01-01T00:00:00.000Z', UserData: { Played: false } };
    const blocks = buildHomeFeedBlocks([], [{ Id: 'latest', Name: 'New', Type: 'Movie' }], [], [], [], [old]);
    const kinds = blocks.map(block => `${block.kind}:${block.id}`);
    assert.deepEqual(kinds, ['rail:latest', 'spotlight:vault-old']);
    const two = buildHomeFeedBlocks([], [{ Id: 'latest', Name: 'New', Type: 'Movie' }], [], [{ Id: 'box', Name: 'Box', Type: 'BoxSet', ChildCount: 3 }], [], [old]);
    assert.deepEqual(two.map(block => block.id), ['latest', 'collection-box', 'vault-old']);
});
