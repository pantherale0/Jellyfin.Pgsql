import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { extname } from 'node:path';
import { beforeEach, test } from 'node:test';

registerHooks({
    resolve(specifier, context, nextResolve) {
        return nextResolve(specifier.startsWith('.') && !extname(specifier) ? `${specifier}.ts` : specifier, context);
    }
});

process.env.TZ = 'America/New_York';

const requests = [];
const responses = [];
beforeEach(() => { requests.length = 0; responses.length = 0; });
globalThis.window = { location: { href: 'https://jellyfin.example.test/web/' }, setTimeout };
globalThis.localStorage = { getItem: () => null, setItem: () => undefined };
if (typeof globalThis.document === 'undefined') globalThis.document = { createElement: () => ({ canPlayType: () => '' }) };
globalThis.XMLHttpRequest = class {
    open(_method, url) { this.url = url; this.responseURL = url; }
    setRequestHeader() {}
    send() {
        requests.push(this.url);
        const response = responses.shift() || { status: 200, body: JSON.stringify({ Items: [], TotalRecordCount: 0 }) };
        queueMicrotask(() => {
            this.status = response.status;
            this.responseText = response.body;
            this.onload();
        });
    }
};

const { JellyfinApi } = await import('../src/api.ts');
const session = { server: 'https://jellyfin.example.test', token: 'token', user: { Id: 'user-id', Name: 'Admin' }, serverId: 'server-id' };

test('LIVE-02 cached current program is validated against its broadcast dates', async () => {
    const { currentProgramFor } = await import('../src/live-model.ts');
    assert.equal(typeof currentProgramFor, 'function', 'current-program selection must be testable');
    const now = Date.parse('2026-10-14T22:15:00.000Z');
    const live = { Id: 'p1', ChannelId: 'c', StartDate: '2026-10-14T22:00:00.000Z', EndDate: '2026-10-14T23:00:00.000Z' };
    const channel = { Id: 'c', Name: 'C', CurrentProgram: { ...live, Name: 'Cached' } };
    assert.equal(currentProgramFor(channel, { c: [{ ...live, Id: 'p2', Name: 'Guide' }] }, now)?.Id, 'p1');
    const stale = { ...channel, CurrentProgram: { ...live, Name: 'Ended', StartDate: '2026-10-14T20:00:00.000Z', EndDate: '2026-10-14T21:00:00.000Z' } };
    assert.equal(currentProgramFor(stale, { c: [{ ...live, Id: 'p2', Name: 'Guide' }] }, now)?.Id, 'p2');
    assert.equal(currentProgramFor({ Id: 'c', Name: 'C' }, {}, now), undefined);
});

test('LIVE-03 On Now and DVR lists page beyond their first requests', async () => {
    const api = new JellyfinApi(session);
    await api.getAiringPrograms(80, 80);
    assert.ok(requests[0].includes('StartIndex=80'), `On Now continuation must page, got ${requests[0]}`);
    assert.ok(requests[0].includes('EnableTotalRecordCount=true'), `On Now must retain totals, got ${requests[0]}`);
    await api.getRecordings(40, 40);
    assert.ok(requests[1].includes('StartIndex=40'), `DVR continuation must page, got ${requests[1]}`);
});

test('LIVE-04 guide days step by calendar date across daylight saving', async () => {
    const { addLocalDays, startOfLocalDay } = await import('../src/live-model.ts');
    assert.equal(typeof addLocalDays, 'function', 'calendar stepping must exist');
    const noon = new Date(2026, 9, 31, 12, 0, 0).getTime();
    const plusTwo = new Date(addLocalDays(startOfLocalDay(noon), 2));
    assert.equal(plusTwo.getHours(), 0);
    assert.equal(plusTwo.getDate(), 2);
});
