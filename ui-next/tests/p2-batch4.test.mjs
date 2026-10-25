import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { extname } from 'node:path';
import { beforeEach, test } from 'node:test';

registerHooks({
    resolve(specifier, context, nextResolve) {
        return nextResolve(specifier.startsWith('.') && !extname(specifier) ? `${specifier}.ts` : specifier, context);
    }
});

let failOpen = false;
const requests = [];
const responses = [];
beforeEach(() => { requests.length = 0; responses.length = 0; failOpen = false; });
globalThis.window = { location: { href: 'https://jellyfin.example.test/web/' }, setTimeout };
globalThis.localStorage = { getItem: () => null, setItem: () => undefined };
if (typeof globalThis.document === 'undefined') globalThis.document = { createElement: () => ({ canPlayType: () => '' }) };
globalThis.XMLHttpRequest = class {
    open(_method, url) {
        if (failOpen) throw new Error('engine cannot open requests');
        this.url = url; this.responseURL = url;
    }
    setRequestHeader() {}
    send() {
        requests.push(this.url);
        const response = responses.shift() || { status: 200, body: '{}' };
        queueMicrotask(() => {
            this.status = response.status;
            this.responseText = response.body;
            this.onload();
        });
    }
};

test('CAT-12 sort options name the actual rating field and offer both ratings', async () => {
    const { librarySortOptions } = await import('../src/library-query.ts');
    assert.ok(Array.isArray(librarySortOptions), 'sort options must live in one shared list');
    const labels = librarySortOptions.map(([, label]) => label);
    assert.ok(!labels.includes('Sort: Rating (high-low)'), 'the ambiguous rating label must be gone');
    assert.ok(labels.includes('Sort: Critic rating (high-low)'));
    assert.ok(labels.includes('Sort: Community rating (high-low)'));
    const values = librarySortOptions.map(([value]) => value);
    assert.ok(values.includes('CommunityRating:Descending'));
});

test('UX-19 script scrolling follows the reduced-motion preference', async () => {
    const { preferredScrollBehavior } = await import('../src/live-model.ts');
    assert.equal(typeof preferredScrollBehavior, 'function', 'scroll behavior must come from one helper');
    delete globalThis.window.matchMedia;
    assert.equal(preferredScrollBehavior(), 'smooth');
    globalThis.window.matchMedia = query => ({ matches: query === '(prefers-reduced-motion: reduce)', media: query });
    assert.equal(preferredScrollBehavior(), 'auto');
    delete globalThis.window.matchMedia;
});

test('ENG-02 image setup failure settles the job and frees the scheduler slot', async () => {
    const { JellyfinApi } = await import('../src/api.ts');
    const session = { server: 'https://jellyfin.example.test', token: 'token', user: { Id: 'user-id', Name: 'Admin' }, serverId: 'server-id' };
    const api = new JellyfinApi(session);
    const item = { Id: 'item', Name: 'Item', ImageTags: { Primary: 'tag' } };
    failOpen = true;
    const image = await Promise.race([
        api.loadImage(item),
        new Promise(resolve => setTimeout(() => resolve('unsettled'), 2000))
    ]);
    assert.equal(image, '', 'a failed image setup must settle the job');
    failOpen = false;
    responses.push({ status: 200, body: JSON.stringify({ Items: [], TotalRecordCount: 0 }) });
    await api.getViews();
    assert.ok(requests.some(url => url.includes('/UserViews')), 'later requests must proceed after the image failure');
});

test('ENG-05 malformed query encoding cannot prevent startup parsing', async () => {
    const { queryParameter } = await import('../src/query-params.ts');
    assert.equal(typeof queryParameter, 'function', 'query parsing must live in a tolerant helper');
    assert.equal(queryParameter('?good=value', 'good'), 'value');
    assert.equal(queryParameter('?bad=%E0%A4%A', 'bad'), '%E0%A4%A');
    assert.equal(queryParameter('?bad=%E0%A4%A', 'missing'), null);
});
