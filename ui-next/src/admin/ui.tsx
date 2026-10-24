import { useEffect, useRef, useState } from 'preact/hooks';
import type { JellyfinSession } from './types';
import { sessionControls } from './admin-state';
import { changedFields, displayValue, getPath, parseInput, setPath, type FieldDef } from './server-settings';
import { t } from '../i18n';

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
    return <input class="ad-search" value={value} onInput={e => onInput((e.target as HTMLInputElement).value)} placeholder={placeholder || t('Search…')} aria-label={placeholder || t('Search')} />;
}

export function FilterPills({ options, value, onPick }: { options: string[]; value: string; onPick: (v: string) => void }) {
    return <div class="ad-chips" role="group">{options.map(o => <button key={o} type="button" class={`ad-chip${value === o ? ' on' : ''}`} aria-pressed={value === o} onClick={() => onPick(o)}>{t(o)}</button>)}</div>;
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
        catch (e) { setError(e instanceof Error ? e.message : t('The operation failed.')); }
        finally { setPending(false); locked.current = false; }
    };
    if (!arm) return <button disabled={pending || busy} class={`ad-btn${tone === 'danger' ? ' danger' : ''}`} onClick={() => { setArm(true); setError(''); }}>{busy ? t('Working…') : label}</button>;
    return <span class="ad-inline-confirm">
        <button disabled={pending || busy} aria-label={t('Confirm {0}', label)} class={`ad-btn ${tone === 'danger' ? 'danger fill' : ''}`} onClick={confirm}>{pending || busy ? t('Working…') : confirmLabel || t('Confirm')}</button>
        <button disabled={pending || busy} class="ad-btn" onClick={() => setArm(false)}>{t('Cancel')}</button>
        {error && <span role="alert" class="ad-error">{error}</span>}
    </span>;
}

export interface SessionControlApi {
    stopPlayback(id: string): Promise<void>;
    pausePlayback(id: string): Promise<void>;
    resumePlayback(id: string): Promise<void>;
    sendSessionMessage(id: string, text: string): Promise<void>;
}

export function SessionControls({ session, api, onChanged }: { session: JellyfinSession; api: SessionControlApi; onChanged?: () => void | Promise<void> }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [composing, setComposing] = useState(false);
    const [text, setText] = useState('');
    const controls = sessionControls(session);
    if (!session.NowPlayingItem) return null;
    if (!controls.canControl) return <span class="ad-note">{controls.reason}</span>;
    const run = async (action: () => Promise<void>) => {
        setBusy(true); setError('');
        try { await action(); await onChanged?.(); }
        catch (e) { setError(e instanceof Error ? e.message : t('The session did not accept the command.')); }
        finally { setBusy(false); }
    };
    return <span class="ad-flex ad-session-controls">
        <button class="ad-btn" disabled={busy} onClick={() => void run(() => controls.isPaused ? api.resumePlayback(session.Id) : api.pausePlayback(session.Id))}>{controls.isPaused ? t('Resume') : t('Pause')}</button>
        {composing
            ? <form class="ad-flex" onSubmit={e => { e.preventDefault(); if (!text.trim()) return; void run(async () => { await api.sendSessionMessage(session.Id, text.trim()); setText(''); setComposing(false); }); }}>
                <input class="ad-form-input" aria-label={`Message to ${session.UserName || t('session')}`} value={text} maxLength={500} onInput={e => setText(e.currentTarget.value)} />
                <button class="ad-btn" type="submit" disabled={busy || !text.trim()}>{t('Send')}</button>
                <button class="ad-btn" type="button" onClick={() => setComposing(false)}>{t('Cancel')}</button>
            </form>
            : <button class="ad-btn" disabled={busy} onClick={() => setComposing(true)}>{t('Message')}</button>}
        <ConfirmButton label={t('Stop playback')} tone="danger" busy={busy} onConfirm={async () => { await api.stopPlayback(session.Id); await onChanged?.(); }} />
        {error && <span role="alert" class="ad-error">{error}</span>}
    </span>;
}

export function Tabs({ tabs, value, onPick }: { tabs: string[]; value: string; onPick: (v: string) => void }) {
    return <div class="ad-tabs" role="group">{tabs.map(tab => <button key={tab} type="button" class={`ad-tab${value === tab ? ' on' : ''}`} aria-pressed={value === tab} onClick={() => onPick(tab)}>{t(tab)}</button>)}</div>;
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
        {query === undefined && <div class="ad-toolbar"><SearchInput value={internalQuery} onInput={setQuery} placeholder={t('Search rows…')} /></div>}
        <div class="ad-table-wrap"><table class="ad-table"><thead><tr>{columns.map(c =>
            <th key={c.key} aria-sort={selectedSort === c.key ? ascending ? 'ascending' : 'descending' : undefined}>{c.label && <button class="ad-sort" onClick={() => pickSort(c.key)} aria-label={t('Sort by {0}', c.label)}>{c.label}{selectedSort === c.key ? (ascending === false ? ' ↓' : ' ↑') : ''}</button>}</th>
        )}</tr></thead><tbody>{ordered.length === 0 ? <tr><td colSpan={columns.length}><Empty muted>{empty}</Empty></td></tr> : visible.map(row => <tr key={getKey(row)}>{columns.map(c => <td key={c.key}>{c.value(row)}</td>)}</tr>)}</tbody></table></div>
        {ordered.length > 20 && <div class="ad-pagination"><button class="ad-btn" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>{t('Previous')}</button><span>{t('{0}–{1} of {2}', currentPage * 20 + 1, Math.min((currentPage + 1) * 20, ordered.length), ordered.length)}</span><button class="ad-btn" disabled={(currentPage + 1) * 20 >= ordered.length} onClick={() => setPage(currentPage + 1)}>{t('Next')}</button></div>}
    </>;
}

/** Renders declarative setting fields against a draft; invalid input is reported per field and kept out of the draft. */
export function SettingsFields({ fields, draft, onChange, options = {}, disabled }: {
    fields: FieldDef[]; draft: Record<string, any>; onChange: (next: Record<string, any>) => void;
    options?: Record<string, Array<[string, string]>>; disabled?: boolean;
}) {
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [texts, setTexts] = useState<Record<string, string>>({});
    const update = (field: FieldDef, input: string | boolean) => {
        if (typeof input === 'string') setTexts(old => ({ ...old, [field.key]: input }));
        const parsed = parseInput(field, input);
        if ('error' in parsed) { setErrors(old => ({ ...old, [field.key]: parsed.error })); return; }
        setErrors(old => { const next = { ...old }; delete next[field.key]; return next; });
        onChange(setPath(draft, field.key, parsed.value));
    };
    return <div class="ad-form-grid">{fields.map(field => {
        const stored = getPath(draft, field.key);
        const shown = field.key in texts && errors[field.key] ? texts[field.key] : displayValue(field, stored);
        const id = `setting-${field.key.replace(/\W/g, '-')}`;
        const choices = options[field.key] || (field.values || []).map(value => Array.isArray(value) ? value : [ value, value ] as [string, string]);
        const control = field.kind === 'boolean'
            ? <label class="ad-toggle-row"><span>{shown ? t('Enabled') : t('Disabled')}</span><input id={id} type="checkbox" checked={shown === true} disabled={disabled} onChange={e => update(field, e.currentTarget.checked)} /></label>
            : field.kind === 'select'
                ? <select id={id} class="ad-form-input" value={String(shown)} disabled={disabled} onChange={e => update(field, e.currentTarget.value)}>{!choices.some(([value]) => value === String(shown)) && <option value={String(shown)}>{String(shown) || t('Not set')}</option>}{choices.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select>
                : field.kind === 'textarea' || (field.kind === 'list' && field.lines)
                    ? <textarea id={id} class="ad-form-input" rows={4} value={String(shown)} disabled={disabled} onInput={e => update(field, e.currentTarget.value)} />
                    : <div class={field.unit ? 'ad-input-unit' : undefined}><input id={id} class="ad-form-input" type={field.kind === 'number' ? 'number' : field.kind === 'password' ? 'password' : 'text'} min={field.min} max={field.max} step={field.step} value={String(shown)} disabled={disabled} autoComplete={field.kind === 'password' ? 'new-password' : undefined} onInput={e => update(field, e.currentTarget.value)} />{field.unit && <span class="ad-unit">{field.unit}</span>}</div>;
        return <div class="ad-form-field" key={field.key}>
            <label class="ad-form-label" for={id}>{t(field.label)}</label>
            {control}
            {field.note && <span class="ad-note">{t(field.note)}</span>}
            {errors[field.key] && <span role="alert" class="ad-error">{errors[field.key]}</span>}
        </div>;
    })}</div>;
}

export interface ConfigApi {
    getConfig<T extends Record<string, unknown> = Record<string, any>>(path: string): Promise<T>;
    saveConfigPatch(path: string, patch: Record<string, unknown>): Promise<Record<string, any>>;
}

/** Loads a named configuration document, edits a field subset and saves only changed fields onto a fresh copy. */
export function ConfigSection({ api, path, title, fields, options, note, validate, onSaved }: {
    api: ConfigApi; path: string; title: string; fields: FieldDef[]; options?: Record<string, Array<[string, string]>>; note?: string;
    validate?: (draft: Record<string, any>) => string; onSaved?: (saved: Record<string, any>) => void;
}) {
    const [saved, setSaved] = useState<Record<string, any> | null>(null);
    const [draft, setDraft] = useState<Record<string, any>>({});
    const [loadError, setLoadError] = useState('');
    const [message, setMessage] = useState('');
    const [revision, setRevision] = useState(0);
    useEffect(() => {
        let active = true;
        setSaved(null); setLoadError('');
        api.getConfig(path).then(config => { if (active) { setSaved(config); setDraft(config); } })
            .catch(e => { if (active) setLoadError(e instanceof Error ? e.message : t('Settings could not be loaded.')); });
        return () => { active = false; };
    }, [api, path]);
    const patch = saved ? changedFields(fields, saved, draft) : {};
    const dirty = Object.keys(patch).length > 0;
    return <Card title={title}>
        {loadError ? <p role="alert" class="ad-error">{t('{0} Settings cannot be saved until they load.', loadError)}</p> : !saved ? <p role="status" class="ad-note">{t('Loading settings…')}</p> : <>
            <SettingsFields key={revision} fields={fields} draft={draft} onChange={next => { setDraft(next); setMessage(''); }} options={options} />
            {note && <p class="ad-note">{note}</p>}
            <div class="ad-flex">
                {!dirty ? <button class="ad-btn" disabled>{t('Save changes')}</button> : <ConfirmButton label={t('Save changes')} onConfirm={async () => {
                    const problem = validate?.(draft);
                    if (problem) throw new Error(problem);
                    const next = await api.saveConfigPatch(path, patch);
                    setSaved(next); setDraft(next); setRevision(value => value + 1); setMessage(t('Settings saved.')); onSaved?.(next);
                }} />}
                <button class="ad-btn" disabled={!dirty} onClick={() => { setDraft(saved); setRevision(value => value + 1); setMessage(''); }}>{t('Discard')}</button>
            </div>
            {message && <p role="status" class="ad-note">{message}</p>}
        </>}
    </Card>;
}
