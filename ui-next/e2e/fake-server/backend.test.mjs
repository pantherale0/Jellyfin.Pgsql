import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFixtureState, FIXTURE_CREDENTIALS } from './fixtures.mjs';

const backendModule = await import('./backend.mjs').catch(() => ({}));
const { accessToken, password, username } = FIXTURE_CREDENTIALS;
const auth = token => `MediaBrowser Token="${token}"`;
const jsonRequest = (path, body, { method = 'POST', token = accessToken } = {}) => new Request(`http://127.0.0.1${path}`, {
    method,
    headers: {
        'Authorization': auth(token),
        'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
});

function requireBackend() {
    assert.equal(typeof backendModule.createFakeBackend, 'function', 'createFakeBackend must be exported');
    return backendModule.createFakeBackend();
}

test('login returns the fixture identity and bad credentials return 401', async () => {
    const backend = requireBackend();

    const login = await backend.handle(jsonRequest('/Users/AuthenticateByName', { Username: username, Pw: password }, { token: '' }));
    assert.equal(login.status, 200);
    assert.deepEqual(await login.json(), {
        AccessToken: accessToken,
        User: createFixtureState().user,
        ServerId: FIXTURE_CREDENTIALS.serverId
    });

    const rejected = await backend.handle(jsonRequest('/Users/AuthenticateByName', { Username: username, Pw: 'wrong-password' }, { token: '' }));
    assert.equal(rejected.status, 401);
});

test('Quick Connect availability is disabled for the fake server without authentication', async () => {
    const backend = requireBackend();
    const response = await backend.handle(new Request('http://127.0.0.1/QuickConnect/Enabled'));
    assert.equal(response.status, 200);
    assert.equal(await response.json(), false);
    assert.equal(backend.getRequests()[0].unexpected, false);
});

test('Live TV airing-program probe returns an empty Jellyfin item page', async () => {
    const backend = requireBackend();
    const response = await backend.handle(new Request('http://127.0.0.1/LiveTv/Programs?IsAiring=true', {
        headers: { Authorization: auth(accessToken) }
    }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { Items: [], TotalRecordCount: 0 });
    assert.equal(backend.getRequests()[0].unexpected, false);
});

test('authenticated user and discovery routes return Jellyfin response shapes', async () => {
    const backend = requireBackend();

    const user = await backend.handle(new Request('http://127.0.0.1/Users/Me', { headers: { Authorization: auth(accessToken) } }));
    assert.deepEqual(await user.json(), createFixtureState().user);

    const views = await backend.handle(new Request('http://127.0.0.1/UserViews?UserId=e2e-user-id', { headers: { Authorization: auth(accessToken) } }));
    assert.deepEqual(await views.json(), { Items: createFixtureState().views, TotalRecordCount: 2 });

    const resume = await backend.handle(new Request('http://127.0.0.1/UserItems/Resume?MediaTypes=Video', { headers: { Authorization: auth(accessToken) } }));
    assert.deepEqual((await resume.json()).Items.map(item => item.Id), [ 'e2e-movie-1' ]);

    const latest = await backend.handle(new Request('http://127.0.0.1/Items/Latest', { headers: { Authorization: auth(accessToken) } }));
    assert.deepEqual((await latest.json()).map(item => item.Id), [ 'e2e-movie-1', 'e2e-movie-2', 'e2e-movie-3' ]);

    const nextUp = await backend.handle(new Request('http://127.0.0.1/Shows/NextUp', { headers: { Authorization: auth(accessToken) } }));
    assert.deepEqual((await nextUp.json()).Items.map(item => item.Id), [ 'e2e-episode-1' ]);
});

test('item queries and playback negotiation return deterministic direct-play data', async () => {
    const backend = requireBackend();

    const library = await backend.handle(new Request('http://127.0.0.1/Items?ParentId=e2e-movies-library&Limit=1', { headers: { Authorization: auth(accessToken) } }));
    assert.deepEqual(await library.json(), {
        Items: [ createFixtureState().items[0] ],
        TotalRecordCount: 6
    });

    const detail = await backend.handle(new Request('http://127.0.0.1/Items/e2e-movie-1', { headers: { Authorization: auth(accessToken) } }));
    assert.equal((await detail.json()).Name, 'E2E Movie One');

    const playbackInfo = await backend.handle(jsonRequest('/Items/e2e-movie-1/PlaybackInfo', { UserId: 'e2e-user-id', IsPlayback: true }));
    const playback = await playbackInfo.json();
    assert.equal(playback.PlaySessionId, 'e2e-play-session');
    assert.equal(playback.MediaSources[0].SupportsDirectPlay, true);
    assert.equal(playback.MediaSources[0].Container, 'webm');
});

test('library filters and item detail side requests return stable Jellyfin pages', async () => {
    const backend = requireBackend();
    const headers = { Authorization: auth(accessToken) };

    const filters = await backend.handle(new Request('http://127.0.0.1/Items/Filters?ParentId=e2e-movies-library', { headers }));
    assert.deepEqual(await filters.json(), { Tags: [], OfficialRatings: [] });

    const detail = await backend.handle(new Request('http://127.0.0.1/Users/e2e-user-id/Items/e2e-movie-1?Fields=Overview', { headers }));
    assert.equal((await detail.json()).Overview, 'A deterministic movie for browser playback tests.');

    for (const path of [ '/Items/e2e-movie-1/Similar', '/Items/e2e-movie-1/Collections' ]) {
        const response = await backend.handle(new Request(`http://127.0.0.1${path}`, { headers }));
        assert.deepEqual(await response.json(), { Items: [], TotalRecordCount: 0 });
        assert.equal(backend.getRequests().at(-1).unexpected, false);
    }
});

test('media segment lookup returns an empty page for fixture items', async () => {
    const backend = requireBackend();
    const response = await backend.handle(new Request('http://127.0.0.1/MediaSegments/e2e-movie-1', {
        headers: { Authorization: auth(accessToken) }
    }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { Items: [] });
    assert.equal(backend.getRequests()[0].unexpected, false);
});

test('reports are recorded in order and request logs redact credentials and API keys', async () => {
    const backend = requireBackend();
    const report = { ItemId: 'e2e-movie-1', PositionTicks: 20_000_000, Pw: password, AccessToken: accessToken };

    for (const [ path, expectedStatus ] of [
        [ '/Sessions/Playing', 204 ],
        [ '/Sessions/Playing/Progress', 204 ],
        [ '/Sessions/Playing/Stopped?ApiKey=secret-query-token', 204 ]
    ]) {
        const response = await backend.handle(jsonRequest(path, report));
        assert.equal(response.status, expectedStatus);
    }

    const requests = backend.getRequests();
    assert.deepEqual(requests.map(request => request.path), [ '/Sessions/Playing', '/Sessions/Playing/Progress', '/Sessions/Playing/Stopped' ]);
    assert.deepEqual(requests.map(request => request.status), [ 204, 204, 204 ]);
    assert.equal(requests[0].authorizationPresent, true);
    assert.equal(requests[0].body.Pw, '[redacted]');
    assert.equal(requests[0].body.AccessToken, '[redacted]');
    assert.equal(requests[2].query.ApiKey, '[redacted]');
    assert.equal(JSON.stringify(requests).includes(password), false);
    assert.equal(JSON.stringify(requests).includes(accessToken), false);
    assert.equal(JSON.stringify(requests).includes('secret-query-token'), false);
});

test('invalid tokens, malformed JSON, oversized JSON, and unknown routes fail safely', async () => {
    const backend = requireBackend();

    const invalidToken = await backend.handle(new Request('http://127.0.0.1/Users/Me', { headers: { Authorization: auth('wrong-token') } }));
    assert.equal(invalidToken.status, 401);

    const malformed = await backend.handle(new Request('http://127.0.0.1/Users/AuthenticateByName', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{'
    }));
    assert.equal(malformed.status, 400);

    const oversized = await backend.handle(new Request('http://127.0.0.1/Users/AuthenticateByName', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: `{"Username":"${'x'.repeat(1_048_577)}"}`
    }));
    assert.equal(oversized.status, 413);

    const unknown = await backend.handle(new Request('http://127.0.0.1/NotARealJellyfinEndpoint', { headers: { Authorization: auth(accessToken) } }));
    assert.equal(unknown.status, 404);
    assert.equal(backend.getRequests().at(-1).path, '/NotARealJellyfinEndpoint');
});

test('show seasons and episodes routes return the fixture catalog for a series', async () => {
    const backend = requireBackend();
    const headers = { Authorization: auth(accessToken) };

    const seasons = await backend.handle(new Request('http://127.0.0.1/Shows/e2e-series-1/Seasons?UserId=e2e-user-id', { headers }));
    const seasonBody = await seasons.json();
    assert.deepEqual(seasonBody.Items.map(season => season.Id), [ 'e2e-season-1', 'e2e-season-2' ]);
    assert.equal(seasonBody.TotalRecordCount, 2);

    const episodes = await backend.handle(new Request('http://127.0.0.1/Shows/e2e-series-1/Episodes?UserId=e2e-user-id&SeasonId=e2e-season-1&SortBy=IndexNumber', { headers }));
    const episodeBody = await episodes.json();
    assert.deepEqual(episodeBody.Items.map(entry => entry.Id), [ 'e2e-episode-1', 'e2e-episode-2' ]);
    assert.equal(episodeBody.TotalRecordCount, 2);
    assert.equal(backend.getRequests().every(request => request.unexpected === false), true);
});

test('reset clears request history and recreates the fixture state', async () => {
    const backend = requireBackend();

    await backend.handle(new Request('http://127.0.0.1/System/Info/Public'));
    assert.equal(backend.getRequests().length, 1);
    backend.reset();
    assert.deepEqual(backend.getRequests(), []);

    const info = await backend.handle(new Request('http://127.0.0.1/System/Info/Public'));
    assert.equal((await info.json()).ServerName, 'UI Next E2E');
});
