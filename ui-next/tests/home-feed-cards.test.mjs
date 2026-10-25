import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { extname } from 'node:path';
import { test } from 'node:test';
import { readSource } from './source.mjs';

registerHooks({
    resolve(specifier, context, nextResolve) {
        return nextResolve(specifier.startsWith('.') && !extname(specifier) ? `${specifier}.ts` : specifier, context);
    }
});

const source = file => readSource(new URL(`../src/${file}`, import.meta.url), 'utf8');

test('home feed cards: shape per rail, posters for movies, guide-first labels, time left', async () => {
    const { homeCardHeading, homeCardSubheading, resumeMinutesLeft, homeRailShape } = await import('../src/media-labels.ts');

    assert.equal(homeCardHeading({ Id: 'e', Name: 'Rise of the Turtles (1)', Type: 'Episode', SeriesName: 'Teenage Mutant Ninja Turtles' }), 'Teenage Mutant Ninja Turtles', 'episode cards lead with the series name');
    assert.equal(homeCardHeading({ Id: 'm', Name: 'Leo', Type: 'Movie' }), 'Leo');
    assert.equal(homeCardHeading({ Id: 'e', Name: 'Pilot', Type: 'Episode' }), 'Pilot', 'episodes without a series name keep their own title');

    assert.equal(homeCardSubheading({ Name: 'Rise of the Turtles (1)', Type: 'Episode', ParentIndexNumber: 1, IndexNumber: 1 }), 'S01E01 · Rise of the Turtles (1)');
    assert.equal(homeCardSubheading({ Name: 'Leo', Type: 'Movie', ProductionYear: 2023 }), '2023');
    assert.equal(homeCardSubheading({ Name: 'Mystery', Type: 'Movie' }), '');

    const hour = 36000000000;
    assert.equal(resumeMinutesLeft({ Id: 'x', RunTimeTicks: hour, UserData: { PlaybackPositionTicks: hour / 4 } }), 45);
    assert.equal(resumeMinutesLeft({ Id: 'x', RunTimeTicks: hour, UserData: { PlayedPercentage: 25 } }), 45, 'percentage derives the position when raw ticks are missing');
    assert.equal(resumeMinutesLeft({ Id: 'x', UserData: { PlayedPercentage: 25 } }), null, 'without a runtime there is nothing to subtract from');
    assert.equal(resumeMinutesLeft({ Id: 'x', RunTimeTicks: hour, UserData: {} }), null, 'unwatched items show no remaining time');
    assert.equal(resumeMinutesLeft({ Id: 'x', RunTimeTicks: hour, UserData: { PlayedPercentage: 100 } }), null, 'finished items show no remaining time');

    const episode = { Id: 'e', Name: 'Pilot', Type: 'Episode', SeriesName: 'Show' };
    const live = { Id: 'l', Name: 'News', Type: 'Program', ChannelId: 'c', IsLive: true };
    const movie = { Id: 'm', Name: 'Leo', Type: 'Movie' };
    assert.equal(homeRailShape([ episode, episode ]), 'landscape', 'all-TV rows use 16:9 thumb cards');
    assert.equal(homeRailShape([ live, live ]), 'landscape', 'live rows keep their wide cards');
    assert.equal(homeRailShape([ episode, movie ]), 'poster', 'a row with a movie stays all-poster');
    assert.equal(homeRailShape([ movie ]), 'poster');
    assert.equal(homeRailShape([]), 'poster');

    const feed = source('home-feed.tsx');
    assert.match(feed, /homeRailShape\(block\.items\)/, 'the rail decides the shape, so a row never mixes');
    assert.match(feed, /shape=\{homeRailShape\(block\.items\)\}/);
    assert.match(feed, /seriesArt\(/, 'poster rows show episodes with the series cover art');
    assert.match(feed, /shape === 'landscape'/);
    assert.doesNotMatch(feed, /: 'poster';\s*const src/, 'shape comes from the rail prop, not per item');
    assert.match(feed, /min left/);

    const css = source('style.css');
    assert.match(css, /\.home-feed-card-art \{[^}]*aspect-ratio: 2 \/ 3/);
    assert.match(css, /\.home-feed-card\.landscape \.home-feed-card-art \{ aspect-ratio: 16 \/ 9; \}/);

    const api = source('api.ts');
    assert.match(api, /getResumeItems[\s\S]{0,500}RunTimeTicks/, 'resume items carry the runtime for time-left labels');
    assert.match(api, /seriesArt\(item[\s\S]{0,300}SeriesId/, 'series art is addressed through the series id');
    assert.match(api, /getLatestItems[\s\S]{0,500}SeriesId/, 'latest media carries series ids for poster episodes');
});
