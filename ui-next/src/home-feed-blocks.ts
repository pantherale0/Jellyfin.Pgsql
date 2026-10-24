import type { MediaItem, RecommendationGroup } from './types';
import type { SeerrItem } from './seerr';
import { arrangeRails, defaultHomePreferences, type HomePreferences } from './discovery';
import { type ExploreTopicSpec, type RecommendationTopic, recommendationTitle } from './recommendations';
import { t } from './i18n';

export { recommendationTitle };

export const HOME_EXPLORE_PAGE_SIZE = 24;

export interface HomeFeedExtras {
    forYouMovies?: MediaItem[];
    forYouSeries?: MediaItem[];
    audioResume?: MediaItem[];
    bookResume?: MediaItem[];
    latestByLibrary?: Array<{ library: MediaItem; items: MediaItem[] }>;
    /** Movies premiered inside the rolling release window, for the Recently released topic. */
    recentReleases?: MediaItem[];
    /** Composed recommendation topics (because you watched/liked, taste picks, releases). */
    recommendationTopics?: RecommendationTopic[];
    /** Themed Explore pages (genre dives, actors, directors, decades) shown before the fallback rail. */
    exploreThemes?: Array<{ spec: ExploreTopicSpec; items: MediaItem[] }>;
    exploreHasMore?: boolean;
    beyondMovies?: SeerrItem[];
    beyondShows?: SeerrItem[];
    preferences?: HomePreferences;
}

export interface HomeFeedBlock {
    id: string;
    kind: 'rail' | 'explore' | 'spotlight' | 'requests';
    title: string;
    subtitle?: string;
    items: MediaItem[];
    /** Seerr titles outside the library (`kind: 'requests'`). */
    requests?: SeerrItem[];
    spotlightType?: 'collection' | 'director' | 'vault' | 'milestone';
    description?: string;
}

export function buildHomeFeedBlocks(resume: MediaItem[], latest: MediaItem[], groups: RecommendationGroup[], collections: MediaItem[] = [], onNow: MediaItem[] = [], vaultCandidates: MediaItem[] = [], exploreItems: MediaItem[] = [], nextUp: MediaItem[] = [], extras: HomeFeedExtras = {}): HomeFeedBlock[] {
    let rails: HomeFeedBlock[] = [];
    const { forYouMovies = [], forYouSeries = [], audioResume = [], bookResume = [], latestByLibrary = [], beyondMovies = [], beyondShows = [] } = extras;
    if (resume.length) rails.push({ id: 'continue', kind: 'rail', title: t('Continue watching'), subtitle: t('PICK UP WHERE YOU LEFT OFF'), items: resume });
    if (audioResume.length) rails.push({ id: 'continue-listening', kind: 'rail', title: t('Continue listening'), subtitle: t('PICK UP WHERE YOU LEFT OFF'), items: audioResume });
    if (bookResume.length) rails.push({ id: 'continue-reading', kind: 'rail', title: t('Continue reading'), subtitle: t('PICK UP WHERE YOU LEFT OFF'), items: bookResume });
    latestByLibrary.forEach(({ library, items }) => {
        if (items.length) rails.push({ id: `latest-library-${library.Id}`, kind: 'rail', title: t('Latest in {0}', library.Name), subtitle: t('RECENTLY ADDED'), items });
    });
    if (nextUp.length) rails.push({ id: 'next-up', kind: 'rail', title: t('Next up'), subtitle: t('UP NEXT IN YOUR SERIES'), items: nextUp });
    if (latest.length) rails.push({ id: 'latest', kind: 'rail', title: t('Just added'), subtitle: t('FRESH FROM YOUR LIBRARY'), items: latest });
    if (onNow.length) rails.push({ id: 'on-now', kind: 'rail', title: t('On Now'), subtitle: t('LIVE TV'), items: onNow });
    const topics = (extras.recommendationTopics || []).filter(topic => topic.items.some(item => item.Id));
    if (topics.length) {
        topics.forEach(topic => {
            const items = uniqueItems(topic.items).slice(0, 24);
            if (items.length < (topic.kind === 'recent' ? 1 : 2)) return;
            rails.push({ id: topic.id, kind: 'rail', title: topic.title, subtitle: topic.subtitle, items });
        });
    } else {
        if (forYouMovies.length) rails.push({ id: 'for-you-movies', kind: 'rail', title: t('Movies for you'), subtitle: t('FROM YOUR TASTE PROFILE'), items: forYouMovies });
        if (forYouSeries.length) rails.push({ id: 'for-you-series', kind: 'rail', title: t('Shows for you'), subtitle: t('FROM YOUR TASTE PROFILE'), items: forYouSeries });
        groups.forEach((group, index) => {
            const items = (group.Items || []).filter(item => item.Id);
            if (!items.length) return;
            const title = recommendationTitle(group);
            rails.push({ id: `recommendation-${index}`, kind: 'rail', title, subtitle: t('PERSONALIZED FOR YOU'), items: items.slice(0, 24) });
        });
    }

    if (beyondMovies.length) rails.push({ id: 'beyond-movies', kind: 'requests', title: t('Movies beyond your library'), subtitle: t('REQUEST FROM SEERR'), items: [], requests: beyondMovies });
    if (beyondShows.length) rails.push({ id: 'beyond-shows', kind: 'requests', title: t('Shows beyond your library'), subtitle: t('REQUEST FROM SEERR'), items: [], requests: beyondShows });

    const knownIds = new Set([ ...resume, ...nextUp, ...latest, ...onNow, ...(topics.length ? topics.flatMap(topic => topic.items) : groups.flatMap(group => group.Items || [])), ...forYouMovies, ...forYouSeries, ...audioResume, ...bookResume, ...(extras.exploreThemes || []).flatMap(entry => entry.items), ...latestByLibrary.flatMap(entry => entry.items) ].map(item => item.Id));
    // Themed rails lead the Explore section; the old un-themed pages only fill in behind them.
    (extras.exploreThemes || []).forEach(({ spec, items }) => {
        const fresh = uniqueItems(items).slice(0, 24);
        if (!fresh.length) return;
        rails.push({ id: `explore-${spec.id}`, kind: 'rail', title: spec.title, subtitle: spec.eyebrow, items: fresh });
    });
    const distinctExplore = exploreItems.filter(item => item.Id && !knownIds.has(item.Id));
    if (distinctExplore.length || extras.exploreHasMore) rails.push({ id: 'explore-fallback', kind: 'explore', title: t('Explore your library'), subtitle: t('MORE TO DISCOVER'), items: distinctExplore });

    rails = arrangeRails(rails, extras.preferences || defaultHomePreferences());

    const allItems = uniqueItems([ ...collections, ...latest, ...resume, ...(topics.length ? topics.flatMap(topic => topic.items) : groups.flatMap(group => group.Items || [])) ]);
    const spotlights: HomeFeedBlock[] = [];
    const boxSet = allItems.find(item => item.Type === 'BoxSet' && (item.ChildCount || 0) > 0);
    if (boxSet) spotlights.push({ id: `collection-${boxSet.Id}`, kind: 'spotlight', title: boxSet.Name, subtitle: t('COLLECTION SPOTLIGHT'), description: boxSet.Overview, items: [ boxSet ], spotlightType: 'collection' });

    const directorGroup = groups.find(group => (group.RecommendationType === 2 || group.RecommendationType === 4) && group.BaselineItemName && (group.Items?.length || 0) >= 4);
    if (directorGroup?.Items?.length) spotlights.push({ id: `director-${directorGroup.BaselineItemName}`, kind: 'spotlight', title: directorGroup.BaselineItemName || t('Director spotlight'), subtitle: t('DIRECTOR FOCUS'), description: t('Explore {0} picks connected to {1}.', directorGroup.Items.length, directorGroup.BaselineItemName), items: directorGroup.Items.slice(0, 8), spotlightType: 'director' });

    const sixMonthsAgo = Date.now() - 183 * 24 * 60 * 60 * 1000;
    const isOldUnwatched = (item: MediaItem) => {
        const created = Date.parse(item.DateCreated || item.PremiereDate || '');
        return (item.CommunityRating || 0) >= 8 && !item.UserData?.Played && !(item.UserData?.PlayedPercentage || 0) && Number.isFinite(created) && created <= sixMonthsAgo;
    };
    const vault = vaultCandidates.find(isOldUnwatched);
    const rated = vault || allItems.find(item => (item.CommunityRating || 0) >= 8 && !item.UserData?.Played);
    if (rated) spotlights.push({ id: `vault-${rated.Id}`, kind: 'spotlight', title: rated.Name, subtitle: t('HIGHLY RATED · UNWATCHED'), description: rated.Overview || t('A highly rated title from your library is ready to watch.'), items: [ rated ], spotlightType: 'vault' });

    const episode = resume.find(item => item.SeriesName && item.SeriesId);
    if (episode) spotlights.push({ id: `milestone-${episode.SeriesId}`, kind: 'spotlight', title: episode.SeriesName || t('Your next episode'), subtitle: t('NEXT TV MILESTONE'), description: t('Continue {0} and keep moving through {1}.', episode.Name, episode.SeriesName), items: [ episode ], spotlightType: 'milestone' });

    if (!rails.length) return spotlights;
    const result: HomeFeedBlock[] = [];
    let spotlightIndex = 0;
    rails.forEach((rail, index) => {
        result.push(rail);
        if ((index + 1) % 2 === 0 && spotlightIndex < spotlights.length) result.push(spotlights[spotlightIndex++]);
    });
    while (spotlightIndex < spotlights.length) result.push(spotlights[spotlightIndex++]);
    return result;
}

function uniqueItems(items: MediaItem[]): MediaItem[] {
    const ids = new Set<string>();
    return items.filter(item => Boolean(item.Id) && !ids.has(item.Id) && Boolean(ids.add(item.Id)));
}
