import { h } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JellyfinApi } from './api';
import type { MediaItem, RecommendationGroup } from './types';

export interface HomeFeedBlock {
    id: string;
    kind: 'rail' | 'spotlight';
    title: string;
    subtitle?: string;
    items: MediaItem[];
    spotlightType?: 'collection' | 'director' | 'vault' | 'milestone';
    description?: string;
}

export function buildHomeFeedBlocks(resume: MediaItem[], latest: MediaItem[], groups: RecommendationGroup[], collections: MediaItem[] = [], onNow: MediaItem[] = [], vaultCandidates: MediaItem[] = [], exploreItems: MediaItem[] = []): HomeFeedBlock[] {
    const rails: HomeFeedBlock[] = [];
    if (resume.length) rails.push({ id: 'continue', kind: 'rail', title: 'Continue watching', subtitle: 'PICK UP WHERE YOU LEFT OFF', items: resume });
    if (latest.length) rails.push({ id: 'latest', kind: 'rail', title: 'Just added', subtitle: 'FRESH FROM YOUR LIBRARY', items: latest });
    if (onNow.length) rails.push({ id: 'on-now', kind: 'rail', title: 'On Now', subtitle: 'LIVE TV', items: onNow });

    groups.forEach((group, index) => {
        const items = (group.Items || []).filter(item => item.Id);
        if (!items.length) return;
        const baseline = group.BaselineItemName;
        const title = group.RecommendationType === 0 ? `Because you watched ${baseline || ''}`
            : group.RecommendationType === 1 ? `Because you liked ${baseline || ''}`
                : group.RecommendationType === 2 || group.RecommendationType === 4 ? `Directed by ${baseline || 'your favorites'}`
                    : group.RecommendationType === 3 || group.RecommendationType === 5 ? `Starring ${baseline || 'your favorites'}`
                        : `Recommended for you`;
        rails.push({ id: `recommendation-${index}`, kind: 'rail', title, subtitle: 'PERSONALIZED FOR YOU', items: items.slice(0, 24) });
    });

    const knownIds = new Set([ ...resume, ...latest, ...onNow, ...groups.flatMap(group => group.Items || []) ].map(item => item.Id));
    const distinctExplore = exploreItems.filter(item => item.Id && !knownIds.has(item.Id));
    for (let offset = 0; offset < distinctExplore.length; offset += 24) {
        const page = distinctExplore.slice(offset, offset + 24);
        if (page.length) rails.push({ id: `explore-${offset}`, kind: 'rail', title: offset ? 'More from your library' : 'Explore your library', subtitle: 'MORE TO DISCOVER', items: page });
    }

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
    return result;
}

export function HomeFeed({ blocks, api, onSelect, onPlay, onNeedMore, hasMore, loadingMore }: {
    blocks: HomeFeedBlock[];
    api: JellyfinApi | null;
    onSelect: (item: MediaItem) => void;
    onPlay: (item: MediaItem) => void;
    onNeedMore: () => void;
    hasMore: boolean;
    loadingMore: boolean;
}) {
    const [ activeBlock, setActiveBlock ] = useState(0);
    const [ heights, setHeights ] = useState<Record<string, number>>({});
    const railOffsets = useRef<Record<string, number>>({});
    const container = useRef<HTMLDivElement>(null);
    const previousBlocks = useRef(blocks);
    const activeRef = useRef(activeBlock);
    const paging = useRef({ hasMore, loadingMore, onNeedMore });
    const previousId = previousBlocks.current[activeBlock]?.id;
    const matchingIndex = previousBlocks.current === blocks ? activeBlock : blocks.findIndex(block => block.id === previousId);
    const renderedActiveBlock = Math.max(0, matchingIndex);
    activeRef.current = renderedActiveBlock;
    paging.current = { hasMore, loadingMore, onNeedMore };
    const windowRange = useMemo(() => ({ start: Math.max(0, renderedActiveBlock - 1), end: Math.min(blocks.length, renderedActiveBlock + 2) }), [ renderedActiveBlock, blocks.length ]);
    useLayoutEffect(() => {
        if (previousBlocks.current === blocks) return;
        previousBlocks.current = blocks;
        setActiveBlock(renderedActiveBlock);
    }, [ blocks, renderedActiveBlock ]);

    const measure = useCallback((entry: ResizeObserverEntry) => {
        const node = entry.target as HTMLElement;
        const id = node.dataset.blockId;
        if (!id || node.dataset.placeholder) return;
        const height = Math.ceil(node.getBoundingClientRect().height + (parseFloat(getComputedStyle(node).marginTop) || 0) + (parseFloat(getComputedStyle(node).marginBottom) || 0));
        setHeights(current => current[id] === height ? current : { ...current, [id]: height });
    }, []);

    useEffect(() => {
        const root = container.current;
        if (!root) return;
        let focusFrame = 0;
        const onKey = (event: KeyboardEvent) => {
            const target = event.target instanceof HTMLElement ? event.target : null;
            const block = target?.closest<HTMLElement>('[data-block-index]');
            if (block && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                const nextIndex = Number(block.dataset.blockIndex) + (event.key === 'ArrowDown' ? 1 : -1);
                const nextBlock = root.querySelector<HTMLElement>(`[data-block-index="${nextIndex}"]`);
                if (nextBlock) {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    if (focusFrame) window.cancelAnimationFrame(focusFrame);
                    setActiveBlock(nextIndex);
                    const headerBottom = document.querySelector('.topbar')?.getBoundingClientRect().bottom || 0;
                    window.scrollTo(0, window.scrollY + nextBlock.getBoundingClientRect().top - headerBottom - 16);
                    // The adjacent block may still be a virtualized placeholder.
                    focusFrame = window.requestAnimationFrame(() => {
                        focusFrame = 0;
                        root.querySelector<HTMLElement>(`[data-block-index="${nextIndex}"] .home-spotlight-primary, [data-block-index="${nextIndex}"] .home-feed-rail-items [data-focusable="true"]`)?.focus();
                    });
                    return;
                }
                if (nextIndex === blocks.length && paging.current.hasMore) {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    if (!paging.current.loadingMore) paging.current.onNeedMore();
                    return;
                }
            }
            const current = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-spotlight-id]');
            if (!current) return;
            const actions = Array.from(current.querySelectorAll<HTMLElement>('.home-spotlight-actions [data-focusable="true"]'));
            if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && actions.includes(event.target as HTMLElement)) {
                // Clamp travel to the row. Falling through at either end
                // flings focus to a distant rail card, which reads as losing
                // the spotlight. Up and Down still leave the row freely.
                const enabled = actions.filter(button => !(button as HTMLButtonElement).disabled);
                const at = enabled.indexOf(event.target as HTMLElement);
                const step = event.key === 'ArrowRight' ? 1 : -1;
                const next = enabled[Math.max(0, Math.min(enabled.length - 1, at < 0 ? (step > 0 ? 0 : enabled.length - 1) : at + step))];
                event.preventDefault();
                event.stopImmediatePropagation();
                if (next && next !== event.target) next.focus();
                return;
            }
        };
        root.addEventListener('keydown', onKey, true);
        return () => {
            root.removeEventListener('keydown', onKey, true);
            if (focusFrame) window.cancelAnimationFrame(focusFrame);
        };
    }, [blocks.length]);

    useEffect(() => {
        const root = container.current;
        if (!root || !blocks.length) return;
        let frame = 0;
        const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(entries => entries.forEach(measure)) : undefined;
        const updateActiveBlock = () => {
            frame = 0;
            const viewportCenter = window.innerHeight / 2;
            let closestIndex = activeRef.current;
            let closestDistance = Number.POSITIVE_INFINITY;
            root.querySelectorAll<HTMLElement>('[data-block-index]').forEach(node => {
                const rect = node.getBoundingClientRect();
                const center = rect.top + rect.height / 2;
                const distance = Math.abs(center - viewportCenter);
                if (distance < closestDistance) {
                    closestDistance = distance;
                    closestIndex = Number(node.dataset.blockIndex);
                }
            });
            if (closestIndex !== activeRef.current) {
                activeRef.current = closestIndex;
                setActiveBlock(closestIndex);
            }
        };
        const scheduleActiveUpdate = () => {
            if (!frame) frame = window.requestAnimationFrame(updateActiveBlock);
        };
        const attachResize = () => root.querySelectorAll<HTMLElement>('[data-block-index]').forEach(node => resizeObserver?.observe(node));
        attachResize();
        const mutations = typeof MutationObserver !== 'undefined' ? new MutationObserver(() => {
            attachResize();
            scheduleActiveUpdate();
        }) : undefined;
        mutations?.observe(root, { childList: true });
        window.addEventListener('scroll', scheduleActiveUpdate, { passive: true });
        window.addEventListener('resize', scheduleActiveUpdate);
        scheduleActiveUpdate();
        return () => {
            window.removeEventListener('scroll', scheduleActiveUpdate);
            window.removeEventListener('resize', scheduleActiveUpdate);
            if (frame) window.cancelAnimationFrame(frame);
            resizeObserver?.disconnect();
            mutations?.disconnect();
        };
    }, [ blocks.length, measure, windowRange.start, windowRange.end ]);

    useEffect(() => {
        const sentinel = container.current?.querySelector('.home-feed-sentinel');
        if (!sentinel || !hasMore || loadingMore || typeof IntersectionObserver === 'undefined') return;
        // Remote users navigate by focus, not scroll position, so the feed
        // can sit pinned at its rendered edge while the sentinel is still
        // far below. Pull early so the next page is usually rendered before
        // focus runs out of targets.
        const observer = new IntersectionObserver(entries => {
            if (entries.some(entry => entry.isIntersecting)) onNeedMore();
        }, { rootMargin: '2000px 0px' });
        observer.observe(sentinel);
        return () => observer.disconnect();
    }, [ hasMore, loadingMore, onNeedMore, blocks.length ]);

    if (!blocks.length) return null;
    return <div class="home-feed-blocks" ref={container}>
        {blocks.map((block, index) => {
            const rendered = index >= windowRange.start && index < windowRange.end;
            const fallbackHeight = block.kind === 'spotlight' ? Math.min(500, Math.max(360, window.innerHeight * .42)) + 36 : 372;
            const height = heights[block.id] || fallbackHeight;
            return rendered
                ? <div key={block.id} data-block-index={index} data-block-id={block.id} class="home-feed-block">
                    {block.kind === 'rail'
                        ? <HomeRail block={block} api={api} onSelect={onSelect} initialScrollLeft={railOffsets.current[block.id] || 0} onScrollLeft={value => { railOffsets.current[block.id] = value; }} />
                        : <Spotlight block={block} api={api} onSelect={onSelect} onPlay={onPlay} nextBlockId={blocks[index + 1]?.id} />}
                </div>
                : <div key={block.id} data-block-index={index} data-block-id={block.id} data-placeholder="true" class="home-feed-block-placeholder" style={{ height: `${height}px` }} />;
        })}
        <div class="home-feed-sentinel" aria-hidden="true" />
        {loadingMore && <div class="home-feed-more-status" role="status"><span class="mini-spinner" aria-hidden="true" />Finding more to explore…</div>}
    </div>;
}

function HomeRail({ block, api, onSelect, initialScrollLeft, onScrollLeft }: { block: HomeFeedBlock; api: JellyfinApi | null; onSelect: (item: MediaItem) => void; initialScrollLeft: number; onScrollLeft: (value: number) => void }) {
    const rail = useRef<HTMLDivElement>(null);
    const [ canScrollLeft, setCanScrollLeft ] = useState(false);
    const [ canScrollRight, setCanScrollRight ] = useState(false);
    const restoring = useRef(true);
    const updateArrows = () => {
        const element = rail.current;
        if (!element) return;
        setCanScrollLeft(element.scrollLeft > 2);
        setCanScrollRight(element.scrollLeft + element.clientWidth < element.scrollWidth - 2);
        if (!restoring.current) onScrollLeft(element.scrollLeft);
    };
    useLayoutEffect(() => {
        restoring.current = true;
        if (rail.current) rail.current.scrollLeft = initialScrollLeft;
        updateArrows();
        const frame = window.requestAnimationFrame(() => {
            updateArrows();
            restoring.current = false;
        });
        return () => window.cancelAnimationFrame(frame);
    }, [ initialScrollLeft, block.id, block.items.length ]);
    return <section class="section-block home-feed-rail">
        <div class="section-heading home-feed-rail-heading"><div><p class="eyebrow">{block.subtitle}</p><h2>{block.title}</h2></div><div class="home-feed-rail-controls" aria-label={`${block.title} horizontal scrolling`}>
            <button data-focusable="true" type="button" aria-label={`Scroll ${block.title} left`} disabled={!canScrollLeft} onClick={() => rail.current?.scrollBy({ left: -Math.max(300, rail.current.clientWidth * .8), behavior: 'smooth' })}>‹</button>
            <button data-focusable="true" type="button" aria-label={`Scroll ${block.title} right`} disabled={!canScrollRight} onClick={() => rail.current?.scrollBy({ left: Math.max(300, rail.current.clientWidth * .8), behavior: 'smooth' })}>›</button>
        </div></div>
        <div ref={rail} class="home-feed-rail-items" onScroll={updateArrows}>{block.items.slice(0, 24).map(item => <HomeFeedCard key={item.Id} item={item} api={api} onSelect={onSelect} />)}</div>
    </section>;
}

function HomeFeedCard({ item, api, onSelect }: { item: MediaItem; api: JellyfinApi | null; onSelect: (item: MediaItem) => void }) {
    const liveProgram = Boolean(item.ChannelId || item.IsLive || item.Type === 'Program');
    const type = item.Type === 'Episode' || item.SeriesName || liveProgram ? 'landscape' : 'poster';
    const src = api ? api.imageUrl(item, 'Primary', type === 'landscape' ? 420 : 300, 80) : '';
    const progress = Math.max(0, Math.min(100, item.UserData?.PlayedPercentage || 0));
    const [ imageFailed, setImageFailed ] = useState(false);
    const hasImage = Boolean(src) && !imageFailed;
    const initials = item.Name.trim().split(/\s+/).slice(0, 2).map(word => word.charAt(0)).join('').toUpperCase();
    return <button data-focusable="true" class={`home-feed-card ${type}`} aria-label={`View ${item.Name}`} onClick={() => onSelect(item)}>
        <span class={`home-feed-card-art${hasImage ? '' : ' no-artwork'}${liveProgram ? ' live-artwork' : ''}`}>
            {hasImage
                ? <img src={src} alt="" loading="lazy" onError={() => setImageFailed(true)} />
                : <span class="home-feed-card-fallback" aria-hidden="true"><span class="home-feed-fallback-glow" /><span class="home-feed-fallback-icon">{liveProgram ? 'LIVE' : initials || 'J'}</span><span class="home-feed-fallback-label">{liveProgram ? item.ChannelName || 'ON NOW' : item.Type === 'Series' ? 'SERIES' : 'IN YOUR LIBRARY'}</span></span>}
            <span class="home-feed-card-overlay"><strong>{item.Name}</strong><small>{item.ProductionYear || item.SeriesName || 'In your library'}</small></span>
            {type === 'landscape' && progress > 0 && <i style={{ width: `${progress}%` }} />}
        </span>
    </button>;
}

function Spotlight({ block, api, onSelect, onPlay, nextBlockId }: {
    block: HomeFeedBlock;
    api: JellyfinApi | null;
    onSelect: (item: MediaItem) => void;
    onPlay: (item: MediaItem) => void;
    nextBlockId?: string;
}) {
    const item = block.items[0];
    const [ watchlisted, setWatchlisted ] = useState(item?.UserData?.IsFavorite === true);
    const [ savingWatchlist, setSavingWatchlist ] = useState(false);
    const image = item && api ? api.imageUrl(item, 'Backdrop', 1920, 85) || api.imageUrl(item, 'Primary', 960, 85) : '';
    const background = useRef<HTMLDivElement>(null);
    useEffect(() => () => {
        const imageNodes = background.current?.querySelectorAll('img') || [];
        imageNodes.forEach(node => { node.src = ''; });
        if (background.current) background.current.style.backgroundImage = 'none';
    }, []);
    const label = block.spotlightType === 'collection' ? 'COLLECTION SPOTLIGHT'
        : block.spotlightType === 'director' ? 'DIRECTOR FOCUS'
            : block.spotlightType === 'milestone' ? 'NEXT TV MILESTONE' : block.subtitle || 'SPOTLIGHT';
    const focusSpotlight = (event: FocusEvent) => {
        if (!document.documentElement.classList.contains('tv-client')) return;
        const target = event.target as HTMLElement;
        const spotlight = target.closest<HTMLElement>('.home-spotlight');
        if (!spotlight || !target.matches('.home-spotlight-actions [data-focusable="true"]')) return;
        window.scrollTo(0, window.scrollY + spotlight.getBoundingClientRect().top - (window.innerHeight - spotlight.offsetHeight) / 2);
    };
    return <section class={`home-spotlight home-spotlight-${block.spotlightType || 'discovery'}`} data-spotlight-id={block.id} onFocusIn={focusSpotlight}>
        <div ref={background} class="home-spotlight-background" style={image ? { backgroundImage: `url("${image}")` } : undefined} />
        <div class="home-spotlight-scrim" />
        <div class="home-spotlight-content">
            <p class="home-spotlight-eyebrow">{label}</p>
            <h2>{block.title}</h2>
            <div class="home-spotlight-metadata">
                {item?.ProductionYear && <span>{item.ProductionYear}</span>}
                {item?.ChildCount && <span>{item.ChildCount} titles</span>}
                {item?.CommunityRating && <span>★ {item.CommunityRating.toFixed(1)}</span>}
                {item?.MediaStreams?.some(stream => (stream.VideoRange || '').toUpperCase() === 'HDR') && <span>HDR</span>}
                {item?.UserData?.PlayedItemCount != null && item.UserData.UnplayedItemCount != null && <span>{item.UserData.PlayedItemCount} of {item.UserData.PlayedItemCount + item.UserData.UnplayedItemCount} watched</span>}
            </div>
            {block.description && <p class="home-spotlight-description">{block.description}</p>}
            <div class="home-spotlight-actions">
                {item && <button data-focusable="true" class="home-spotlight-primary" onClick={() => onPlay(item)}>{item.UserData?.PlaybackPositionTicks ? '▶ Resume' : '▶ Play'}</button>}
                {item && <button data-focusable="true" class="home-spotlight-secondary" disabled={savingWatchlist} onClick={() => {
                    if (!api || savingWatchlist) return;
                    setSavingWatchlist(true);
                    void api.setFavorite(item.Id, !watchlisted).then(() => setWatchlisted(value => !value)).catch(() => undefined).finally(() => setSavingWatchlist(false));
                }}>{watchlisted ? '✓ In Watchlist' : '＋ Watchlist'}</button>}
                {item && <button data-focusable="true" class="home-spotlight-details" onClick={() => onSelect(item)}>View details</button>}
            </div>
        </div>
        <span class="home-spotlight-next" data-next-block={nextBlockId} aria-hidden="true" />
    </section>;
}

function uniqueItems(items: MediaItem[]): MediaItem[] {
    const ids = new Set<string>();
    return items.filter(item => Boolean(item.Id) && !ids.has(item.Id) && Boolean(ids.add(item.Id)));
}
