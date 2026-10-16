import assert from 'node:assert/strict';
import { test } from 'node:test';

const fixtures = await import('./fixtures.mjs').catch(() => ({}));

test('fixture state contains Jellyfin-shaped user, library and WebM playback data', () => {
    assert.equal(typeof fixtures.createFixtureState, 'function', 'createFixtureState must be exported');
    if (typeof fixtures.createFixtureState !== 'function') return;

    const state = fixtures.createFixtureState();
    assert.equal(state.serverInfo.Id, 'e2e-server-id');
    assert.equal(state.user.Id, 'e2e-user-id');
    assert.equal(state.user.Name, 'E2E User');
    assert.deepEqual(state.views.map(view => [ view.Id, view.CollectionType ]), [
        [ 'e2e-movies-library', 'movies' ],
        [ 'e2e-shows-library', 'tvshows' ]
    ]);

    const movie = state.items.find(item => item.Id === 'e2e-movie-1');
    assert.equal(movie.Type, 'Movie');
    assert.equal(movie.MediaType, 'Video');
    assert.equal(movie.Name, 'E2E Movie One');
    assert.equal(movie.RunTimeTicks, 300_000_000);

    const source = state.playbackInfo.MediaSources[0];
    assert.equal(state.playbackInfo.PlaySessionId, 'e2e-play-session');
    assert.equal(source.Container, 'webm');
    assert.equal(source.SupportsDirectPlay, true);
    assert.deepEqual(source.MediaStreams.map(stream => [ stream.Type, stream.Codec ]), [
        [ 'Video', 'vp8' ],
        [ 'Audio', 'opus' ]
    ]);
});

test('fixture state includes six movies and a two-season show for TV focus paths', () => {
    assert.equal(typeof fixtures.createFixtureState, 'function', 'createFixtureState must be exported');
    if (typeof fixtures.createFixtureState !== 'function') return;

    const state = fixtures.createFixtureState();
    assert.deepEqual(state.items.filter(item => item.Type === 'Movie').map(item => item.Id), [
        'e2e-movie-1', 'e2e-movie-2', 'e2e-movie-3', 'e2e-movie-4', 'e2e-movie-5', 'e2e-movie-6'
    ]);
    assert.deepEqual(state.items.filter(item => item.Type === 'Season').map(season => [ season.Id, season.IndexNumber, season.ChildCount ]), [
        [ 'e2e-season-1', 1, 2 ],
        [ 'e2e-season-2', 2, 1 ]
    ]);
    assert.deepEqual(state.items.filter(item => item.Type === 'Episode').map(entry => [ entry.Id, entry.ParentId, entry.IndexNumber ]), [
        [ 'e2e-episode-1', 'e2e-season-1', 1 ],
        [ 'e2e-episode-2', 'e2e-season-1', 2 ],
        [ 'e2e-episode-3', 'e2e-season-2', 1 ]
    ]);
    assert.deepEqual(state.nextUpItems.map(item => item.Id), [ 'e2e-episode-1' ]);
});

test('each fixture state is independent', () => {
    assert.equal(typeof fixtures.createFixtureState, 'function', 'createFixtureState must be exported');
    if (typeof fixtures.createFixtureState !== 'function') return;

    const first = fixtures.createFixtureState();
    const second = fixtures.createFixtureState();
    first.user.Name = 'Changed User';
    first.views[0].Name = 'Changed Library';
    first.items[0].Name = 'Changed Item';
    first.playbackInfo.MediaSources[0].Name = 'Changed Source';

    assert.equal(second.user.Name, 'E2E User');
    assert.equal(second.views[0].Name, 'Movies');
    assert.equal(second.items[0].Name, 'E2E Movie One');
    assert.equal(second.playbackInfo.MediaSources[0].Name, 'E2E WebM');
});
