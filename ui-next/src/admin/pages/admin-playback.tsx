import { useCallback, useEffect, useState } from 'preact/hooks';
import type { AdminApi, RecentPlayback } from '../admin-api';
import type { JellyfinSession, JellyfinUserInfo } from '../types';
import { PageShell, Card, StatusChip, FilterPills, Empty, Tabs, SearchInput, DataTable, playbackMethod, SessionControls, ConfigSection, InfoRow } from '../ui';
import { RESUME_FIELDS, STREAMING_FIELDS, TRICKPLAY_FIELDS } from '../server-settings';
import { STAT_DIMENSIONS, formatPlayed, hourlyGrid, userTotals } from '../playback-stats';

const RECENT_PAGE = 20;

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
    const [sessionsError, setSessionsError] = useState('');
    const [start, setStart] = useState(() => new Date(Date.now() - 6 * 86400000).toISOString().slice(0,10));
    const [end, setEnd] = useState(() => new Date().toISOString().slice(0,10));
    const [daily, setDaily] = useState<Array<{ Date?: string; MediaType?: string; PlayCount?: number; TotalTicks?: number }>>([]);
    const [historyBusy, setHistoryBusy] = useState(false);
    const [dimension, setDimension] = useState('Client');
    const [dimensionRows, setDimensionRows] = useState<Array<{ Key?: string; PlayCount?: number; TotalTicks?: number }>>([]);
    const [byUser, setByUser] = useState<Array<{ UserId?: string; PlayCount?: number; TotalTicks?: number }>>([]);
    const [hourly, setHourly] = useState<Array<{ DayOfWeek?: number; Hour?: number; PlayCount?: number }>>([]);
    const [topGroup, setTopGroup] = useState<'Item' | 'Series'>('Item');
    const [topItems, setTopItems] = useState<Array<{ ItemId?: string; ItemName?: string; MediaType?: string; PlayCount?: number; TotalTicks?: number }>>([]);
    const [recent, setRecent] = useState<RecentPlayback[]>([]);
    const [recentTotal, setRecentTotal] = useState(0);
    const [recentStart, setRecentStart] = useState(0);
    const [users, setUsers] = useState<JellyfinUserInfo[]>([]);
    const [statsError, setStatsError] = useState('');
    const [detailId, setDetailId] = useState('');

    const load = useCallback(async () => {
        try { setSessions(await api.getSessions()); setSessionsError(''); }
        catch (e) { setSessionsError(e instanceof Error ? e.message : 'Sessions could not be loaded.'); }
    }, [api]);
    useEffect(() => { void load(); const timer = window.setInterval(() => { if (!document.hidden && tab !== 'Statistics') void load(); }, 8000); return () => window.clearInterval(timer); }, [load, tab]);
    useEffect(() => {
        if (tab !== 'Statistics' || !start || !end || start > end) return;
        let active = true; setHistoryBusy(true);
        setStatsError('');
        const filter = { startDate: start, endDate: end };
        void Promise.all([
            api.getPlaybackDimensions('Method', start, end), api.getPlaybackDimensions('Client', start, end), api.getDailyPlayback(start, end),
            api.getPlaybackByUser(filter).catch(() => []), api.getPlaybackHourly(filter).catch(() => []), api.getUsers().catch(() => []),
        ]).then(([m, c, d, u, h, people]) => { if (active) { setMethods(m); setClients(c); setDaily(d); setByUser(u); setHourly(h); setUsers(people); } })
            .catch(e => { if (active) setStatsError(e instanceof Error ? e.message : 'Statistics could not be loaded.'); })
            .finally(() => { if (active) setHistoryBusy(false); });
        return () => { active = false; };
    }, [api, tab, start, end]);
    useEffect(() => {
        if (tab !== 'Statistics' || !start || !end || start > end) return;
        let active = true;
        void api.getPlaybackDimensions(dimension, start, end).then(rows => { if (active) setDimensionRows(rows); });
        return () => { active = false; };
    }, [api, tab, start, end, dimension]);
    useEffect(() => {
        if (tab !== 'Statistics' || !start || !end || start > end) return;
        let active = true;
        void api.getPlaybackItems({ startDate: start, endDate: end }, topGroup).then(rows => { if (active) setTopItems(rows); }).catch(() => { if (active) setTopItems([]); });
        return () => { active = false; };
    }, [api, tab, start, end, topGroup]);
    useEffect(() => { setRecentStart(0); }, [start, end]);
    useEffect(() => {
        if (tab !== 'Statistics' || !start || !end || start > end) return;
        let active = true;
        void api.getRecentPlayback({ startDate: start, endDate: end }, recentStart, RECENT_PAGE).then(page => { if (active) { setRecent(page.Items || []); setRecentTotal(page.TotalRecordCount ?? (page.Items || []).length); } })
            .catch(() => { if (active) { setRecent([]); setRecentTotal(0); } });
        return () => { active = false; };
    }, [api, tab, start, end, recentStart]);

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
        { key: 'Action', label: '', value: (s: JellyfinSession) => <span class="ad-flex"><button class="ad-btn" aria-expanded={detailId === s.Id} onClick={() => setDetailId(current => current === s.Id ? '' : s.Id)}>Details</button><SessionControls session={s} api={api} onChanged={load} /></span> },
    ];
    const detail = playing.find(s => s.Id === detailId);
    const userName = (id?: string) => users.find(u => u.Id.replace(/-/g, '') === (id || '').replace(/-/g, ''))?.Name || 'Deleted user';
    const heat = hourlyGrid(hourly);

    return <PageShell title="Playback" subtitle="Live monitoring and historical intelligence">
        <Tabs tabs={['Live sessions', 'Statistics', 'Transcoding', 'Server settings']} value={tab} onPick={setTab} />
        {tab === 'Live sessions' && <Card title={`Live sessions · ${playing.length}`}>
            <div class="ad-toolbar"><SearchInput value={search} onInput={setSearch} placeholder="Search sessions…" />
                <FilterPills options={['All', 'Direct Play', 'Transcode', 'Remux', 'Unknown']} value={method} onPick={setMethod} />
                {clientNames.length > 0 && <FilterPills options={['All', ...clientNames]} value={client} onPick={setClient} />}</div>
            {sessionsError && <p role="alert" class="ad-error">{sessionsError}</p>}
            <DataTable rows={filtered} columns={columns} getKey={s => s.Id} query={search} empty="No active playback sessions" sortKey={sort} sortAscending={ascending} onSort={key => { if (sort === key) setAscending(v => !v); else { setSort(key); setAscending(true); } }} />
            {sessions.length === 0 && !sessionsError && <Empty muted>No active sessions</Empty>}
        </Card>}
        {tab === 'Live sessions' && detail && <SessionDetail session={detail} />}
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
            {statsError && <p role="alert" class="ad-error">{statsError}</p>}
            {daily.length > 0 && <Card title="Recorded plays by day"><DailyChart rows={daily} /></Card>}
            <div class="ad-grid2">
                <Card title="Breakdown" actions={<FilterPills options={STAT_DIMENSIONS.map(([, label]) => label)} value={STAT_DIMENSIONS.find(([key]) => key === dimension)?.[1] || dimension} onPick={label => setDimension(STAT_DIMENSIONS.find(([, l]) => l === label)?.[0] || 'Client')} />}>
                    {dimensionRows.length === 0 ? <Empty muted>No plays recorded for this dimension</Empty> : dimensionRows.slice(0, 15).map(row => <InfoRow key={row.Key} k={row.Key || 'Unknown'} v={`${row.PlayCount ?? 0} plays · ${formatPlayed(row.TotalTicks)}`} />)}
                </Card>
                <Card title="Users">
                    {byUser.length === 0 ? <Empty muted>No per-user plays recorded</Empty> : userTotals(byUser, users).slice(0, 15).map(row => <InfoRow key={row.id} k={row.name} v={`${row.plays} plays · ${formatPlayed(row.ticks)}`} />)}
                </Card>
            </div>
            <Card title="Most played" actions={<FilterPills options={['Titles', 'Series']} value={topGroup === 'Item' ? 'Titles' : 'Series'} onPick={value => setTopGroup(value === 'Series' ? 'Series' : 'Item')} />}>
                {topItems.length === 0 ? <Empty muted>No titles recorded</Empty> : topItems.map((row, index) => <InfoRow key={`${row.ItemId}-${index}`} k={`${row.ItemName || 'Unknown'}${row.MediaType ? ` · ${row.MediaType}` : ''}`} v={`${row.PlayCount ?? 0} plays · ${formatPlayed(row.TotalTicks)}`} />)}
            </Card>
            <Card title="When people watch">{heat.max === 0 ? <Empty muted>No hourly activity recorded</Empty> : <HourlyHeatmap grid={heat.grid} max={heat.max} />}</Card>
            <Card title="Recent playback">
                <DataTable rows={recent} getKey={(row: RecentPlayback) => row.Id || `${row.ItemId}-${row.DatePlayed}`} empty="No playback in this period" query="" columns={[
                    { key: 'When', label: 'When', value: (row: RecentPlayback) => row.DatePlayed ? new Date(row.DatePlayed).toLocaleString() : '—' },
                    { key: 'User', label: 'User', value: (row: RecentPlayback) => userName(row.UserId) },
                    { key: 'Title', label: 'Title', value: (row: RecentPlayback) => row.SeriesName ? `${row.SeriesName} · ${row.ItemName || ''}` : row.ItemName || '—' },
                    { key: 'Client', label: 'Client / device', value: (row: RecentPlayback) => <>{row.ClientName || '—'}<div class="ad-cell-sub">{row.DeviceName}</div></> },
                    { key: 'Method', label: 'Method', value: (row: RecentPlayback) => <>{row.PlaybackMethod || '—'}{row.TranscodeReasons && <div class="ad-cell-sub">{row.TranscodeReasons}</div>}</> },
                    { key: 'Played', label: 'Played', value: (row: RecentPlayback) => formatPlayed(row.PlayedTicks) },
                ]} />
                {recentTotal > RECENT_PAGE && <div class="ad-pagination"><button class="ad-btn" disabled={recentStart === 0} onClick={() => setRecentStart(value => Math.max(0, value - RECENT_PAGE))}>Previous</button><span>{recentStart + 1}–{Math.min(recentStart + RECENT_PAGE, recentTotal)} of {recentTotal}</span><button class="ad-btn" disabled={recentStart + RECENT_PAGE >= recentTotal} onClick={() => setRecentStart(value => value + RECENT_PAGE)}>Next</button></div>}
            </Card>
        </>}
        {tab === 'Server settings' && <>
            <ConfigSection api={api} path="/System/Configuration" title="Resume" fields={RESUME_FIELDS} validate={draft => draft.MinResumePct >= draft.MaxResumePct ? 'The minimum resume percentage must be below the maximum.' : ''} />
            <ConfigSection api={api} path="/System/Configuration" title="Streaming" fields={STREAMING_FIELDS} />
            <ConfigSection api={api} path="/System/Configuration" title="Trickplay" fields={TRICKPLAY_FIELDS} note="Changes apply to newly generated trickplay images. Run the trickplay task to regenerate existing ones." />
        </>}
        {tab === 'Transcoding' && <Card title="Active transcodes">
            {playing.filter(s => s.TranscodingInfo?.IsVideoDirect === false || s.TranscodingInfo?.IsAudioDirect === false).length === 0
                ? <Empty muted>No active transcodes</Empty>
                : playing.filter(s => s.TranscodingInfo?.IsVideoDirect === false || s.TranscodingInfo?.IsAudioDirect === false).map(s => <div class="ad-info" key={s.Id}><span class="ad-info-k">{s.UserName} · {s.NowPlayingItem?.Name}</span><span class="ad-info-v">{s.TranscodingInfo?.Container || 'Transcode'} · {s.TranscodingInfo?.VideoCodec || '—'}</span></div>)}
        </Card>}
    </PageShell>;
}

function SessionDetail({ session }: { session: JellyfinSession }) {
    const transcode = session.TranscodingInfo;
    const play = session.PlayState;
    return <Card title={`Session details · ${session.UserName || 'Unknown user'}`}>
        <div class="ad-grid2"><div>
            <InfoRow k="Client" v={`${session.Client || '—'} ${session.ApplicationVersion || ''}`.trim()} />
            <InfoRow k="Device" v={session.DeviceName || '—'} />
            <InfoRow k="Remote address" v={session.RemoteEndPoint || 'Not reported'} />
            <InfoRow k="Playing" v={session.NowPlayingItem?.Name || '—'} />
            <InfoRow k="Method" v={playbackMethod(session)} />
            <InfoRow k="State" v={play?.IsPaused ? 'Paused' : 'Playing'} />
            <InfoRow k="Audio / subtitle stream" v={`${play?.AudioStreamIndex ?? '—'} / ${play?.SubtitleStreamIndex ?? 'Off'}`} />
            <InfoRow k="Remote control" v={session.SupportsRemoteControl ? `Supported (${(session.SupportedCommands || []).length} commands)` : 'Not supported'} />
        </div>{transcode ? <div>
            <InfoRow k="Container" v={transcode.Container || '—'} />
            <InfoRow k="Video" v={`${transcode.IsVideoDirect ? 'Direct' : 'Transcoded'} · ${transcode.VideoCodec || '—'}${transcode.Width ? ` · ${transcode.Width}×${transcode.Height}` : ''}${transcode.Framerate ? ` · ${transcode.Framerate} fps` : ''}`} />
            <InfoRow k="Audio" v={`${transcode.IsAudioDirect ? 'Direct' : 'Transcoded'} · ${transcode.AudioCodec || '—'}${transcode.AudioChannels ? ` · ${transcode.AudioChannels} ch` : ''}`} />
            <InfoRow k="Bitrate" v={transcode.BitRate ? `${(transcode.BitRate / 1_000_000).toFixed(1)} Mbps` : '—'} />
            <InfoRow k="Hardware acceleration" v={transcode.HardwareAccelerationType || 'None'} />
            {transcode.CompletionPercentage != null && <InfoRow k="Transcode progress" v={`${transcode.CompletionPercentage.toFixed(0)}%`} />}
            <InfoRow k="Transcode reasons" v={(transcode.TranscodeReasons || []).join(', ') || 'None reported'} />
        </div> : <Empty muted>No transcoding for this session.</Empty>}</div>
    </Card>;
}

function HourlyHeatmap({ grid, max }: { grid: number[][]; max: number }) {
    const days = [ 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat' ];
    return <div class="ad-heatmap" role="table" aria-label="Plays by day of week and hour (UTC)">
        <div role="row" class="ad-heatmap-row"><span role="columnheader" />{grid[0].map((_, hour) => <span role="columnheader" key={hour} class="ad-heatmap-hour">{hour % 6 === 0 ? hour : ''}</span>)}</div>
        {grid.map((hours, day) => <div role="row" class="ad-heatmap-row" key={day}><span role="rowheader">{days[day]}</span>{hours.map((count, hour) => <span role="cell" key={hour} class="ad-heatmap-cell" title={`${days[day]} ${hour}:00 · ${count} plays`} aria-label={`${days[day]} ${hour}:00, ${count} plays`} style={{ opacity: count ? 0.2 + 0.8 * count / max : 0.06 }} />)}</div>)}
    </div>;
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
