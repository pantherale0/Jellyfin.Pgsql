import type { MediaItem, RecommendationGroup } from './types';
import { arrangeRails, defaultHomePreferences, type HomePreferences } from './discovery';

export interface HomeFeedExtras {
    forYouMovies?: MediaItem[];
    forYouSeries?: MediaItem[];
    audioResume?: MediaItem[];
    bookResume?: MediaItem[];
    latestByLibrary?: Array<{ library: MediaItem; items: MediaItem[] }>;
    preferences?: HomePreferences;
}

export function recommendationTitle(group: Pick<RecommendationGroup, 'RecommendationType' | 'BaselineItemName'>): string {
    const baseline = group.BaselineItemName;
    return group.RecommendationType === 0 ? `Because you watched ${baseline || ''}`
        : group.RecommendationType === 1 ? `Because you liked ${baseline || ''}`
            : group.RecommendationType === 2 || group.RecommendationType === 4 ? `Directed by ${baseline || 'your favorites'}`
                : group.RecommendationType === 3 || group.RecommendationType === 5 ? `Starring ${baseline || 'your favorites'}`
                    : 'Recommended for you';
}

export interface HomeFeedBlock {
    id: string;
    kind: 'rail' | 'spotlight';
    title: string;
    subtitle?: string;
    items: MediaItem[];
    spotlightType?: 'collection' | 'director' | 'vault' | 'milestone';
    description?: string;
}

export function buildHomeFeedBlocks(resume: MediaItem[], latest: MediaItem[], groups: RecommendationGroup[], collections: MediaItem[] = [], onNow: MediaItem[] = [], vaultCandidates: MediaItem[] = [], exploreItems: MediaItem[] = [], nextUp: MediaItem[] = [], extras: HomeFeedExtras = {}): HomeFeedBlock[] {
    let rails: HomeFeedBlock[] = [];
    const { forYouMovies = [], forYouSeries = [], audioResume = [], bookResume = [], latestByLibrary = [] } = extras;
    if (resume.length) rails.push({ id: 'continue', kind: 'rail', title: 'Continue watching', subtitle: 'PICK UP WHERE YOU LEFT OFF', items: resume });
    if (audioResume.length) rails.push({ id: 'continue-listening', kind: 'rail', title: 'Continue listening', subtitle: 'PICK UP WHERE YOU LEFT OFF', items: audioResume });
    if (bookResume.length) rails.push({ id: 'continue-reading', kind: 'rail', title: 'Continue reading', subtitle: 'PICK UP WHERE YOU LEFT OFF', items: bookResume });
    if (forYouMovies.length) rails.push({ id: 'for-you-movies', kind: 'rail', title: 'Movies for you', subtitle: 'FROM YOUR TASTE PROFILE', items: forYouMovies });
    if (forYouSeries.length) rails.push({ id: 'for-you-series', kind: 'rail', title: 'Shows for you', subtitle: 'FROM YOUR TASTE PROFILE', items: forYouSeries });
    latestByLibrary.forEach(({ library, items }) => {
        if (items.length) rails.push({ id: `latest-library-${library.Id}`, kind: 'rail', title: `Latest in ${library.Name}`, subtitle: 'RECENTLY ADDED', items });
    });
    if (nextUp.length) rails.push({ id: 'next-up', kind: 'rail', title: 'Next up', subtitle: 'UP NEXT IN YOUR SERIES', items: nextUp });
    if (latest.length) rails.push({ id: 'latest', kind: 'rail', title: 'Just added', subtitle: 'FRESH FROM YOUR LIBRARY', items: latest });
    if (onNow.length) rails.push({ id: 'on-now', kind: 'rail', title: 'On Now', subtitle: 'LIVE TV', items: onNow });

    groups.forEach((group, index) => {
        const items = (group.Items || []).filter(item => item.Id);
        if (!items.length) return;
        const title = recommendationTitle(group);
        rails.push({ id: `recommendation-${index}`, kind: 'rail', title, subtitle: 'PERSONALIZED FOR YOU', items: items.slice(0, 24) });
    });

    const knownIds = new Set([ ...resume, ...nextUp, ...latest, ...onNow, ...groups.flatMap(group => group.Items || []), ...forYouMovies, ...forYouSeries, ...audioResume, ...bookResume, ...latestByLibrary.flatMap(entry => entry.items) ].map(item => item.Id));
    const distinctExplore = exploreItems.filter(item => item.Id && !knownIds.has(item.Id));
    for (let offset = 0; offset < distinctExplore.length; offset += 24) {
        const page = distinctExplore.slice(offset, offset + 24);
        if (page.length) rails.push({ id: `explore-${offset}`, kind: 'rail', title: offset ? 'More from your library' : 'Explore your library', subtitle: 'MORE TO DISCOVER', items: page });
    }

    rails = arrangeRails(rails, extras.preferences || defaultHomePreferences());

    const allItems = uniqueItems([ ...collections, ...latest, ...resume, ...groups.flatMap(group => group.Items || []) ]);
    const spotlights: HomeFeedBlock[] = [];
    const boxSet = allItems.find(item => item.Type === 'BoxSet' && (item.ChildCount || 0) > 0);
    if (boxSet) spotlights.push({ id: `collection-${boxSet.Id}`, kind: 'spotlight', title: boxSet.Name, subtitle: 'COLLECTION SPOTLIGHT', description: boxSet.Overview, items: [ boxSet ], spotlightType: 'collection' });

    const directorGroup = groups.find(group => (group.RecommendationType === 2 || group.RecommendationType === 4) && group.BaselineItemName && (group.Items?.length || 0) >= 4);
    if (directorGroup?.Items?.length) spotlights.push({ id: `director-${directorGroup.BaselineItemName}`, kind: 'spotlight', title: directorGroup.BaselineItemName || 'Director spotlight', subtitle: 'DIRECTOR FOCUS', description: `Explore ${directorGroup.Items.length} picks connected to ${directorGroup.BaselineItemName}.`, items: directorGroup.Items.slice(0, 8), spotlightType: 'director' });

    const sixMonthsAgo = Date.now() - 183 * 24 * 60 * 60 * 1000;
    const isOldUnwatched = (item: MediaItem) => {
        const created = Date.parse(item.DateCreated || item.PremiereDate || '');
        return (item.CommunityRating || 0) >= 8 && !item.UserData?.Played && !(item.UserData?.PlayedPercentage || 0) && Number.isFinite(created) && created <= sixMonthsAgo;
    };
    const vault = vaultCandidates.find(isOldUnwatched);
    const rated = vault || allItems.find(item => (item.CommunityRating || 0) >= 8 && !item.UserData?.Played);
    if (rated) spotlights.push({ id: `vault-${rated.Id}`, kind: 'spotlight', title: rated.Name, subtitle: 'HIGHLY RATED · UNWATCHED', description: rated.Overview || 'A highly rated title from your library is ready to watch.', items: [ rated ], spotlightType: 'vault' });

    const episode = resume.find(item => item.SeriesName && item.SeriesId);
    if (episode) spotlights.push({ id: `milestone-${episode.SeriesId}`, kind: 'spotlight', title: episode.SeriesName || 'Your next episode', subtitle: 'NEXT TV MILESTONE', description: `Continue ${episode.Name} and keep moving through ${episode.SeriesName}.`, items: [ episode ], spotlightType: 'milestone' });

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
