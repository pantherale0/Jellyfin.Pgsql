import type { MediaItem, RecommendationGroup } from './types';
import { t } from './i18n';

/** Numeric codes: 0-5 are Jellyfin's RecommendationType enum, 6-9 are client-side topics. */
export const RECOMMENDATION_TYPES = {
    SimilarToRecentlyPlayed: 0,
    SimilarToLikedItem: 1,
    HasDirectorFromRecentlyPlayed: 2,
    HasActorFromRecentlyPlayed: 3,
    HasLikedDirector: 4,
    HasLikedActor: 5,
    ForYouMovies: 6,
    ForYouSeries: 7,
    FromLibrary: 8,
    RecentlyReleased: 9
} as const;

const RECOMMENDATION_ENUM_NAMES: Record<string, number> = {
    SimilarToRecentlyPlayed: RECOMMENDATION_TYPES.SimilarToRecentlyPlayed,
    SimilarToLikedItem: RECOMMENDATION_TYPES.SimilarToLikedItem,
    HasDirectorFromRecentlyPlayed: RECOMMENDATION_TYPES.HasDirectorFromRecentlyPlayed,
    HasActorFromRecentlyPlayed: RECOMMENDATION_TYPES.HasActorFromRecentlyPlayed,
    HasLikedDirector: RECOMMENDATION_TYPES.HasLikedDirector,
    HasLikedActor: RECOMMENDATION_TYPES.HasLikedActor
};

/** Jellyfin serializes RecommendationType as a string enum by default; normalize to numbers. */
export function normalizeRecommendationType(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        if (value in RECOMMENDATION_ENUM_NAMES) return RECOMMENDATION_ENUM_NAMES[value];
        const numeric = Number(value);
        if (Number.isFinite(numeric)) return numeric;
    }
    return -1;
}

export interface RecommendationBaseline {
    /** How often the baseline title was played (`PlayCount` from UserData). */
    PlayCount?: number;
    IsFavorite?: boolean;
}

/** How much the user engaged with the baseline of a recommendation group. */
export function baselineInfoOf(item: Pick<MediaItem, 'PlayCount' | 'UserData'> | undefined): RecommendationBaseline {
    if (!item) return {};
    return {
        PlayCount: item.UserData?.PlayCount ?? item.PlayCount ?? (item.UserData?.Played ? 1 : 0),
        IsFavorite: item.UserData?.IsFavorite === true
    };
}

export type RecommendationKind = 'watched' | 'rewatched' | 'liked' | 'favorited' | 'directed' | 'starring' | 'recent' | 'for-you' | 'other';

export interface RecommendationTopic {
    /** Rail id; `for-you-*` maps to the For You section, everything else to Recommendations. */
    id: string;
    kind: RecommendationKind;
    /** Numeric RecommendationType code for hero labels and stamps. */
    type: number;
    title: string;
    subtitle: string;
    /** Uppercase hero eyebrow ("BECAUSE YOU WATCHED LEO"). */
    eyebrow: string;
    baseline?: string;
    items: MediaItem[];
}

/** Rail title of a recommendation group, with rewatch/favorite wording from baseline engagement. */
export function recommendationTitle(group: Pick<RecommendationGroup, 'RecommendationType' | 'BaselineItemName'>, baseline?: RecommendationBaseline): string {
    const kind = topicKind(normalizeRecommendationType(group.RecommendationType), baseline);
    const name = group.BaselineItemName || '';
    switch (kind) {
        case 'watched': return name ? t('Because you watched {0}', name) : t('Recommended for you');
        case 'rewatched': return name ? t('Because you rewatched {0}', name) : t('Recommended for you');
        case 'liked': return name ? t('Because you liked {0}', name) : t('Recommended for you');
        case 'favorited': return name ? t('Because you favorited {0}', name) : t('Recommended for you');
        case 'directed': return t('Directed by {0}', name || t('your favorites'));
        case 'starring': return t('Starring {0}', name || t('your favorites'));
        case 'recent': return t('Recently released');
        default: return t('Recommended for you');
    }
}

export function topicKind(type: number, baseline?: RecommendationBaseline): RecommendationKind {
    if (type === RECOMMENDATION_TYPES.SimilarToRecentlyPlayed) return baseline?.IsFavorite ? 'favorited'
        : (baseline?.PlayCount ?? 0) >= 2 ? 'rewatched' : 'watched';
    if (type === RECOMMENDATION_TYPES.SimilarToLikedItem) return baseline?.IsFavorite ? 'favorited' : 'liked';
    if (type === RECOMMENDATION_TYPES.HasDirectorFromRecentlyPlayed || type === RECOMMENDATION_TYPES.HasLikedDirector) return 'directed';
    if (type === RECOMMENDATION_TYPES.HasActorFromRecentlyPlayed || type === RECOMMENDATION_TYPES.HasLikedActor) return 'starring';
    if (type === RECOMMENDATION_TYPES.RecentlyReleased) return 'recent';
    if (type === RECOMMENDATION_TYPES.ForYouMovies || type === RECOMMENDATION_TYPES.ForYouSeries) return 'for-you';
    return 'other';
}

function eyebrowFor(kind: RecommendationKind, baseline: string, type: number): string {
    const upper = (text: string) => text.toLocaleUpperCase();
    switch (kind) {
        case 'watched': return upper(baseline ? t('Because you watched {0}', baseline) : t('BECAUSE YOU WATCHED'));
        case 'rewatched': return upper(baseline ? t('Because you rewatched {0}', baseline) : t('BECAUSE YOU REWATCHED'));
        case 'liked': return upper(baseline ? t('Because you liked {0}', baseline) : t('BECAUSE YOU LIKED'));
        case 'favorited': return upper(baseline ? t('Because you favorited {0}', baseline) : t('BECAUSE YOU FAVORITED'));
        case 'directed': return upper(baseline ? t('Directed by {0}', baseline) : t('DIRECTOR PICK'));
        case 'starring': return upper(baseline ? t('Starring {0}', baseline) : t('CAST PICK'));
        case 'recent': return upper(t('NEW RELEASES'));
        case 'for-you': return upper(type === RECOMMENDATION_TYPES.ForYouMovies ? t('FOR YOU · MOVIES') : t('FOR YOU · TV SHOWS'));
        default: return upper(t('PICKED FOR YOU'));
    }
}

/** Rolling window for the Recently released topic. */
export const RELEASE_WINDOW_DAYS = 730;
const DAY_MS = 24 * 60 * 60 * 1000;

export function isRecentRelease(item: Pick<MediaItem, 'PremiereDate'>, now = Date.now()): boolean {
    const released = Date.parse(item.PremiereDate || '');
    return Number.isFinite(released) && released <= now && released > now - RELEASE_WINDOW_DAYS * DAY_MS;
}

/** Rotation budget so one family cannot flood the feed with lookalike rows. */
export const MAX_TOPICS_PER_FAMILY = 3;
/** Topics keep their ranked items, capped per rail. */
export const MAX_TOPICS_ITEMS = 24;
/** A row must keep at least this many distinct titles (Recently released may be smaller). */
export const MIN_TOPICS_ITEMS = 2;

// Deterministic daily rotation: FNV-1a turns the seed into a state, mulberry32 spreads it.
function seedRandom(seed: string): () => number {
    let state = 0x811c9dc5;
    for (let index = 0; index < seed.length; index++) {
        state ^= seed.charCodeAt(index);
        state = Math.imul(state, 0x01000193) >>> 0;
    }
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let mixed = state;
        mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
        mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 0x100000000;
    };
}

function shuffled<T>(items: T[], random?: () => number): T[] {
    if (!random) return items.slice();
    const result = items.slice();
    for (let index = result.length - 1; index > 0; index--) {
        const target = Math.floor(random() * (index + 1));
        [ result[index], result[target] ] = [ result[target], result[index] ];
    }
    return result;
}

const FAMILY_ORDER: RecommendationKind[] = [ 'watched', 'rewatched', 'liked', 'favorited', 'for-you', 'directed', 'starring', 'recent', 'other' ];

export interface ComposeOptions {
    groups?: RecommendationGroup[];
    forYouMovies?: MediaItem[];
    forYouSeries?: MediaItem[];
    recentReleases?: MediaItem[];
    /** Baseline items keyed by the group's `CategoryId`, carrying PlayCount/favorite state. */
    baselines?: Record<string, Pick<MediaItem, 'PlayCount' | 'UserData'> | undefined>;
    /** Stable per-user daily seed ("userId:2026-10-17"); without it rotation keeps input order. */
    seed?: string;
}

interface GroupDescriptor {
    kind: RecommendationKind;
    baseline?: string;
    info?: RecommendationBaseline;
}

function describeGroup(group: RecommendationGroup, baselines: ComposeOptions['baselines'] | undefined): GroupDescriptor {
    const info = baselines && group.CategoryId ? baselineInfoOf(baselines[group.CategoryId]) : undefined;
    const type = normalizeRecommendationType(group.RecommendationType);
    return { kind: topicKind(type, info), baseline: group.BaselineItemName || undefined, info };
}

/**
 * Builds one deduplicated, explainable topic list from watch-history, like, favorite,
 * taste-ranked and release-based sources. Groups of the same kind rotate through the
 * daily seed, so the feed stays varied without rewriting the ranked rows themselves.
 */
export function composeRecommendationTopics(options: ComposeOptions = {}): RecommendationTopic[] {
    const { groups = [], forYouMovies = [], forYouSeries = [], recentReleases = [], baselines, seed } = options;
    // Each family derives its own stream from the daily seed, so which source titles win a
    // family's rotation slots changes day to day without touching the ranked rows.
    const familyRng = new Map<RecommendationKind, () => number>();
    const rngFor = (family: RecommendationKind) => {
        if (!seed) return undefined;
        if (!familyRng.has(family)) familyRng.set(family, seedRandom(`${seed}:${family}`));
        return familyRng.get(family);
    };

    const candidates = new Map<RecommendationKind, Array<{ topic: RecommendationTopic; min: number }>>();
    const add = (kind: RecommendationKind, entry: { topic: RecommendationTopic; min: number }) => {
        if (!candidates.has(kind)) candidates.set(kind, []);
        candidates.get(kind)!.push(entry);
    };

    groups.forEach((group, index) => {
        const items = (group.Items || []).filter(item => item.Id);
        if (!items.length) return;
        const { kind, baseline, info } = describeGroup(group, baselines);
        add(kind, {
            topic: {
                id: `recommendation-${index}`,
                kind,
                type: normalizeRecommendationType(group.RecommendationType),
                title: recommendationTitle({ RecommendationType: group.RecommendationType, BaselineItemName: group.BaselineItemName }, info),
                subtitle: t('PERSONALIZED FOR YOU'),
                eyebrow: eyebrowFor(kind, baseline || '', normalizeRecommendationType(group.RecommendationType)),
                baseline,
                items: items.slice(0, MAX_TOPICS_ITEMS)
            },
            min: MIN_TOPICS_ITEMS
        });
    });

    if (forYouMovies.length) add('for-you', {
        topic: { id: 'for-you-movies', kind: 'for-you', type: RECOMMENDATION_TYPES.ForYouMovies, title: t('Movies for you'), subtitle: t('FROM YOUR TASTE PROFILE'), eyebrow: eyebrowFor('for-you', '', RECOMMENDATION_TYPES.ForYouMovies), items: forYouMovies.slice(0, MAX_TOPICS_ITEMS) },
        min: MIN_TOPICS_ITEMS
    });
    if (forYouSeries.length) add('for-you', {
        topic: { id: 'for-you-series', kind: 'for-you', type: RECOMMENDATION_TYPES.ForYouSeries, title: t('Shows for you'), subtitle: t('FROM YOUR TASTE PROFILE'), eyebrow: eyebrowFor('for-you', '', RECOMMENDATION_TYPES.ForYouSeries), items: forYouSeries.slice(0, MAX_TOPICS_ITEMS) },
        min: MIN_TOPICS_ITEMS
    });

    const releases = recentReleases.filter(item => item.Id && isRecentRelease(item));
    if (releases.length) add('recent', {
        topic: {
            id: 'recommendation-recent',
            kind: 'recent',
            type: RECOMMENDATION_TYPES.RecentlyReleased,
            title: t('Recently released'),
            subtitle: t('NEW RELEASES'),
            eyebrow: eyebrowFor('recent', '', RECOMMENDATION_TYPES.RecentlyReleased),
            items: releases.slice(0, MAX_TOPICS_ITEMS)
        },
        min: 1
    });

    const topics: RecommendationTopic[] = [];
    const seen = new Set<string>();
    FAMILY_ORDER.forEach(kind => {
        const family = candidates.get(kind) || [];
        const rotation = shuffled(family, rngFor(kind)).slice(0, MAX_TOPICS_PER_FAMILY);
        rotation.forEach(entry => {
            const items = entry.topic.items.filter(item => Boolean(item.Id) && !seen.has(item.Id));
            if (items.length < entry.min) return;
            items.forEach(item => seen.add(item.Id));
            topics.push({ ...entry.topic, items });
        });
    });
    return topics;
}

/** Flattens topics into the replayable hero carousel, falling back to library picks. */
export function flattenRecommendationTopics(topics: RecommendationTopic[], fallbackLatest: MediaItem[] = []): MediaItem[] {
    const flat: MediaItem[] = [];
    const seen = new Set<string>();
    topics.forEach(topic => topic.items.forEach(item => {
        if (!item.Id || seen.has(item.Id)) return;
        seen.add(item.Id);
        flat.push({ ...item, RecommendationType: topic.type, BaselineItemName: topic.baseline, RecommendationLabel: topic.eyebrow });
    }));
    if (flat.length || !fallbackLatest.length) return flat;
    const latestSeen = new Set<string>();
    return fallbackLatest
        .filter(item => Boolean(item.Id) && !latestSeen.has(item.Id) && Boolean(latestSeen.add(item.Id)))
        .map(item => ({ ...item, RecommendationType: RECOMMENDATION_TYPES.FromLibrary }));
}

export type ExploreTheme = 'genre' | 'actor' | 'director' | 'decade' | 'critic' | 'deep';

/** A themed page query for the Explore section, generated from the taste profile + a daily seed. */
export interface ExploreTopicSpec {
    /** Stable slug; the home builder prefixes rails with `explore-` so the section editor stays in control. */
    id: string;
    theme: ExploreTheme;
    title: string;
    eyebrow: string;
    /** Extra `/Items` parameters (Genres, Person + PersonTypes, Years, MinCommunityRating…). */
    query: Record<string, string>;
}

export interface ExplorePicks {
    genres: string[];
    actors: string[];
    directors: string[];
}

/** Taste profile rows are ({Label} weights and {Name, Role} people) — flatten to plain pick lists. */
export function explorePicksFromProfile(profile: { Genres?: Array<{ Label?: string }>; People?: Array<{ Name?: string; Role?: string }> } | null | undefined): ExplorePicks {
    const clean = (value: string | undefined) => {
        const text = (value || '').trim();
        return text && text.length <= 120 ? text : '';
    };
    const roleMatches = (person: { Name?: string; Role?: string }, role: string) =>
        clean(person.Name) && (person.Role || '').trim().toLowerCase() === role;
    return {
        genres: (profile?.Genres || []).map(entry => clean(entry.Label)).filter(Boolean).slice(0, 8),
        actors: (profile?.People || []).filter(person => roleMatches(person, 'actor')).map(person => clean(person.Name)).filter(Boolean).slice(0, 8),
        directors: (profile?.People || []).filter(person => roleMatches(person, 'director')).map(person => clean(person.Name)).filter(Boolean).slice(0, 6)
    };
}

/** Per-theme budgets: taste picks are finite, so the Explore section can run several pages deep. */
const EXPLORE_BUDGETS: Record<ExploreTheme, number> = { genre: 4, actor: 3, director: 3, decade: 3, critic: 1, deep: 1 };

/** Decades walk back from the current one so the row matches what a library can actually hold. */
function decadeChoices(now = Date.now()): string[] {
    const oldest = 1950;
    const newest = Math.floor(new Date(now).getFullYear() / 10) * 10;
    const choices: string[] = [];
    for (let start = newest; start >= oldest - 1; start -= 10) choices.push(`${start}s`);
    return choices;
}

function slug(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

/** Rotates theme types so Explore has varied rows before the generic fallback. */
export function composeExploreTopics(picks: ExplorePicks, seed: string, now = Date.now()): ExploreTopicSpec[] {
    const rotation = (values: string[], theme: ExploreTheme): string[] =>
        shuffled(values.filter(Boolean), seedRandom(`explore:${seed}:${theme}`)).slice(0, EXPLORE_BUDGETS[theme]);

    const genreSpecs = rotation(picks.genres, 'genre').map(entry => ({
        id: `genre-${slug(entry)}`,
        theme: 'genre' as const,
        title: t('Dive into {0}', entry),
        eyebrow: t('MORE {0}', entry.toLocaleUpperCase()),
        query: { Genres: entry, IncludeItemTypes: 'Movie,Series', IsPlayed: 'false' }
    }));
    const actorSpecs = rotation(picks.actors, 'actor').map(entry => ({
        id: `actor-${slug(entry)}`,
        theme: 'actor' as const,
        title: t('More with {0}', entry),
        eyebrow: t('Starring {0}', entry).toLocaleUpperCase(),
        query: { Person: entry, PersonTypes: 'Actor', IncludeItemTypes: 'Movie,Series', IsPlayed: 'false' }
    }));
    const directorSpecs = rotation(picks.directors, 'director').map(entry => ({
        id: `director-${slug(entry)}`,
        theme: 'director' as const,
        title: t('More from {0}', entry),
        eyebrow: t('Directed by {0}', entry).toLocaleUpperCase(),
        query: { Person: entry, PersonTypes: 'Director', IncludeItemTypes: 'Movie,Series', IsPlayed: 'false' }
    }));
    // Decades rotate independently of the profile: a library without taste picks still gets themed rows.
    const decadeSpecs = rotation(decadeChoices(now), 'decade').map(entry => ({
        id: `decade-${slug(entry)}`,
        theme: 'decade' as const,
        title: t('Back to the {0}', entry),
        eyebrow: t('FROM THE {0}', entry.toLocaleUpperCase()),
        query: { Years: Array.from({ length: 10 }, (_, offset) => String(Number(entry.slice(0, 4)) + offset)).join(','), IncludeItemTypes: 'Movie,Series', IsPlayed: 'false' }
    }));
    const criticSpecs: ExploreTopicSpec[] = [ {
        id: 'critic',
        theme: 'critic',
        title: t('Critically loved'),
        eyebrow: t('RATED {0} AND UP · UNWATCHED', '8'),
        query: { MinCommunityRating: '8', IncludeItemTypes: 'Movie,Series', IsPlayed: 'false', SortBy: 'Random' }
    } ];
    const deepSpecs: ExploreTopicSpec[] = [ {
        id: 'deep',
        theme: 'deep',
        title: t('Off the beaten path'),
        eyebrow: t('DEEP CUTS'),
        query: { IncludeItemTypes: 'Movie,Series', IsPlayed: 'false', SortBy: 'Random' }
    } ];

    // Interleave classes so consecutive rails rarely share a theme.
    const lanes = [ genreSpecs, actorSpecs, decadeSpecs, directorSpecs, criticSpecs, deepSpecs ];
    const specs: ExploreTopicSpec[] = [];
    while (lanes.some(lane => lane.length)) {
        lanes.forEach(lane => {
            const spec = lane.shift();
            if (spec) specs.push(spec);
        });
    }
    return specs;
}
