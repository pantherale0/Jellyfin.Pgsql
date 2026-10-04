import { useEffect, useRef, useState } from 'preact/hooks';
import type { JellyfinSession } from './types';

export function playbackMethod(session: JellyfinSession): string {
    const method = session.PlayState?.PlayMethod;
    if (method === 2 || method === 'DirectPlay') return 'Direct Play';
    if (method === 1 || method === 'DirectStream') return 'Remux';
    if (method === 0 || method === 'Transcode') return 'Transcode';
    if (session.TranscodingInfo?.IsVideoDirect === false || session.TranscodingInfo?.IsAudioDirect === false) return 'Transcode';
    if (session.TranscodingInfo?.IsVideoDirect === true && session.TranscodingInfo?.IsAudioDirect === true) return 'Remux';
    return 'Unknown';
}

export function usePersistentToggle(key: string, initial = false): [boolean, (value: boolean | ((old: boolean) => boolean)) => void] {
    const [value, setValue] = useState(() => {
        try { const saved = localStorage.getItem(`ui-next-admin:${key}`); return saved === null ? initial : saved === 'true'; } catch { return initial; }
    });
    const update = (next: boolean | ((old: boolean) => boolean)) => {
        setValue(old => {
            const value = typeof next === 'function' ? next(old) : next;
            try { localStorage.setItem(`ui-next-admin:${key}`, String(value)); } catch { /* storage optional */ }
            return value;
        });
    };
    return [value, update];
}

export function PageShell({ title, subtitle, actions, children }: {
    title: string; subtitle?: string; actions?: any; children: any;
}) {
    useRelativeClock();
    return <div class="ad-page">
        <div class="ad-page-head">
            <div class="ad-page-titlebar">
                <h1 class="ad-page-title">{title}</h1>
                {subtitle && <p class="ad-page-sub">{subtitle}</p>}
            </div>
            {actions && <div class="ad-page-actions">{actions}</div>}
        </div>
        {children}
    </div>;
}

export function Card({ title, actions, children, onClick }: { title?: string; actions?: any; children: any; onClick?: () => void }) {
    return <section class="ad-card" onClick={onClick}>
        {title && <div class="ad-card-head"><h3>{title}</h3>{actions && <div class="ad-card-actions">{actions}</div>}</div>}
        <div class="ad-card-body">{children}</div>
    </section>;
}

export function CollapsibleSection({ id, title, actions, children, defaultOpen = true, className = '' }: { id: string; title: string; actions?: any; children: any; defaultOpen?: boolean; className?: string }) {
    const [open, setOpen] = usePersistentToggle(`section:${id}`, defaultOpen);
    return <section class={`ad-collapsible ${className}`}>
        <div class="ad-collapsible-head">
            <button class="ad-collapse-toggle" aria-expanded={open} aria-controls={`admin-section-${id}`} onClick={() => setOpen(v => !v)}>
                <span class={`ad-chevron${open ? ' open' : ''}`} aria-hidden="true">›</span><span>{title}</span>
            </button>
            {actions && <div class="ad-card-actions">{actions}</div>}
        </div>
        {open && <div id={`admin-section-${id}`} class="ad-collapsible-body">{children}</div>}
    </section>;
}

export function StatusChip({ tone, children }: { tone: 'green' | 'amber' | 'red' | 'blue' | 'muted'; children: any }) {
    return <span class={`ad-st ${tone}`}>{children}</span>;
}

export function SearchInput({ value, onInput, placeholder }: { value: string; onInput: (v: string) => void; placeholder?: string }) {
    return <input class="ad-search" value={value} onInput={e => onInput((e.target as HTMLInputElement).value)} placeholder={placeholder || 'Search…'} aria-label={placeholder || 'Search'} />;
}

export function FilterPills({ options, value, onPick }: { options: string[]; value: string; onPick: (v: string) => void }) {
    return <div class="ad-chips">{options.map(o => <button key={o} class={`ad-chip${value === o ? ' on' : ''}`} onClick={() => onPick(o)}>{o}</button>)}</div>;
}

export function ConfirmButton({ label, onConfirm, confirmLabel, tone, busy }: {
    label: string; onConfirm: () => void | Promise<unknown>; confirmLabel?: string; tone?: 'danger' | 'default'; busy?: boolean;
}) {
    const [arm, setArm] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const locked = useRef(false);
    const confirm = async () => {
        if (locked.current || busy) return;
        locked.current = true; setPending(true); setError('');
        try { await onConfirm(); setArm(false); }
        catch (e) { setError(e instanceof Error ? e.message : 'The operation failed.'); }
        finally { setPending(false); locked.current = false; }
    };
    if (!arm) return <button disabled={pending || busy} class={`ad-btn${tone === 'danger' ? ' danger' : ''}`} onClick={() => { setArm(true); setError(''); }}>{busy ? 'Working…' : label}</button>;
    return <span class="ad-inline-confirm">
        <button disabled={pending || busy} aria-label={`Confirm ${label}`} class={`ad-btn ${tone === 'danger' ? 'danger fill' : ''}`} onClick={confirm}>{pending || busy ? 'Working…' : confirmLabel || 'Confirm'}</button>
        <button disabled={pending || busy} class="ad-btn" onClick={() => setArm(false)}>Cancel</button>
        {error && <span role="alert" class="ad-error">{error}</span>}
    </span>;
}

export function Tabs({ tabs, value, onPick }: { tabs: string[]; value: string; onPick: (v: string) => void }) {
    return <div class="ad-tabs">{tabs.map(t => <button key={t} class={`ad-tab${value === t ? ' on' : ''}`} onClick={() => onPick(t)}>{t}</button>)}</div>;
}

export function timeAgo(d?: string): string {
    if (!d) return '—';
    try {
        const diff = Date.now() - new Date(d).getTime();
        const s = Math.floor(diff / 1000);
        if (s < 60) return s + 's ago';
        const m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
        const h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
        return Math.floor(h / 24) + 'd ago';
    } catch { return d; }
}

export function useRelativeClock(intervalMs = 30000): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), intervalMs); return () => window.clearInterval(timer); }, [intervalMs]);
    return now;
}

export function fmtDate(d?: string): string {
    if (!d) return '—';
    try { return new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return d; }
}

export function Empty({ children, muted }: { children: any; muted?: boolean }) {
    return <p class={`ad-empty${muted ? ' muted' : ''}`}>{children}</p>;
}

export function InfoRow({ k, v }: { k: string; v: any }) {
    return <div class="ad-info"><span class="ad-info-k">{k}</span><span class="ad-info-v">{v}</span></div>;
}

function cellText(value: any): string {
    if (value == null || typeof value === 'boolean') return '';
    if (Array.isArray(value)) return value.map(cellText).join(' ');
    if (typeof value === 'object') return cellText(value.props?.children);
    return String(value);
}

export function DataTable<T>({ rows, columns, getKey, empty, query, sortKey, sortAscending, onSort }: {
    rows: T[];
    columns: Array<{ key: string; label: string; value: (row: T) => any; searchValue?: (row: T) => string }>;
    getKey: (row: T) => string;
    empty: string;
    query?: string;
    sortKey?: string;
    sortAscending?: boolean;
    onSort?: (key: string) => void;
}) {
    const [internalQuery, setQuery] = useState('');
    const [internalSort, setSort] = useState('');
    const [internalAscending, setAscending] = useState(true);
    const [page, setPage] = useState(0);
    const selectedSort = sortKey ?? internalSort;
    const ascending = sortAscending ?? internalAscending;
    const needle = (query ?? internalQuery).trim().toLowerCase();
    useEffect(() => setPage(0), [needle, selectedSort, ascending]);
    const shown = rows.filter(row => !needle || columns.some(c => (c.searchValue?.(row) ?? cellText(c.value(row))).toLowerCase().includes(needle)));
    const ordered = selectedSort ? shown.slice().sort((a, b) => {
        const col = columns.find(c => c.key === selectedSort);
        const av = col?.searchValue?.(a) ?? cellText(col?.value(a));
        const bv = col?.searchValue?.(b) ?? cellText(col?.value(b));
        const cmp = av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' });
        return ascending === false ? -cmp : cmp;
    }) : shown;
    const currentPage = Math.min(page, Math.max(0, Math.ceil(ordered.length / 20) - 1));
    const visible = ordered.slice(currentPage * 20, currentPage * 20 + 20);
    const pickSort = (key: string) => {
        if (onSort) onSort(key);
        else { setSort(key); setAscending(key === internalSort ? !internalAscending : true); }
    };
    return <>
        {query === undefined && <div class="ad-toolbar"><SearchInput value={internalQuery} onInput={setQuery} placeholder="Search rows…" /></div>}
        <div class="ad-table-wrap"><table class="ad-table"><thead><tr>{columns.map(c =>
            <th key={c.key} aria-sort={selectedSort === c.key ? ascending ? 'ascending' : 'descending' : undefined}>{c.label && <button class="ad-sort" onClick={() => pickSort(c.key)} aria-label={`Sort by ${c.label}`}>{c.label}{selectedSort === c.key ? (ascending === false ? ' ↓' : ' ↑') : ''}</button>}</th>
        )}</tr></thead><tbody>{ordered.length === 0 ? <tr><td colSpan={columns.length}><Empty muted>{empty}</Empty></td></tr> : visible.map(row => <tr key={getKey(row)}>{columns.map(c => <td key={c.key}>{c.value(row)}</td>)}</tr>)}</tbody></table></div>
        {ordered.length > 20 && <div class="ad-pagination"><button class="ad-btn" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>Previous</button><span>{currentPage * 20 + 1}–{Math.min((currentPage + 1) * 20, ordered.length)} of {ordered.length}</span><button class="ad-btn" disabled={(currentPage + 1) * 20 >= ordered.length} onClick={() => setPage(currentPage + 1)}>Next</button></div>}
    </>;
}
