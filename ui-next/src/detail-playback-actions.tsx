import { h } from 'preact';
import { ClapperboardIcon, HeartIcon } from '@hugeicons/core-free-icons';
import { t } from './i18n';

function ActionIcon({ icon, filled = false }: { icon: typeof HeartIcon; filled?: boolean }) {
    return <svg viewBox="0 0 24 24" width="22" height="22" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        {icon.map(([tag, attrs], index) => h(tag, { ...attrs, stroke: 'currentColor', strokeWidth: 1.5, key: String(attrs.key ?? index) }))}
    </svg>;
}

export function TrailerAction({ onPlay }: { onPlay: () => void }) {
    return <button data-focusable="true" data-detail-trailer="true" class="button secondary detail-trailer" type="button" onClick={onPlay}>
        <ActionIcon icon={ClapperboardIcon} /><span>{t('Watch trailer')}</span>
    </button>;
}

export function FavoriteHeart({ favorite, busy, onToggle }: { favorite: boolean; busy: boolean; onToggle: () => void }) {
    const label = favorite ? t('Remove from favorites') : t('Add to favorites');
    return <button data-focusable="true" class="button secondary detail-favorite" type="button" aria-label={label} title={label} aria-pressed={favorite} disabled={busy} onClick={onToggle}>
        <ActionIcon icon={HeartIcon} filled={favorite} />
    </button>;
}
