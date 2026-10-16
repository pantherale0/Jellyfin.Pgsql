import { episodeCode, formatClock, isAiring } from './live-model';
import type { MediaItem } from './types';
import { t } from './i18n';

export function mediaKind(item: MediaItem): { label: string; detail: string; live: boolean } | null {
    const liveProgram = Boolean(item.ChannelId || item.IsLive || item.Type === 'Program');
    if (liveProgram) {
        const now = Date.now();
        if (isAiring(item, now)) return { label: t('Live'), detail: item.ChannelName || '', live: true };
        if (item.StartDate) {
            const start = Date.parse(item.StartDate);
            if (Number.isFinite(start)) return { label: formatClock(start), detail: item.ChannelName || '', live: false };
        }
        return { label: t('Live TV'), detail: item.ChannelName || '', live: false };
    }
    if (item.Type === 'Episode' || item.SeriesId) {
        const code = episodeCode(item);
        return { label: code || t('Episode'), detail: item.SeriesName || (item.ProductionYear ? String(item.ProductionYear) : ''), live: false };
    }
    const detail = item.ProductionYear ? String(item.ProductionYear) : '';
    switch (item.Type) {
        case 'Series': return { label: t('Series'), detail, live: false };
        case 'Movie': return { label: t('Movie'), detail, live: false };
        case 'BoxSet': return { label: t('Collection'), detail, live: false };
        case 'Person': return { label: t('Person'), detail, live: false };
        case 'TvChannel': return { label: t('Channel'), detail, live: false };
        case 'MusicAlbum':
        case 'MusicArtist':
        case 'Audio': return { label: t('Music'), detail, live: false };
        default: return item.Type ? { label: item.Type, detail, live: false } : (detail ? { label: '', detail, live: false } : null);
    }
}

export function describeCard(item: MediaItem): string | null {
    const kind = mediaKind(item);
    const parts = [ kind?.label, kind?.detail ].filter((part): part is string => Boolean(part));
    const progress = item.UserData?.PlayedPercentage;
    if (progress !== undefined && progress > 0 && progress < 100) parts.push(`Resume ${Math.round(progress)} percent`);
    else if (item.UserData?.Played) parts.push('Played');
    return parts.length ? parts.join(' · ') : null;
}
