import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { extname } from 'node:path';
import { beforeEach, test } from 'node:test';
import { readSource } from './source.mjs';

registerHooks({
    resolve(specifier, context, nextResolve) {
        return nextResolve(specifier.startsWith('.') && !extname(specifier) ? `${specifier}.ts` : specifier, context);
    }
});

const requestedUrls = [];
const responses = [];
beforeEach(() => {
    requestedUrls.length = 0;
    responses.length = 0;
});
globalThis.window = globalThis.window || { location: { href: 'https://host/jellyfin/web/' }, setTimeout };
globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => undefined };
if (typeof globalThis.document === 'undefined') globalThis.document = { createElement: () => ({ canPlayType: () => '' }) };
globalThis.XMLHttpRequest = class {
    open(_method, url) { this.url = url; this.responseURL = url; }
    setRequestHeader() {}
    send() {
        requestedUrls.push(this.url);
        const response = responses.shift() || { status: 200, body: JSON.stringify({ Items: [], TotalRecordCount: 0 }) };
        queueMicrotask(() => {
            this.status = response.status;
            this.responseText = response.body;
            this.onload();
        });
    }
};

const session = {
    server: 'https://host/jellyfin',
    token: 'token',
    user: { Id: 'user-id', Name: 'User' },
    serverId: 'server-id'
};
const episode = {
    Id: 'episode-2',
    Name: 'Second Episode',
    Type: 'Episode',
    SeriesId: 'series-1',
    SeriesName: 'Fixture Series',
    SeasonId: 'season-1',
    ParentIndexNumber: 1,
    IndexNumber: 2,
    UserData: { Played: false }
};

test('MISS-01 Next Up uses the server endpoint without resumable-only filtering', async () => {
    const { JellyfinApi } = await import('../src/api.ts');
    responses.push({ status: 200, body: JSON.stringify({ Items: [episode], TotalRecordCount: 1 }) });

    const items = await new JellyfinApi(session).getNextUpItems();

    assert.deepEqual(items, [episode]);
    const url = requestedUrls[0] || '';
    assert.ok(url.includes('/Shows/NextUp?'), `Next Up must use Shows/NextUp, got ${url}`);
    assert.ok(url.includes('UserId=user-id'), `Next Up must request the current user, got ${url}`);
    assert.ok(url.includes('Limit=15'), `Next Up must use the home rail limit, got ${url}`);
    assert.ok(url.includes('EnableResumable=false'), `Next Up must include shows without a resumable episode, got ${url}`);
    assert.ok(url.includes('EnableTotalRecordCount=false'), `Next Up must not request an unused total, got ${url}`);
    for (const field of ['SeriesName', 'SeriesId', 'SeasonId', 'IndexNumber', 'ParentIndexNumber', 'UserData']) {
        assert.ok(decodeURIComponent(url).includes(field), `Next Up must request ${field}, got ${url}`);
    }
});

test('MISS-01 Next Up appears after Continue watching and stays out of Explore', async () => {
    const { buildHomeFeedBlocks } = await import('../src/home-feed-blocks.ts');
    const resume = [{ Id: 'episode-1', Name: 'First Episode', Type: 'Episode' }];
    const explore = [
        { Id: 'episode-2', Name: 'Second Episode', Type: 'Episode' },
        { Id: 'movie-1', Name: 'Unrelated Movie', Type: 'Movie' }
    ];

    const blocks = buildHomeFeedBlocks(resume, [], [], [], [], [], explore, [episode]);

    assert.deepEqual(blocks.map(block => block.id), ['continue', 'next-up', 'explore-fallback']);
    const nextUp = blocks.find(block => block.id === 'next-up');
    assert.equal(nextUp?.title, 'Next up');
    assert.deepEqual(nextUp?.items, [episode]);
    const exploreBlock = blocks.find(block => block.id === 'explore-fallback');
    assert.deepEqual(exploreBlock?.items, [{ Id: 'movie-1', Name: 'Unrelated Movie', Type: 'Movie' }]);
});

test('MISS-01 an empty Next Up response leaves no rail', async () => {
    const { buildHomeFeedBlocks } = await import('../src/home-feed-blocks.ts');

    const blocks = buildHomeFeedBlocks([], [], [], [], [], [], [], []);

    assert.ok(!blocks.some(block => block.id === 'next-up'));
});

test('MISS-01 home wiring owns Next Up lifecycle and account isolation', () => {
    const source = readSource(new URL('../src/main.tsx', import.meta.url), 'utf8');

    assert.ok(source.includes('const [ nextUpItems, setNextUpItems ] = useState<MediaItem[]>([]);'));
    assert.ok(source.includes('void api.getNextUpItems()'));
    assert.ok(source.includes('setNextUpItems([]);'));
    assert.ok(source.includes('homeExploreItems, nextUpItems'));
    assert.ok(source.includes('!nextUpItems.length'));
    assert.ok(source.includes('const nextUp = await api.getNextUpItems();'));
});
