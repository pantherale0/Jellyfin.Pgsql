import { useCallback, useEffect, useState } from 'preact/hooks';
import type { AdminApi } from '../admin-api';
import type { JellyfinSession } from '../types';
import { PageShell, Card, StatusChip, FilterPills, Empty, Tabs, SearchInput, ConfirmButton, DataTable, playbackMethod } from '../ui';

export function AdminPlayback({ adminApi: api }: { adminApi: AdminApi }) {
    const [tab, setTab] = useState('Live sessions');
    const [sessions, setSessions] = useState<JellyfinSession[]>([]);
    const [methods, setMethods] = useState<Array<{ Key?: string; PlayCount?: number; TotalTicks?: number }>>([]);
    const [clients, setClients] = useState<Array<{ Key?: string; PlayCount?: number; TotalTicks?: number }>>([]);
    const [method, setMethod] = useState('All');
    const [client, setClient] = useState('All');
    const [search, setSearch] = useState('');
    const [sort, setSort] = useState('User');
    const [ascending, setAscending] = useState(true);
    const [busy, setBusy] = useState('');
    const [start, setStart] = useState(() => new Date(Date.now() - 6 * 86400000).toISOString().slice(0,10));
    const [end, setEnd] = useState(() => new Date().toISOString().slice(0,10));
    const [daily, setDaily] = useState<Array<{ Date?: string; MediaType?: string; PlayCount?: number; TotalTicks?: number }>>([]);
    const [historyBusy, setHistoryBusy] = useState(false);

    const load = useCallback(async () => {
        setSessions(await api.getSessions().catch(() => []));
    }, [api]);
    useEffect(() => { void load(); const timer = window.setInterval(() => { if (!document.hidden && tab !== 'Statistics') void load(); }, 8000); return () => window.clearInterval(timer); }, [load, tab]);
    useEffect(() => {
        if (tab !== 'Statistics' || !start || !end || start > end) return;
        let active = true; setHistoryBusy(true);
        void Promise.all([api.getPlaybackDimensions('Method', start, end), api.getPlaybackDimensions('Client', start, end), api.getDailyPlayback(start, end)]).then(([m, c, d]) => { if (active) { setMethods(m); setClients(c); setDaily(d); } }).finally(() => { if (active) setHistoryBusy(false); });
        return () => { active = false; };
    }, [api, tab, start, end]);

    const playing = sessions.filter(s => s.NowPlayingItem);
    const clientNames = Array.from(new Set(playing.map(s => s.Client).filter((x): x is string => Boolean(x))));
    const filtered = playing.filter(s => {
        const playMethod = playbackMethod(s);
        if (method !== 'All' && method !== playMethod) return false;
        if (client !== 'All' && client !== s.Client) return false;
        if (search && !`${s.UserName || ''} ${s.Client || ''} ${s.NowPlayingItem?.Name || ''}`.toLowerCase().includes(search.toLowerCase())) return false;
        return true;
    });

    const columns = [
        { key: 'User', label: 'User', value: (s: JellyfinSession) => s.UserName || '—', searchValue: (s: JellyfinSession) => s.UserName || '' },
        { key: 'Client', label: 'Client / device', value: (s: JellyfinSession) => <>{s.Client || '—'}<div class="ad-cell-sub">{s.DeviceName}</div></>, searchValue: (s: JellyfinSession) => `${s.Client || ''} ${s.DeviceName || ''}` },
        { key: 'Title', label: 'Title', value: (s: JellyfinSession) => s.NowPlayingItem?.Name || '—', searchValue: (s: JellyfinSession) => s.NowPlayingItem?.Name || '' },
        { key: 'Method', label: 'Method', value: (s: JellyfinSession) => <StatusChip tone={playbackMethod(s) === 'Transcode' ? 'amber' : 'blue'}>{playbackMethod(s)}</StatusChip> },
        { key: 'Progress', label: 'Progress', value: (s: JellyfinSession) => s.NowPlayingItem?.RunTimeTicks ? `${Math.min(100, (s.PlayState?.PositionTicks || 0) / s.NowPlayingItem.RunTimeTicks * 100).toFixed(0)}%` : 'Not reported' },
        { key: 'Bandwidth', label: 'Bandwidth', value: (s: JellyfinSession) => s.TranscodingInfo?.BitRate ? `${(s.TranscodingInfo.BitRate / 1_000_000).toFixed(1)} Mbps` : '—' },
        { key: 'Action', label: '', value: (s: JellyfinSession) => <ConfirmButton label="Stop playback" tone="danger" busy={busy === s.Id} onConfirm={async () => { setBusy(s.Id); try { await api.stopPlayback(s.Id); await load(); } finally { setBusy(''); } }} /> },
    ];

    return <PageShell title="Playback" subtitle="Live monitoring and historical intelligence">
        <Tabs tabs={['Live sessions', 'Statistics', 'Transcoding']} value={tab} onPick={setTab} />
        {tab === 'Live sessions' && <Card title={`Live sessions · ${playing.length}`}>
            <div class="ad-toolbar"><SearchInput value={search} onInput={setSearch} placeholder="Search sessions…" />
                <FilterPills options={['All', 'Direct Play', 'Transcode', 'Remux', 'Unknown']} value={method} onPick={setMethod} />
                {clientNames.length > 0 && <FilterPills options={['All', ...clientNames]} value={client} onPick={setClient} />}</div>
            <DataTable rows={filtered} columns={columns} getKey={s => s.Id} query={search} empty="No active playback sessions" sortKey={sort} sortAscending={ascending} onSort={key => { if (sort === key) setAscending(v => !v); else { setSort(key); setAscending(true); } }} />
            {sessions.length === 0 && <Empty muted>No active sessions</Empty>}
        </Card>}
        {tab === 'Statistics' && <>
            <div class="ad-toolbar"><label class="ad-field">Start date (UTC)<input type="date" value={start} max={end} onInput={e => setStart(e.currentTarget.value)} /></label><label class="ad-field">End date (UTC)<input type="date" value={end} min={start} onInput={e => setEnd(e.currentTarget.value)} /></label><button class="ad-btn" disabled={!daily.length} onClick={() => exportStats(daily)}>Export CSV</button></div>
            {historyBusy && <p role="status" class="ad-note">Loading statistics…</p>}
            <div class="ad-grid2"><Card title="Playback method · selected period">
                {methods.length === 0 ? <Empty muted>No playback statistics have been recorded yet</Empty> : methods.map(m => <div class="ad-info" key={m.Key}><span class="ad-info-k">{m.Key || 'Unknown'}</span><span class="ad-info-v">{m.PlayCount ?? 0} plays · {formatTicks(m.TotalTicks)}</span></div>)}
            </Card>
            <Card title="Top clients">
                {clients.length === 0 ? <Empty muted>No client statistics recorded</Empty> : clients.slice(0, 10).map(c => <div class="ad-info" key={c.Key}><span class="ad-info-k">{c.Key || 'Unknown'}</span><span class="ad-info-v">{c.PlayCount ?? 0} plays · {formatTicks(c.TotalTicks)}</span></div>)}
            </Card>
            </div>
            {daily.length > 0 && <Card title="Recorded plays by day"><DailyChart rows={daily} /></Card>}
        </>}
        {tab === 'Transcoding' && <Card title="Active transcodes">
            {playing.filter(s => s.TranscodingInfo?.IsVideoDirect === false || s.TranscodingInfo?.IsAudioDirect === false).length === 0
                ? <Empty muted>No active transcodes</Empty>
                : playing.filter(s => s.TranscodingInfo?.IsVideoDirect === false || s.TranscodingInfo?.IsAudioDirect === false).map(s => <div class="ad-info" key={s.Id}><span class="ad-info-k">{s.UserName} · {s.NowPlayingItem?.Name}</span><span class="ad-info-v">{s.TranscodingInfo?.Container || 'Transcode'} · {s.TranscodingInfo?.VideoCodec || '—'}</span></div>)}
        </Card>}
    </PageShell>;
}

function formatTicks(ticks?: number): string {
    if (!ticks) return '0h';
    const hours = ticks / 36_000_000_000;
    return `${hours.toFixed(hours < 10 ? 1 : 0)}h`;
}

function DailyChart({ rows }: { rows: Array<{ Date?: string; PlayCount?: number }> }) {
    const totals = new Map<string, number>();
    rows.forEach(row => { if (row.Date) totals.set(row.Date.slice(0,10), (totals.get(row.Date.slice(0,10)) || 0) + (row.PlayCount || 0)); });
    const dates = [...totals.keys()].sort(); const max = Math.max(1, ...totals.values());
    const points = dates.map((date, i) => `${dates.length === 1 ? 160 : 10 + i / (dates.length - 1) * 300},${110 - totals.get(date)! / max * 100}`).join(' ');
    return <><svg role="img" aria-label={`Recorded plays from ${dates[0]} to ${dates[dates.length - 1]}`} viewBox="0 0 320 120" class="ad-history-chart"><line x1="10" y1="110" x2="310" y2="110" stroke="var(--a-t2)" />{dates.length > 1 ? <polyline points={points} fill="none" stroke="var(--a-bl)" strokeWidth="3" /> : <circle cx="160" cy="10" r="4" fill="var(--a-bl)" />}</svg><div class="ad-chart-caption"><span>{dates[0]}</span><span>{dates[dates.length - 1]}</span></div></>;
}

function exportStats(rows: Array<{ Date?: string; MediaType?: string; PlayCount?: number; TotalTicks?: number }>) {
    const quote = (value: string) => `"${(/^[=+\-@]/.test(value) ? "'" + value : value).replace(/"/g, '""')}"`;
    const csv = [['Date','Media type','Play count','Played hours'], ...rows.map(r => [r.Date || '', r.MediaType || '', String(r.PlayCount || 0), String((r.TotalTicks || 0) / 36_000_000_000)])].map(row => row.map(quote).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'jellyfin-playback-statistics.csv'; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
