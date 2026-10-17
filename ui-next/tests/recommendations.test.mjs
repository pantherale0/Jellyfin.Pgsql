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

const { composeExploreTopics, composeRecommendationTopics, explorePicksFromProfile, flattenRecommendationTopics, isRecentRelease, normalizeRecommendationType, recommendationTitle, RELEASE_WINDOW_DAYS, MAX_TOPICS_PER_FAMILY } = await import('../src/recommendations.ts');
const { buildHomeFeedBlocks } = await import('../src/home-feed-blocks.ts');
const { sectionOfRail } = await import('../src/discovery.ts');
const source = file => readSource(new URL(`../src/${file}`, import.meta.url), 'utf8');

const movie = id => ({ Id: id, Name: id, Type: 'Movie' });
const year = days => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

test('recommendations: Jellyfin enum names normalize to the numeric codes the client ranks on', () => {
    assert.equal(normalizeRecommendationType('SimilarToRecentlyPlayed'), 0);
    assert.equal(normalizeRecommendationType('SimilarToLikedItem'), 1);
    assert.equal(normalizeRecommendationType('HasDirectorFromRecentlyPlayed'), 2);
    assert.equal(normalizeRecommendationType('HasActorFromRecentlyPlayed'), 3);
    assert.equal(normalizeRecommendationType('HasLikedDirector'), 4);
    assert.equal(normalizeRecommendationType('HasLikedActor'), 5);
    assert.equal(normalizeRecommendationType(3), 3, 'numeric values pass through for older profiles');
    assert.equal(normalizeRecommendationType('3'), 3);
    assert.equal(normalizeRecommendationType('Bogus'), -1);
    assert.equal(normalizeRecommendationType(undefined), -1);

    const api = source('api.ts');
    assert.match(api, /categoryLimit: 12/, 'a wider candidate pool feeds the rotation');
    assert.match(api, /normalizeRecommendationType\(value\.RecommendationType\)/);
});

test('recommendations: baselines split watched vs rewatched and liked vs favorited wording', () => {
    assert.equal(recommendationTitle({ RecommendationType: 0, BaselineItemName: 'Coco' }, { PlayCount: 1 }), 'Because you watched Coco');
    assert.equal(recommendationTitle({ RecommendationType: 0, BaselineItemName: 'Coco' }, { PlayCount: 3 }), 'Because you rewatched Coco');
    assert.equal(recommendationTitle({ RecommendationType: 1, BaselineItemName: 'Coco' }), 'Because you liked Coco');
    assert.equal(recommendationTitle({ RecommendationType: 1, BaselineItemName: 'Coco' }, { IsFavorite: true }), 'Because you favorited Coco');
    assert.equal(recommendationTitle({ RecommendationType: 2, BaselineItemName: 'Bigelow' }), 'Directed by Bigelow');
    assert.equal(recommendationTitle({ RecommendationType: 3, BaselineItemName: 'Pacino' }), 'Starring Pacino');
    assert.equal(recommendationTitle({ RecommendationType: 4 }), 'Directed by your favorites', 'collapsed groups keep the fan wording');
    assert.equal(recommendationTitle({ RecommendationType: 1 }), 'Recommended for you');
});

test('recommendations: Replay window covers two years of premieres', () => {
    assert.equal(RELEASE_WINDOW_DAYS, 730);
    assert.equal(isRecentRelease({ PremiereDate: year(1) }), true, 'fresh premieres count');
    assert.equal(isRecentRelease({ PremiereDate: year(729) }), true, 'old but inside the window counts');
    assert.equal(isRecentRelease({ PremiereDate: year(740) }), false, 'pre-1970-style back catalog is outside the window');
    assert.equal(isRecentRelease({ PremiereDate: '' }), false);
    assert.equal(isRecentRelease({}), false);

    const api = source('api.ts');
    assert.match(api, /MinPremiereDate: since/, 'the server filters by premiere date, not library-add date');
    assert.match(api, /SortBy: 'PremiereDate',\s*SortOrder: 'Descending'/);
    assert.match(api, /IsPlayed: 'false'/, 'already-watched titles do not fill the release row');
});

test('recommendations: the composer builds explainable topics with rotation, caps and dedup', () => {
    const watched = (index, ids) => ({
        Items: ids.map(movie),
        RecommendationType: 'SimilarToRecentlyPlayed',
        BaselineItemName: `Watched ${index}`,
        CategoryId: `baseline-${index}`
    });
    const groups = [
        watched(1, [ 'a1', 'a2', 'a3' ]),
        watched(2, [ 'b1', 'b2' ]),
        watched(3, [ 'c1', 'c2' ]),
        watched(4, [ 'd1', 'd2' ]),
        watched(5, [ 'e1', 'e2' ]),
        { ...watched(6, [ 'f1', 'f2' ]), BaselineItemName: 'Rewatched 6' }
    ];
    const baselines = Object.fromEntries([ 1, 2, 3, 4, 5 ].map(index => [ `baseline-${index}`, { UserData: { PlayCount: index === 6 ? 3 : 1 } } ]));

    const seedA = composeRecommendationTopics({ groups, baselines, seed: 'user:2026-10-17' });
    const sameSeed = composeRecommendationTopics({ groups, baselines, seed: 'user:2026-10-17' });
    const seedB = composeRecommendationTopics({ groups, baselines, seed: 'user:2026-10-18' });
    assert.deepEqual(seedA.map(topic => topic.id), sameSeed.map(topic => topic.id), 'same seed keeps the same layout across rerenders');
    const familyA = seedA.filter(topic => topic.kind === 'watched');
    const familyB = seedB.filter(topic => topic.kind === 'watched');
    assert.ok(familyA.length <= MAX_TOPICS_PER_FAMILY, 'a family rotates, it does not flood the feed');
    assert.deepEqual(familyA.map(topic => topic.baseline), familyA.map(topic => topic.baseline), 'rotation picks whole source titles, not shuffled rows');
    assert.notDeepEqual(familyA.map(topic => topic.baseline), familyB.map(topic => topic.baseline), 'a new day rotates in different source titles');
    assert.ok(familyA.every(topic => topic.title.startsWith('Because you watched')), 'single watches explain themselves');
    const rewatchTopics = composeRecommendationTopics({
        groups: [ { Items: [ movie('f1'), movie('f2') ], RecommendationType: 'SimilarToRecentlyPlayed', BaselineItemName: 'Rewatched 6', CategoryId: 'baseline-6' } ],
        baselines: { 'baseline-6': { UserData: { PlayCount: 3 } } },
        seed: 'user:2026-10-17'
    });
    assert.equal(rewatchTopics[0].title, 'Because you rewatched Rewatched 6');
    assert.equal(rewatchTopics[0].eyebrow, 'BECAUSE YOU REWATCHED REWATCHED 6');

    // overlapping topics shrink: later candidates keep only titles nobody claimed yet
    const overlap = composeRecommendationTopics({
        groups: [ watched(1, [ 'x1', 'x2' ]), watched(2, [ 'x1', 'x2', 'x3' ]) ],
        baselines: { 'baseline-1': {}, 'baseline-2': {} },
        seed: 'user:2026-10-17'
    });
    const kept = overlap.flatMap(topic => topic.items.map(item => item.Id));
    assert.equal(new Set(kept).size, kept.length, 'no title repeats across rows');
    assert.ok(overlap.every(topic => topic.items.length >= 2), 'rows below two distinct titles are dropped');

    // without a seed nothing rotates, order stays stable
    const plain = composeRecommendationTopics({ groups: groups.slice(0, 2), baselines });
    assert.equal(plain[0].baseline, 'Watched 1');
    assert.equal(sectionOfRail(plain[0].id), 'recommendations', 'reason rows ride the Recommendations section');
});

test('recommendations: taste picks and releases ride their own sections and stamps', () => {
    const topics = composeRecommendationTopics({
        groups: [],
        forYouMovies: [ movie('fya'), movie('fyb') ],
        forYouSeries: [ movie('fyd'), movie('fye') ],
        recentReleases: [ { ...movie('rel'), PremiereDate: year(30) }, { ...movie('old'), PremiereDate: year(900) }, { ...movie('no-date') } ],
        seed: 'user:2026-10-17'
    });
    const ids = topics.map(topic => topic.id);
    assert.deepEqual(ids, [ 'for-you-movies', 'for-you-series', 'recommendation-recent' ]);
    assert.equal(sectionOfRail('for-you-movies'), 'for-you');
    assert.equal(topics[0].title, 'Movies for you');
    assert.equal(topics[0].subtitle, 'FROM YOUR TASTE PROFILE');
    assert.equal(topics[2].title, 'Recently released');
    assert.deepEqual(topics[2].items.map(item => item.Id), [ 'rel' ], 'outside-window or undated titles never reach the release row');

    const hero = flattenRecommendationTopics(topics);
    assert.equal(hero.length, 5, 'the hero carousel gardens the same titles as the rails');
    assert.equal(hero[0].RecommendationType, 6);
    assert.equal(hero[0].RecommendationLabel, 'FOR YOU · MOVIES');
    assert.equal(hero[2].RecommendationType, 7, 'show picks keep their own code');
    assert.equal(hero[2].RecommendationLabel, 'FOR YOU · TV SHOWS');
    assert.equal(hero[4].RecommendationType, 9);
    assert.equal(hero[4].RecommendationLabel, 'NEW RELEASES');

    const fallback = flattenRecommendationTopics([], [ movie('l1'), movie('l1'), movie('l2') ]);
    assert.deepEqual(fallback.map(item => [ item.Id, item.RecommendationType ]), [ [ 'l1', 8 ], [ 'l2', 8 ] ], 'no history falls back to library picks');
});

test('recommendations: the home feed renders topic rails and keeps explore deduplicated', () => {
    const topics = composeRecommendationTopics({
        groups: [],
        forYouMovies: [ movie('fya'), movie('fyb') ],
        recentReleases: [ { ...movie('rel'), PremiereDate: year(30) } ],
        seed: 'user:2026-10-17'
    });
    const blocks = buildHomeFeedBlocks([ movie('r') ], [], [], [], [], [], [ movie('fya'), movie('new') ], [], { recommendationTopics: topics });
    const ids = blocks.filter(block => block.kind === 'rail').map(block => block.id);
    assert.deepEqual(ids, [ 'continue', 'for-you-movies', 'recommendation-recent', 'explore-0' ]);
    assert.equal(blocks.find(block => block.id === 'recommendation-recent').title, 'Recently released');
    assert.equal(blocks.find(block => block.id === 'explore-0').items.map(item => item.Id).join(), 'new', 'explore skips titles already recommended');

    // fallback path: without topics the legacy group rails still work
    const legacy = buildHomeFeedBlocks([ movie('r') ], [], [ { Items: [ movie('g1') ], RecommendationType: 0, BaselineItemName: 'Coco' } ], [], [], [], [], []);
    const legacyIds = legacy.filter(block => block.kind === 'rail').map(block => block.id);
    assert.deepEqual(legacyIds, [ 'continue', 'recommendation-0' ]);
    assert.equal(legacy.find(block => block.id === 'recommendation-0').title, 'Because you watched Coco');
});

test('recommendations: main.tsx composes topics and hydrates baselines', () => {    const main = source('main.tsx');
    assert.match(main, /composeRecommendationTopics\(\{\s*groups: recommendationGroups/, 'the home feed builds topics from stored state');
    assert.match(main, /baselines: recommendationBaselines/);
    assert.match(main, /seed: dailySeed\(session\?\.user\.Id\)/, 'rotation is per user per day');
    assert.match(main, /getRecommendationBaselines\(baselineIds/, 'baseline play counts hydrate the rewatched/favorited wording');
    assert.match(main, /getRecentlyReleased\(\)\.then\(saveExtra\('recentReleases'\)\)/, 'release candidates feed both the rails and the hero');
    assert.match(main, /flattenRecommendationTopics\(composeRecommendationTopics\(/, 'the hero carousel uses the same composed topics');
    assert.match(main, /recommendationBaselines,\s*setRecommendationBaselines\s*\]\s*=\s*useState/);
    assert.match(main, /item\.RecommendationLabel \|\| \(item\.RecommendationType === 8/, 'hero eyebrows come from the topic, not a type switch');
    assert.match(main, /recentReleases: current\.recentReleases && merge\(current\.recentReleases\)/, 'user data updates reach the release row too');

    const feed = source('home-feed-blocks.ts');
    assert.match(feed, /extras\.recommendationTopics \|\| \[\]\)\.filter/, 'the builder renders the composed topics when present');
    assert.match(feed, /topic\.kind === 'recent' \? 1 : 2/, 'small release rows survive, tiny reason rows do not');
    assert.match(feed, /id: topic\.id, kind: 'rail', title: topic\.title, subtitle: topic\.subtitle/);
    assert.match(feed, /export \{ recommendationTitle \}/, 'library suggestions keep the shared title logic');

    const discovery = source('discovery.ts');
    assert.match(discovery, /id: 'recommendations', label: 'Recommendations'/, 'the section no longer advertises one row kind');
    assert.match(discovery, /id\.startsWith\('recommendation-'\)\) return 'recommendations'/);
});

test('recommendations: the taste profile splits people by role and caps the picks', () => {
    const picks = explorePicksFromProfile({
        Genres: [ { Label: 'Drama' }, { Label: undefined }, { Label: 'Comedy' }, { Label: 'Noir' } ],
        People: [ { Name: 'Act One', Role: 'actor' }, { Name: 'Dir One', Role: 'director' }, { Name: 'Act Two', Role: 'ACTOR' }, { Name: 'Mystery', Role: 'writer' } ]
    });
    assert.deepEqual(picks.genres, [ 'Drama', 'Comedy', 'Noir' ], 'weights become plain labels');
    assert.deepEqual(picks.actors, [ 'Act One', 'Act Two' ], 'role matching is case-insensitive');
    assert.deepEqual(picks.directors, [ 'Dir One' ]);
    assert.deepEqual(explorePicksFromProfile(null), { genres: [], actors: [], directors: [] });
});

test('recommendations: explore becomes themed rails — genres, actors, directors, decades and seed rotation', () => {
    const picks = { genres: [ 'A', 'B', 'C', 'D', 'E' ], actors: [ 'Al Marin', 'Bo Tastic', 'Cy Nara' ], directors: [ 'D1', 'D2' ] };
    const seeded = composeExploreTopics(picks, 'user:2026-10-17');
    const stable = composeExploreTopics(picks, 'user:2026-10-17');
    const nextDay = composeExploreTopics(picks, 'user:2026-10-18');
    assert.deepEqual(seeded.map(spec => spec.id), stable.map(spec => spec.id), 'same seed, same rail order across rerenders');
    assert.notDeepEqual(seeded.map(spec => spec.id), nextDay.map(spec => spec.id), 'a new day rotates which topics lead');

    const themes = seeded.map(spec => spec.theme);
    assert.ok(themes.includes('critic') && themes.includes('deep'), 'crit back and deep cuts always exist');
    assert.equal(themes.filter(theme => theme === 'genre').length, 4, 'genre rows stop at the budget');
    assert.ok(themes.filter(theme => theme === 'actor').length <= 3);
    assert.ok(themes[0] !== themes[1], 'consecutive rails do not share a theme');

    const genre = seeded.find(spec => spec.theme === 'genre');
    assert.match(genre.title, /^Dive into /);
    const genreLabel = genre.title.replace(/^Dive into /, '');
    assert.equal(genre.query.Genres, genreLabel, 'the genre label rides the query');
    assert.equal(genre.query.IsPlayed, 'false', 'themed rows only surface unwatched titles');
    assert.equal(genre.query.IncludeItemTypes, 'Movie,Series');

    const decade = seeded.find(spec => spec.theme === 'decade');
    assert.match(decade.query.Years, /^\d{4}(,\d{4}){9}$/, 'a decade row covers all ten years');
    assert.match(decade.title, /^Back to the /);

    const critic = seeded.find(spec => spec.theme === 'critic');
    assert.equal(critic.query.MinCommunityRating, '8');
    assert.equal(critic.query.SortBy, 'Random');

    // no profile: decades plus critic/deep keep explore themed
    const bare = composeExploreTopics({ genres: [], actors: [], directors: [] }, 'user:2026-10-17');
    assert.ok(bare.length >= 3, 'taste-less accounts still get themed rows');
    assert.ok(bare.every(spec => spec.theme === 'decade' || spec.theme === 'critic' || spec.theme === 'deep'));
});

test('recommendations: home feed leads Explore with themed rails and hides repeats', () => {
    const specs = composeExploreTopics({ genres: [ 'Action' ], actors: [], directors: [] }, 'user:2026-10-17');
    const action = specs.find(spec => spec.theme === 'genre');
    const blocks = buildHomeFeedBlocks([], [], [], [], [], [], [ movie('p1'), movie('p2'), ...action ? [] : [] ], [], {
        exploreThemes: [
            { spec: action, items: [ movie('p2'), movie('p2'), movie('p3') ] },
            { spec: specs.find(spec => spec.theme === 'critic'), items: [ movie('p4'), movie('p5') ] },
            { spec: specs.find(spec => spec.theme === 'decade'), items: [] }
        ],
        exploreItems: [ movie('p6'), movie('p7') ]
    });
    const explore = blocks.filter(block => block.kind === 'rail').filter(block => block.id.startsWith('explore'));
    assert.deepEqual(explore.map(block => block.id), [ `explore-${action.id}`, 'explore-critic', 'explore-0' ], 'themes lead, an empty theme is skipped, then the fallback page');
    assert.equal(explore[0].title, 'Dive into Action');
    assert.equal(explore[0].subtitle, 'MORE ACTION');
    assert.equal(explore[0].items.map(item => item.Id).join(), 'p2,p3', 'repeat ids are pruned inside the rail');
    assert.equal(explore[2].items.map(item => item.Id).join(), 'p1', 'the fallback page drops titles a themed rail already showed');
    assert.ok(blocks.every(block => block.id !== 'explore-decade-2010s'), 'empty themes render nothing');

    const main = source('main.tsx');
    assert.match(main, /composeExploreTopics\(explorePicksFromProfile\(homeTasteProfile\)/);
    assert.match(main, /getExploreThemeItems\(spec\)/, 'themed pages ride their own queries');
    assert.match(main, /homeExploreSeen\.current\.has\(item\.Id\)/, 'themed pages and fallback pages share one seen-set');
    assert.match(main, /homeExploreThemeIndex < exploreTopicSpecs\.length \|\| homeExploreStart < homeExploreTotal/, 'the endless feed waits until a theme is done');

    const api = source('api.ts');
    assert.match(api, /async getExploreThemeItems\(/);
    assert.match(api, /Limit: 36/, 'themed pages over-fetch so the caller can drop repeats');
});
