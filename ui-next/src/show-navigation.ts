export type EpisodeControl = 'art' | 'title' | 'play';
export type Direction = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';

export type ShowTarget =
    | { kind: 'back' }
    | { kind: 'header' }
    | { kind: 'season'; id: string }
    | { kind: 'episode'; seasonId: string; episodeId: string; control: EpisodeControl };

export type ShowBookmark = {
    seriesId: string;
    target: ShowTarget;
    scrollY: number;
    navScroll: { top: number; left: number };
};

export type Context = {
    seasons: readonly { id: string; episodeIds: readonly string[] | null }[];
    activeSeasonId: string;
    layout: 'sidebar' | 'rail';
    controls: readonly EpisodeControl[];
};

export type ShowBoundary = {
    kind: 'boundary';
    seasonId: string;
    edge: 'first' | 'last';
    control: EpisodeControl;
    step: -1 | 0 | 1;
};

export type ShowFocusResult = ShowTarget | ShowBoundary;

function visibleControl(control: EpisodeControl, context: Context): EpisodeControl {
    return context.controls.includes(control) ? control : context.controls.includes('title') ? 'title' : 'art';
}

export function enterShowSeason(
    context: Context,
    seasonId: string,
    edge: ShowBoundary['edge'],
    control: EpisodeControl,
    step: ShowBoundary['step']
): ShowFocusResult {
    const normalized = visibleControl(control, context);
    let index = context.seasons.findIndex(season => season.id === seasonId);
    while (index >= 0 && index < context.seasons.length) {
        const season = context.seasons[index];
        if (season.episodeIds === null) return { kind: 'boundary', seasonId: season.id, edge, control: normalized, step };
        const episodeId = edge === 'first' ? season.episodeIds[0] : season.episodeIds[season.episodeIds.length - 1];
        if (episodeId !== undefined) return { kind: 'episode', seasonId: season.id, episodeId, control: normalized };
        if (step === 0) break;
        index += step;
    }
    return { kind: 'season', id: seasonId };
}

export function moveShowFocus(from: ShowTarget, direction: Direction, context: Context): ShowFocusResult {
    switch (from.kind) {
        case 'header':
            return direction === 'ArrowDown' ? { kind: 'back' } : from;
        case 'back': {
            if (direction === 'ArrowUp') return { kind: 'header' };
            const active = context.seasons.find(season => season.id === context.activeSeasonId) || context.seasons[0];
            return direction === 'ArrowDown' && active ? { kind: 'season', id: active.id } : from;
        }
        case 'season': {
            const index = context.seasons.findIndex(season => season.id === from.id);
            if (index < 0) return from;
            if (context.layout === 'rail') {
                if (direction === 'ArrowUp') return { kind: 'back' };
                if (direction === 'ArrowDown') return enterShowSeason(context, from.id, 'first', 'art', 0);
                const adjacent = context.seasons[index + (direction === 'ArrowLeft' ? -1 : 1)];
                return adjacent ? { kind: 'season', id: adjacent.id } : from;
            }
            if (direction === 'ArrowLeft') return from;
            if (direction === 'ArrowRight') return enterShowSeason(context, from.id, 'first', 'art', 0);
            if (direction === 'ArrowUp' && index === 0) return { kind: 'back' };
            const adjacent = context.seasons[index + (direction === 'ArrowUp' ? -1 : 1)];
            return adjacent ? { kind: 'season', id: adjacent.id } : from;
        }
        case 'episode': {
            const control = visibleControl(from.control, context);
            const current: ShowTarget = { ...from, control };
            if (direction === 'ArrowLeft') {
                if (from.control === 'art') return { kind: 'season', id: from.seasonId };
                return { ...from, control: from.control === 'play' ? 'title' : 'art' };
            }
            if (direction === 'ArrowRight') {
                if (control === 'art') return { ...from, control: 'title' };
                return control === 'title' && context.controls.includes('play') ? { ...from, control: 'play' } : current;
            }
            const seasonIndex = context.seasons.findIndex(season => season.id === from.seasonId);
            const ids = context.seasons[seasonIndex]?.episodeIds;
            const episodeIndex = ids?.indexOf(from.episodeId) ?? -1;
            if (seasonIndex < 0 || episodeIndex < 0) return { kind: 'season', id: from.seasonId };
            const step = direction === 'ArrowUp' ? -1 : 1;
            const adjacentId = ids?.[episodeIndex + step];
            if (adjacentId !== undefined) return { ...from, episodeId: adjacentId, control };
            const adjacentSeason = context.seasons[seasonIndex + step];
            const result = adjacentSeason ? enterShowSeason(context, adjacentSeason.id, step === -1 ? 'last' : 'first', control, step) : null;
            if (result && result.kind !== 'season') return result;
            return step === -1 ? { kind: 'season', id: from.seasonId } : current;
        }
    }
}
