import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { AdminApi } from '../admin-api';
import type { ServerActivityEntry, JellyfinSession, ScheduledTask, HealthIssue, ServerHealth, ForkStatus, SystemStorage } from '../types';
import { ConfirmButton, CollapsibleSection, useRelativeClock, playbackMethod } from '../ui';

interface OverviewProps { adminApi: AdminApi; session: { user: { Id: string; Name: string } }; onNavigate: (section: string) => void }

export function AdminOverview({ adminApi: api, session, onNavigate }: OverviewProps) {
    useRelativeClock();
    const [health, setHealth] = useState<ServerHealth>('healthy');
    const [loading, setLoading] = useState(true);
    const [issues, setIssues] = useState<HealthIssue[]>([]);
    const [dismissed, setDismissed] = useState(false);
    const [sys, setSys] = useState<{ ServerName?: string; Version?: string; RunTimeTicks?: number } | null>(null);
    const [sessions, setSessions] = useState<JellyfinSession[]>([]);
    const [tasks, setTasks] = useState<ScheduledTask[]>([]);
    const [stats, setStats] = useState<{
        CacheActive: boolean; CacheBackend: string; RedisAvailability: string;
        BrowseCacheHits: number; BrowseCacheMisses: number; LatestCacheHits: number; LatestCacheMisses: number;
        RedisGetErrors: number; RedisSetErrors: number; OptimizedLatestRuns: number; OptimizedLatestFailures: number;
    } | null>(null);
    const [activity, setActivity] = useState<ServerActivityEntry[]>([]);
    const [library, setLibrary] = useState<{ Movies: number; Episodes: number; Series: number; Collections: number; TotalItems?: number }>({ Movies: 0, Episodes: 0, Series: 0, Collections: 0 });
    const [fork, setFork] = useState<ForkStatus | null>(null);
    const [storage, setStorage] = useState<SystemStorage | null>(null);
    const [playbackStats, setPlaybackStats] = useState<Array<{ Key?: string; PlayCount?: number; TotalTicks?: number }> | null>(null);
    const [tasteEval, setTasteEval] = useState<any>(null);
    const [seerrEnabled, setSeerrEnabled] = useState(false);
    const [ssoConfigured, setSsoConfigured] = useState(false);
    const [error, setError] = useState('');
    const [actFilter, setActFilter] = useState('All');
    const [showAllSessions, setShowAllSessions] = useState(false);
    const [showAllActivity, setShowAllActivity] = useState(false);
    const [showAllTasks, setShowAllTasks] = useState(false);
    const iv = useRef<number>();

    const load = useCallback(async () => {
        try {
            const [s, sess, t, st, act, lib, disk, daily, taste, seerr, sso] = await Promise.all([
                api.getSystemInfo().catch(() => null),
                api.getSessions().catch(() => []),
                api.getScheduledTasks().catch(() => []),
                api.getPgsqlStats().catch(() => null),
                api.getActivityLog(0, 50).catch(() => ({ Items: [] })),
                api.getLibraryTotals().catch(() => ({ Movies: 0, Episodes: 0, Series: 0, Collections: 0 })),
                api.getSystemStorage().catch(() => null),
                api.getPlaybackDimensions('Method', new Date().toISOString().slice(0,10), new Date().toISOString().slice(0,10)).catch(() => null),
                api.getTasteShadowEval().catch(() => null),
                api.getSeerrStatus().catch(() => ({ Enabled: false })),
                api.getSsoStatus().catch(() => null),
            ]);
            setSys(s); setSessions(sess); setTasks(t); setStats(st);
            setActivity(act.Items || []); setLibrary(lib);
            const cacheSamples = st ? st.BrowseCacheHits + st.LatestCacheHits + st.BrowseCacheMisses + st.LatestCacheMisses : 0;
            setFork({ cache: st ? { backend: st.CacheBackend, status: !st.CacheActive ? 'Disabled' : st.CacheBackend === 'Memory' ? 'Ready' : st.RedisAvailability, hitRate: cacheSamples ? `${((st.BrowseCacheHits + st.LatestCacheHits) / cacheSamples * 100).toFixed(1)}%` : undefined } : undefined });
            setStorage(disk); setPlaybackStats(daily); setTasteEval(taste);
            setSeerrEnabled(seerr?.Enabled === true); setSsoConfigured(sso?.enabled === true);
            const i: HealthIssue[] = [];
            if (!s) i.push({ severity: 'critical', message: 'Server information is unreachable', link: 'system' });
            if (!st) i.push({ severity: 'degraded', message: 'Pgsql runtime telemetry is unavailable', link: 'infrastructure' });
            t.filter(x => x.LastExecutionResult?.Status === 'Failed' && x.LastExecutionResult.EndTimeUtc && Date.now() - Date.parse(x.LastExecutionResult.EndTimeUtc) < 86400000).forEach(x => { if (x.Name) i.push({ severity: 'degraded', message: `Task "${x.Name}" failed`, link: 'activity' }); });
            if (t.some(x => x.State === 'Faulted')) i.push({ severity: 'critical', message: 'A task has faulted', link: 'activity' });
            if (st && st.CacheActive && st.CacheBackend === 'Redis' && st.RedisAvailability !== 'Ready') i.push({ severity: 'degraded', message: `Redis ${st.RedisAvailability} · memory fallback`, link: 'infrastructure' });
            setIssues(i); setHealth(i.length === 0 ? 'healthy' : i.some(x => x.severity === 'critical') ? 'critical' : 'degraded');
            setError('');
        } catch { setError('Failed to load overview.'); }
        finally { setLoading(false); }
    }, [api]);

    useEffect(() => {
        let active = true;
        const poll = async () => {
            if (!active) return;
            if (!document.hidden) await load();
            if (active) iv.current = window.setTimeout(poll, 15000);
        };
        void poll();
        return () => { active = false; window.clearTimeout(iv.current); };
    }, [load]);

    useEffect(() => setDismissed(false), [JSON.stringify(issues)]);

    const playing = sessions.filter(s => s.NowPlayingItem);
    const idle = sessions.filter(s => !s.NowPlayingItem);
    const activeUsers = new Set(sessions.map(s => s.UserId || s.UserName).filter(Boolean)).size;
    const cacheHitTotal = stats ? (stats.BrowseCacheHits + stats.LatestCacheHits + stats.BrowseCacheMisses + stats.LatestCacheMisses) : 0;
    const cacheRate = cacheHitTotal > 0 ? ((stats!.BrowseCacheHits + stats!.LatestCacheHits) / cacheHitTotal * 100).toFixed(1) : null;
    const totalItems = library.TotalItems ?? library.Movies + library.Episodes + library.Series + library.Collections;
    const direct = playing.filter(s => s.TranscodingInfo?.IsVideoDirect !== false && s.TranscodingInfo?.IsAudioDirect !== false).length;
    const transcode = playing.filter(s => s.TranscodingInfo?.IsVideoDirect === false || s.TranscodingInfo?.IsAudioDirect === false).length;

    return <div class="ao">
        <div class="ao-page-heading"><h1>Server overview</h1>{loading ? <span role="status">Loading telemetry…</span> : health === 'healthy' ? <span class="ad-st green">Healthy</span> : null}</div>
        {!loading && health !== 'healthy' && !dismissed && issues.length > 0 && <StatusBanner health={health} issues={issues} onDismiss={() => setDismissed(true)} onNavigate={onNavigate} />}
        {error && <div class="ao-error" role="alert"><p>{error}</p><button class="admin-btn" onClick={load}>Retry</button></div>}
        <KpiStrip playing={playing} idle={idle} activeUsers={activeUsers} totalItems={totalItems} library={library} cacheRate={cacheRate} stats={stats} storage={storage} onNavigate={onNavigate} />
        <CompositionRow stats={stats} fork={fork} playing={playing} storage={storage} playbackStats={playbackStats} onNavigate={onNavigate} />
        <div class="ao-split">
            <div class="ao-left">
                <CollapsibleSection id="overview-sessions" className="ao-sessions" title={`Sessions · ${sessions.length}`}>
                    <SessionBox sessions={sessions} playing={playing} idle={idle} showAll={showAllSessions} onToggle={() => setShowAllSessions(v => !v)} api={api} />
                </CollapsibleSection>
                <CollapsibleSection id="overview-activity" className="ao-activity" title="Recent activity">
                    <ActivityFeed activity={activity} filter={actFilter} onFilter={setActFilter} showAll={showAllActivity} onToggle={() => setShowAllActivity(v => !v)} api={api} />
                </CollapsibleSection>
            </div>
            <div class="ao-right">
                {storage && <CollapsibleSection id="overview-mounts" className="ao-mounts" title="Mount points & storage"><MountPoints storage={storage} /></CollapsibleSection>}
                <CollapsibleSection id="overview-tasks" className="ao-background" title="Background work"><BackgroundWork tasks={tasks} showAll={showAllTasks} onToggle={() => setShowAllTasks(v => !v)} /></CollapsibleSection>
                <CollapsibleSection id="overview-fork" className="ao-fork-health" title="System alerts & Fork health"><SystemAlertsAndFork activity={activity} fork={fork} tasteEval={tasteEval} seerrEnabled={seerrEnabled} ssoConfigured={ssoConfigured} /></CollapsibleSection>
            </div>
        </div>
    </div>;
}

/* ========================= Components ========================= */

function StatusBanner({ health, issues, onDismiss, onNavigate }: { health: ServerHealth; issues: HealthIssue[]; onDismiss: () => void; onNavigate: (s: string) => void }) {
    const isCritical = health === 'critical';
    const primary = issues.find(issue => issue.severity === 'critical') || issues[0];
    return <div class="ao-banner" style={{ background: isCritical ? '#3a1115' : '#3a2e0a', borderColor: isCritical ? '#ef4444' : '#f59e0b' }} role="alert">
        <span class="ao-banner-icon" style={{ color: isCritical ? '#ef4444' : '#f59e0b' }}>{isCritical ? '●' : '▲'}</span>
        <div class="ao-banner-body"><strong style={{ color: isCritical ? '#ef4444' : '#f59e0b' }}>{isCritical ? 'Critical' : 'Degraded'}</strong>
            <span class="ao-banner-line" title={issues.map(i => i.message).join('\n')}>{primary.message}{issues.length > 1 ? ` · ${issues.length - 1} more issues` : ''}</span>
        </div>
        {primary.link && <button class="admin-btn" onClick={() => onNavigate(primary.link!)}>Investigate</button>}
        <button class="ao-banner-x" onClick={onDismiss} aria-label="Dismiss status banner">✕</button>
    </div>;
}

function KpiStrip({ playing, idle, activeUsers, totalItems, library, cacheRate, stats, storage, onNavigate }: {
    playing: JellyfinSession[]; idle: JellyfinSession[]; activeUsers: number; totalItems: number;
    library: { Movies: number; Episodes: number; Series: number; Collections: number };
    cacheRate: string | null; stats: { CacheBackend: string; CacheActive: boolean } | null; onNavigate: (s: string) => void;
    storage: SystemStorage | null;
}) {
    return <div class="ao-kpis">
        <KpiCard title="Active playback" value={String(playing.length)} onClick={() => onNavigate('playback')}>
            {playing.length > 0 && <span class="ao-kpi-sub">{playing.filter(s => playbackMethod(s) === 'Direct Play').length} Direct · {playing.filter(s => playbackMethod(s) === 'Transcode').length} Transcode · {playing.filter(s => playbackMethod(s) === 'Remux').length} Remux</span>}
        </KpiCard>
        <KpiCard title="Library" value={totalItems.toLocaleString()} onClick={() => onNavigate('libraries')}>
            <span class="ao-kpi-sub">{library.Movies.toLocaleString()} Movies · {library.Episodes.toLocaleString()} Episodes · {library.Series.toLocaleString()} Series</span>
        </KpiCard>
        <KpiCard title="Online users" value={String(activeUsers)} muted={activeUsers === 0} onClick={() => onNavigate('activity')}>
            <span class="ao-kpi-sub">{playing.length + idle.length} session{(playing.length + idle.length) !== 1 ? 's' : ''}{idle.length > 0 && ` · ${idle.length} idle`}</span>
        </KpiCard>
        <KpiCard title="Cache health" value={cacheRate ? `${cacheRate}%` : stats ? stats.CacheActive ? 'Ready' : 'Off' : 'Unavailable'} onClick={() => onNavigate('infrastructure')}>
            {stats && <span class="ao-kpi-sub">{stats.CacheBackend} · {stats.CacheActive ? 'active' : 'off'}</span>}
        </KpiCard>
        {storage && freeSpace(storage) && <KpiCard title="Storage free" value={freeSpace(storage)!} onClick={() => onNavigate('system')}>
            <span class="ao-kpi-sub">Least headroom across key mounts</span>
        </KpiCard>}
    </div>;
}

function KpiCard({ title, value, muted, onClick, children }: { title: string; value: string; muted?: boolean; onClick: () => void; children?: any }) {
    return <button type="button" class="ao-kpi" onClick={onClick}>
        <h3>{title}</h3>
        <p class={`ao-kpi-val ${muted ? 'muted' : ''}`}>{value}</p>
        {children}
    </button>;
}

function CompositionRow({ stats, fork, playing, storage, playbackStats, onNavigate }: {
    stats: { CacheActive: boolean; CacheBackend: string; RedisAvailability: string; BrowseCacheHits: number; BrowseCacheMisses: number; OptimizedLatestRuns: number; OptimizedLatestFailures: number } | null;
    fork: ForkStatus | null; playing: JellyfinSession[]; storage: SystemStorage | null;
    playbackStats: Array<{ Key?: string; PlayCount?: number; TotalTicks?: number }> | null;
    onNavigate: (s: string) => void;
}) {
    const direct = playing.filter(s => s.TranscodingInfo?.IsVideoDirect !== false && s.TranscodingInfo?.IsAudioDirect !== false).length;
    const transcode = playing.filter(s => s.TranscodingInfo?.IsVideoDirect === false || s.TranscodingInfo?.IsAudioDirect === false).length;
    return <div class="ao-composition">
        <div class="ao-comp-card" onClick={() => onNavigate('infrastructure')}>
            <h3>Infrastructure health</h3>
            <div class="ao-comp-donuts">
                {stats && <MiniDonut label="Redis" pct={stats.RedisAvailability === 'Ready' ? 100 : 0} color={stats.RedisAvailability === 'Ready' ? '#22c55e' : '#f59e0b'} />}
                {stats && <MiniDonut label="Query cache" pct={stats.CacheActive ? 100 : 0} color={stats.CacheActive ? '#22c55e' : '#5A6270'} />}
            </div>
            <div class="ao-comp-legend">{stats ? `${stats.CacheBackend} · ${stats.RedisAvailability}` : 'Infrastructure telemetry unavailable'}</div>
        </div>
        {storage && <div class="ao-comp-card" onClick={() => onNavigate('system')}>
            <h3>Storage breakdown</h3>
            <div class="ao-comp-stack">
                <StorageSeg label="Transcode temp" mount={storage.TranscodingTempFolder} />
                <StorageSeg label="Metadata" mount={storage.InternalMetadataFolder} />
                <StorageSeg label="Log" mount={storage.LogFolder} />
            </div>
        </div>}
        <div class="ao-comp-card" onClick={() => onNavigate('playback')}>
            <h3>Playback mix</h3>
            {playbackStats && playbackStats.length > 0 ? <><div class="ao-comp-stack">{playbackStats.map(row => <SegBar key={row.Key} label={playbackMethodLabel(row.Key)} used={row.PlayCount || 0} total={Math.max(1, playbackStats.reduce((n, p) => n + (p.PlayCount || 0), 0))} unit="plays" />)}</div><div class="ao-comp-legend">Playback method · today (UTC)</div></>
                : <p class="ao-comp-empty">No historical playback data available</p>}
            {fork?.taste && fork.taste.healthy && <div class="ao-comp-extra"><span class="ao-dot" style="background:#3b82f6" />Taste model ready</div>}
        </div>
    </div>;
}

function MiniDonut({ label, pct, color }: { label: string; pct: number; color: string }) {
    const r = 14, circ = 2 * Math.PI * r, offset = circ - (pct / 100) * circ;
    return <div class="ao-donut-wrap">
        <svg width="36" height="36" viewBox="0 0 36 36"><circle cx="18" cy="18" r={r} fill="none" stroke="rgba(255,255,255,.05)" strokeWidth="4" />
            <circle cx="18" cy="18" r={r} fill="none" stroke={color} strokeWidth="4" strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round" transform="rotate(-90 18 18)" /></svg>
        <span class="ao-donut-label">{label}</span>
    </div>;
}

function SegBar({ label, used, total, unit }: { label: string; used: number; total: number; unit?: string }) {
    const pct = Math.min(100, (used / total) * 100);
    const color = unit === 'plays' ? '#3B82F6' : pct > 90 ? '#ef4444' : pct > 70 ? '#f59e0b' : '#22c55e';
    return <div class="ao-segbar"><span class="ao-segbar-label">{label}</span><div class="ao-segbar-track"><i style={{ width: pct + '%', background: color }} /></div><span class="ao-segbar-num">{unit === 'plays' ? used : formatBytes(used)}</span></div>;
}

function StorageSeg({ label, mount }: { label: string; mount: { UsedSpace: number; FreeSpace: number } }) {
    const total = mount.UsedSpace + mount.FreeSpace;
    if (!total) return null;
    const pct = mount.UsedSpace / total * 100;
    const color = pct > 90 ? '#ef4444' : pct > 70 ? '#f59e0b' : '#22c55e';
    return <div class="ao-segbar"><span class="ao-segbar-label">{label}</span><div class="ao-segbar-track"><i style={{ width: pct + '%', background: color }} /></div><span class="ao-segbar-num">{pct.toFixed(0)}%</span></div>;
}

function freeSpace(storage: SystemStorage): string | null {
    const mounts = [storage.TranscodingTempFolder, storage.InternalMetadataFolder, storage.LogFolder, storage.CacheFolder].filter(m => m && Number.isFinite(m.UsedSpace) && Number.isFinite(m.FreeSpace) && m.UsedSpace + m.FreeSpace > 0);
    return mounts.length ? `${Math.round(Math.min(...mounts.map(m => m.FreeSpace / (m.UsedSpace + m.FreeSpace) * 100)))}% free` : null;
}

function SessionBox({ sessions, playing, idle, showAll, onToggle, api }: {
    sessions: JellyfinSession[]; playing: JellyfinSession[]; idle: JellyfinSession[];
    showAll: boolean; onToggle: () => void; api: AdminApi;
}) {
    const [kicking, setKicking] = useState('');
    if (sessions.length === 0) return <section class="ao-section"><h2>Sessions</h2><p class="ao-empty">No active sessions</p></section>;
    const max = showAll ? 50 : 4;
    const visible = [...playing, ...idle].slice(0, max);
    return <section class="ao-section">
        <h2>Sessions <span class="ao-badge">{sessions.length}</span></h2>
        {visible.map(s => {
            const p = !!s.NowPlayingItem;
            const pi = s.TranscodingInfo;
            const doKick = async () => { setKicking(s.Id); try { await api.stopPlayback(s.Id); } catch {} setKicking(''); };
            return <div class={`ao-sess${p ? ' playing' : ''}`} key={s.Id}>
                <span class="ao-sess-av">{s.UserName?.[0] || '?'}</span>
                <div class="ao-sess-body">
                    <div class="ao-sess-top"><span class="ao-sess-name">{s.UserName || '—'}</span><span class="ao-sess-client">{s.Client || ''}</span></div>
                    <div class="ao-sess-meta">{s.RemoteEndPoint || ''}{pi && pi.Width ? ` · ${pi.Width}×${pi.Height}` : ''}{pi?.BitRate ? ` @ ${(pi.BitRate / 1_000_000).toFixed(1)} Mbps` : ''}</div>
                    {p && s.NowPlayingItem?.Name && <div class="ao-sess-title">{s.NowPlayingItem.Name}</div>}
                    {p && s.NowPlayingItem?.RunTimeTicks && s.PlayState?.PositionTicks && <div class="ao-progress"><i style={{ width: `${Math.min(100, (s.PlayState.PositionTicks / s.NowPlayingItem.RunTimeTicks) * 100)}%` }} /></div>}
                </div>
                <span class={`ao-status ${p ? playbackMethod(s) === 'Transcode' ? 'amber' : 'green' : 'muted'}`}>{p ? s.PlayState?.IsPaused ? 'Paused' : playbackMethod(s) === 'Unknown' ? 'Playing' : playbackMethod(s) : 'Idle'}</span>
                {p && <ConfirmButton label="Stop playback" tone="danger" busy={kicking === s.Id} onConfirm={doKick} />}
            </div>;
        })}
        {sessions.length > max && <button class="ao-expand" onClick={onToggle}>{showAll ? 'Less' : `Show ${sessions.length} sessions`}</button>}
    </section>;
}

function ActivityFeed({ activity, filter, onFilter, showAll, onToggle, api }: {
    activity: ServerActivityEntry[]; filter: string; onFilter: (f: string) => void; showAll: boolean; onToggle: () => void; api: AdminApi;
}) {
    const filters = ['All', 'Auth', 'Playback', 'System'];
    const classify = (a: ServerActivityEntry): string => {
        const t = (a.Type || '').toLowerCase(); const n = (a.Name || '').toLowerCase();
        if (t.includes('auth') || n.includes('authenticated') || n.includes('login')) return 'Auth';
        if (t.includes('playback') || n.includes('playback') || n.includes('play ') || n.includes('stream') || n.includes('finished')) return 'Playback';
        return 'System';
    };
    const filtered = filter === 'All' ? activity : activity.filter(a => classify(a) === filter);
    const [users, setUsers] = useState<Array<{ Id: string; Name: string }>>([]);
    useEffect(() => { api.getUsers().then(setUsers).catch(() => undefined); }, [api]);
    const userNames = new Map(users.map(u => [u.Id, u.Name]));
    const max = showAll ? 20 : 6;
    const bucket = (d: string | undefined) => { if (!d) return 'e'; const m = Math.floor((Date.now() - new Date(d).getTime()) / 60000); if (m < 60) return 'h'; if (m < 1440) return 't'; return 'e'; };
    const bl = (k: string) => ({ h: 'Last hour', t: 'Today', e: 'Earlier' }[k] || 'Earlier');
    const user = (a: ServerActivityEntry) => { const m = a.Name?.match(/^(.+?)\s+(authenticated|started|finished)/i); return m?.[1] || a.Name?.split(' by ').pop() || '—'; };
    const groups: Record<string, ServerActivityEntry[]> = {};
    filtered.slice(0, max).forEach(a => { const k = bucket(a.Date); if (!groups[k]) groups[k] = []; groups[k].push(a); });

    if (activity.length === 0) return null;
    return <section class="ao-section">
        <div class="ao-section-head"><h2>Recent activity</h2><div class="ao-chips">{filters.map(f => <button key={f} class={`ao-chip${filter === f ? ' active' : ''}`} onClick={() => onFilter(f)}>{f}</button>)}</div></div>
        {filtered.length === 0 && <p class="ao-empty">No matching events</p>}
        {filtered.length > 0 && <div class="ao-act-table">
            <div class="ao-act-head"><span>Event</span><span>User</span><span>Description</span><span>When</span></div>
            {Object.entries(groups).map(([k, es]) => <>
                <div class="ao-act-bucket">{bl(k)}</div>
                {es.map(a => <div class="ao-act-row" key={a.Id}>
                    <span class={`ao-act-dot ${classify(a).toLowerCase()}`} />
                    <span class="ao-act-user">{a.UserId ? userNames.get(a.UserId) || user(a) : user(a)}</span>
                    <span class="ao-act-desc">{a.Name || a.Overview || a.ShortOverview || '—'}</span>
                    <span class="ao-act-time">{fmtRelative(a.Date)}</span>
                </div>)}
            </>)}
        </div>}
        {filtered.length > max && <button class="ao-expand" onClick={onToggle}>{showAll ? 'Less' : `Show all ${filtered.length}`}</button>}
    </section>;
}

function MountPoints({ storage }: { storage: SystemStorage }) {
    const libraryMounts = (storage.Libraries || []).flatMap(l => (l.Folders || []).map(f => ({ ...f, LibraryName: l.Name })));
    return <section class="ao-section">
        <h2>Mount points &amp; storage</h2>
        {[storage.TranscodingTempFolder, storage.InternalMetadataFolder, storage.LogFolder, storage.CacheFolder]
            .filter(m => m && m.UsedSpace + m.FreeSpace > 0)
            .map((m, i) => <MountGauge key={i} mount={m} label={m.Path} />)}
        {libraryMounts.filter(m => m.UsedSpace + m.FreeSpace > 0).slice(0, 5)
            .map((m, i) => <MountGauge key={`library-${i}`} mount={m} label={`${m.LibraryName || 'Library'}: ${m.Path}`} />)}
    </section>;
}

function MountGauge({ label, mount }: { label: string; mount: { UsedSpace: number; FreeSpace: number } }) {
    const total = mount.UsedSpace + mount.FreeSpace;
    if (total <= 0) return null;
    const pct = Math.min(100, (mount.UsedSpace / total) * 100);
    const color = pct > 90 ? '#ef4444' : pct > 70 ? '#f59e0b' : '#22c55e';
    return <div class="ao-gauge"><div class="ao-gauge-head"><span>{label}</span><span style={{ color }}>{formatBytes(mount.FreeSpace)} free · {pct.toFixed(0)}% used</span></div><div class="ao-gauge-track"><i style={{ width: pct + '%', background: color }} /></div></div>;
}

function BackgroundWork({ tasks, showAll, onToggle }: { tasks: ScheduledTask[]; showAll: boolean; onToggle: () => void }) {
    const running = tasks.filter(t => t.State === 'Running');
    const recent = tasks.filter(t => t.LastExecutionResult?.EndTimeUtc && Date.now() - new Date(t.LastExecutionResult.EndTimeUtc).getTime() < 86400000);
    const max = showAll ? 20 : 3;

    if (running.length === 0 && recent.length === 0) return <section class="ao-section"><h2>Background work</h2><p class="ao-empty"><span class="ao-check">✓</span> All tasks idle</p></section>;
    return <section class="ao-section">
        <h2>Background work</h2>
        {running.map(t => {
            const pct = t.CurrentProgressPercentage;
            return <div class="ao-task" key={t.Id}><div class="ao-task-head"><span>{t.Name || 'Task'}</span><span class="ao-task-st active">{t.State}{pct != null ? ' ' + Math.round(pct) + '%' : ''}</span></div>{pct != null && <div class="ao-progress thick"><i style={{ width: Math.round(pct) + '%' }} /></div>}</div>;
        })}
        {running.length === 0 && recent.slice(0, max).map(t => {
            const ok = t.LastExecutionResult?.Status === 'Completed';
            return <div class="ao-task" key={t.Id}><div class="ao-task-head"><span>{t.Name || 'Task'}</span><span class={`ao-task-st ${ok ? 'ok' : 'fail'}`}>{ok ? 'Completed' : t.LastExecutionResult?.Status || t.State || '—'}</span></div><p class="ao-task-meta">{fmtAbs(t.LastExecutionResult!.EndTimeUtc!)}</p></div>;
        })}
        {recent.length > max && <button class="ao-expand" onClick={onToggle}>{showAll ? 'Less' : `Show ${recent.length} completed`}</button>}
    </section>;
}

function SystemAlertsAndFork({ activity, fork, tasteEval, seerrEnabled, ssoConfigured }: { activity: ServerActivityEntry[]; fork: ForkStatus | null; tasteEval: any; seerrEnabled: boolean; ssoConfigured: boolean }) {
    const alerts = activity.filter(a => a.Severity === 'Error' || a.Severity === 'Fatal' || a.Severity === 'Warning');
    const hasForkSignals = Boolean(fork?.cache || tasteEval || seerrEnabled || ssoConfigured);
    return <section class="ao-section">
        <h2>System health</h2>
        {alerts.length > 0 && alerts.slice(0, 4).map(a => <div class="ao-alert" key={a.Id}><span class={`ao-alert-dot ${a.Severity === 'Error' || a.Severity === 'Fatal' ? 'err' : 'warn'}`} /><div class="ao-alert-body"><p>{a.Name || a.Overview || a.ShortOverview || '—'}</p><span class="ao-alert-ts">{fmtAbs(a.Date)}</span></div></div>)}
        {alerts.length === 0 && !hasForkSignals && <p class="ao-empty"><span class="ao-check">✓</span> No active alerts</p>}
        {hasForkSignals && <div class="ao-fork">
            {fork?.cache && <div class="ao-fork-row"><span class="ao-dot" style={{ background: fork.cache.status === 'Ready' ? '#22c55e' : fork.cache.status === 'Disabled' ? '#9AA3AE' : '#f59e0b' }} />Query cache <span class="ao-fork-val">{fork.cache.backend} · {fork.cache.status}{fork.cache.hitRate ? ` · hit ${fork.cache.hitRate}` : ''}</span></div>}
            {tasteEval?.Latest?.CreatedAt && <div class="ao-fork-row"><span class="ao-dot" style={{ background: tasteEval.Latest.Succeeded ? '#22c55e' : '#f59e0b' }} />Taste model · refreshed {fmtAbs(tasteEval.Latest.CreatedAt)}{tasteEval.Latest.PrecisionAt10 != null ? ` · P@10 ${tasteEval.Latest.PrecisionAt10.toFixed(2)}` : ''}</div>}
            {tasteEval?.Status?.ForYouEngageRate != null && <div class="ao-fork-row"><span class="ao-dot" style={{ background: '#3b82f6' }} />For You engagement · {(tasteEval.Status.ForYouEngageRate * 100).toFixed(1)}%</div>}
            {ssoConfigured && <div class="ao-fork-row"><span class="ao-dot" style={{ background: '#22c55e' }} />SSO / RBAC · configured</div>}
            {seerrEnabled && <div class="ao-fork-row"><span class="ao-dot" style={{ background: '#3B82F6' }} />Seerr · configured</div>}
        </div>}
    </section>;
}

/* ========================= Helpers ========================= */

function fmtRelative(d?: string): string {
    if (!d) return '—';
    try { const diff = Date.now() - new Date(d).getTime(); const s = Math.floor(diff / 1000); if (s < 60) return s + 's'; const m = Math.floor(s / 60); if (m < 60) return m + 'm'; const h = Math.floor(m / 60); if (h < 24) return h + 'h'; return Math.floor(h / 24) + 'd'; } catch { return d; }
}

function fmtAbs(d: string | undefined): string {
    if (!d) return '—';
    try { return new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return d; }
}

function playbackMethodLabel(value?: string): string {
    if (!value) return 'Unknown';
    if (value.toLowerCase().includes('directplay')) return 'Direct Play';
    if (value.toLowerCase().includes('directstream')) return 'Remux';
    if (value.toLowerCase().includes('transcode')) return 'Transcode';
    return value;
}

function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return '';
    const gb = bytes / (1024 ** 3);
    return gb >= 1000 ? `${(gb / 1024).toFixed(1)} TB` : `${gb.toFixed(1)} GB`;
}
