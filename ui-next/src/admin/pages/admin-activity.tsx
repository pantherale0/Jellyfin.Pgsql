import { useCallback, useEffect, useState } from 'preact/hooks';
import type { AdminApi } from '../admin-api';
import type { ServerActivityEntry } from '../types';
import { PageShell, Card, FilterPills, StatusChip, Empty, timeAgo, SearchInput } from '../ui';
import { ACTIVITY_SEVERITIES, activitySeverityParam, isErrorSeverity } from '../admin-state';
import { t } from '../../i18n';

export function AdminActivity({ adminApi: api }: { adminApi: AdminApi }) {
    const [items, setItems] = useState<ServerActivityEntry[]>([]);
    const [type, setType] = useState('All');
    const [sev, setSev] = useState('All');
    const [search, setSearch] = useState('');
    const [range, setRange] = useState('All time');
    const [limit, setLimit] = useState(50);
    const [page, setPage] = useState(0);
    const [total, setTotal] = useState(0);
    const [username, setUsername] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const load = useCallback(async () => {
        setLoading(true); setError('');
        const filters: Record<string, string> = {};
        if (range !== 'All time') filters.minDate = new Date(Date.now() - (range === '24 hours' ? 1 : 7) * 86400000).toISOString();
        const severity = activitySeverityParam(sev);
        if (severity) filters.severity = severity;
        if (username.trim()) filters.username = username.trim();
        try { const r = await api.getActivityLog(page * 50, 50, filters); setItems(r.Items || []); setTotal(r.TotalRecordCount || 0); }
        catch (e) { setError(e instanceof Error ? e.message : t('Activity request failed.')); }
        finally { setLoading(false); }
    }, [api, page, range, sev, username]);
    useEffect(() => { const timer = window.setTimeout(load, 250); return () => window.clearTimeout(timer); }, [load]);
    useEffect(() => setPage(0), [range, sev, username]);

    const classify = (a: ServerActivityEntry): string => {
        const t = (a.Type || '').toLowerCase(); const n = (a.Name || '').toLowerCase();
        if (t.includes('auth') || n.includes('authenticated') || n.includes('login')) return 'Auth';
        if (t.includes('playback') || n.includes('playback') || n.includes('play ') || n.includes('stream')) return 'Playback';
        if (t.includes('taste') || n.includes('taste')) return 'Taste';
        if (t.includes('livetv') || n.includes('live')) return 'Live TV';
        if (n.includes('plugin') || n.includes('install') || n.includes('update')) return 'Admin';
        return 'System';
    };

    const filtered = items.filter(a => {
        if (type !== 'All' && classify(a) !== type) return false;
        if (sev !== 'All' && a.Severity !== sev) return false;
        if (search && !`${a.Name || ''} ${a.Overview || ''} ${a.ShortOverview || ''} ${a.UserId || ''} ${a.Type || ''}`.toLowerCase().includes(search.toLowerCase())) return false;
        if (range !== 'All time' && a.Date) {
            const age = Date.now() - new Date(a.Date).getTime();
            if (range === '24 hours' && age > 86400000) return false;
            if (range === '7 days' && age > 7 * 86400000) return false;
        }
        return true;
    });

    const types = ['All', 'Auth', 'Playback', 'System', 'Taste', 'Live TV', 'Admin'];
    const bucket = (date?: string) => {
        const time = date ? Date.parse(date) : NaN;
        if (!Number.isFinite(time)) return 'Undated';
        const today = new Date(); today.setHours(0,0,0,0);
        const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
        const week = new Date(today); week.setDate(today.getDate() - 7);
        return time >= today.getTime() ? 'Today' : time >= yesterday.getTime() ? 'Yesterday' : time >= week.getTime() ? 'Earlier this week' : 'Earlier';
    };
    const exportCsv = () => {
        const quote = (v: string) => `"${(/^[=+\-@\t\r]/.test(v) ? "'" + v : v).replace(/"/g, '""')}"`;
        const csv = [['Date', 'Severity', 'Type', 'User', 'Description'], ...filtered.map(a => [a.Date || '', a.Severity || '', classify(a), a.UserId || '', a.Name || a.Overview || a.ShortOverview || ''])]
            .map(row => row.map(v => quote(String(v))).join(',')).join('\r\n');
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'jellyfin-activity.csv'; anchor.click(); URL.revokeObjectURL(url);
    };

    return <PageShell title={t('Activity')} subtitle={t('Unified event stream')} actions={<button class="ad-btn" onClick={load}>{t('Refresh')}</button>}>
        <Card title={t('Events')}>
            <div class="ad-toolbar">
                <FilterPills options={types} value={type} onPick={setType} />
                <FilterPills options={[...ACTIVITY_SEVERITIES]} value={sev} onPick={setSev} />
                <FilterPills options={['All time', '24 hours', '7 days']} value={range} onPick={setRange} />
                <SearchInput value={search} onInput={setSearch} placeholder={t('Search events…')} />
                <SearchInput value={username} onInput={setUsername} placeholder={t('Filter by username…')} />
                <button class="ad-btn" onClick={exportCsv} disabled={filtered.length === 0}>{t('Export CSV')}</button>
            </div>
            <div class="ad-feed">
                {error && <p class="ad-error" role="alert">{error}</p>}
                {loading && <p role="status" class="ad-note">{t('Loading events…')}</p>}
                {!loading && !error && filtered.length === 0 && <Empty muted>{t('No matching events on this page')}</Empty>}
                {filtered.slice(0, limit).map((a, index) => <div key={a.Id}>
                    {(index === 0 || bucket(filtered[index - 1].Date) !== bucket(a.Date)) && <h4 class="ad-feed-bucket">{t(bucket(a.Date))}</h4>}
                    <div class="ad-feed-row">
                    <span class={`ad-feed-dot ${isErrorSeverity(a.Severity) ? 'red' : a.Severity === 'Warning' ? 'amber' : 'gray'}`} />
                    <span class="ad-feed-line">{a.Name || a.Overview || a.ShortOverview || '—'}</span>
                    <StatusChip tone={classify(a) === 'Playback' || classify(a) === 'Auth' ? 'blue' : 'muted'}>{t(classify(a))}</StatusChip>
                    <span class="ad-feed-time">{timeAgo(a.Date)}</span>
                    </div>
                </div>)}
            </div>
            <div class="ad-pagination"><span class="ad-note">{t('Type and text filters apply to the current page. CSV exports visible matching events.')}</span><button class="ad-btn" disabled={page === 0 || loading} onClick={() => setPage(v => v - 1)}>{t('Previous')}</button><span>{total ? t('{0}–{1} of {2}', page * 50 + 1, Math.min(page * 50 + 50, total), total) : t('0 events')}</span><button class="ad-btn" disabled={loading || (page + 1) * 50 >= total} onClick={() => setPage(v => v + 1)}>{t('Next')}</button></div>
        </Card>
    </PageShell>;
}
