import { useCallback, useEffect, useState } from 'preact/hooks';
import type { AdminApi } from '../admin-api';
import type { JellyfinSession, ListingsProviderInfo, TunerHostInfo } from '../types';
import { PageShell, Card, StatusChip, Empty, Tabs, DataTable, ConfirmButton, ConfigSection } from '../ui';
import { DVR_FIELDS } from '../server-settings';
import { AdminLiveTvTuners } from './admin-livetv-tuners';
import { AdminLiveTvGuide } from './admin-livetv-guide';
import { resourceErrors, settle } from '../admin-state';

interface Channel { Id?: string; Name?: string; Number?: string; Type?: string }

export function AdminLiveTv({ adminApi: api, onNavigate }: { adminApi: AdminApi; onNavigate: (section: string) => void }) {
    const [tab, setTab] = useState('Overview');
    const [info, setInfo] = useState<{ IsEnabled?: boolean; Services?: Array<{ Name?: string; HomePageUrl?: string }> } | null>(null);
    const [types, setTypes] = useState<Array<{ Id?: string; Name?: string }>>([]);
    const [channels, setChannels] = useState<Channel[]>([]);
    const [channelsTotal, setChannelsTotal] = useState(0);
    const [channelsMore, setChannelsMore] = useState(false);
    const [recordingsTotal, setRecordingsTotal] = useState(0);
    const [recordingsMore, setRecordingsMore] = useState(false);
    const [sessions, setSessions] = useState<JellyfinSession[]>([]);
    const [guide, setGuide] = useState<{ StartDate?: string; EndDate?: string } | null>(null);
    const [tuners, setTuners] = useState<TunerHostInfo[]>([]);
    const [providers, setProviders] = useState<ListingsProviderInfo[]>([]);
    const [timers, setTimers] = useState<Array<{ Id: string; Name?: string; StartDate?: string; Status?: string }>>([]);
    const [recordings, setRecordings] = useState<Array<{ Id: string; Name?: string; ProductionYear?: number }>>([]);
    const [multiviewUsers, setMultiviewUsers] = useState<string[]>([]);
    const [multiviewReported, setMultiviewReported] = useState(false);
    const [loadErrors, setLoadErrors] = useState<string[]>([]);
    const [active, setActive] = useState<Array<{ Id: string; Name?: string; ChannelName?: string; EndDate?: string }>>([]);
    const [seriesTimers, setSeriesTimers] = useState<Array<{ Id: string; Name?: string; ChannelName?: string; RecordAnyChannel?: boolean; RecordAnyTime?: boolean; RecordNewOnly?: boolean; KeepUpTo?: number }>>([]);
    const [dvrError, setDvrError] = useState('');

    const load = useCallback(async () => {
        const [iR, t, cR, sessR, g, configR, scheduled, recorded, users] = await Promise.all([
            settle(api.getLiveTvInfo(), 'request failed'), api.getTunerHostTypes().catch(() => []),
            settle(api.getLiveTvChannels(), 'request failed'), settle(api.getSessions(), 'request failed'),
            api.raw<{ StartDate?: string; EndDate?: string }>('/LiveTv/GuideInfo').catch(() => null),
            settle(api.getLiveTvConfig(), 'request failed'),
            api.raw<{ Items?: Array<{ Id: string; Name?: string; StartDate?: string; Status?: string }> }>('/LiveTv/Timers?IsScheduled=true').catch(() => null),
            api.raw<{ Items?: Array<{ Id: string; Name?: string; ProductionYear?: number }>; TotalRecordCount?: number }>('/LiveTv/Recordings?StartIndex=0&Limit=50&EnableTotalRecordCount=true').catch(() => null),
            api.getUsers().catch(() => []),
        ]);
        setLoadErrors(resourceErrors({ 'Live TV status': iR, Channels: cR, Sessions: sessR, 'Live TV configuration': configR }));
        const i = iR.ok ? iR.value : null, c = cR.ok ? cR.value : { Items: [] as Channel[], TotalRecordCount: 0 };
        const sess = sessR.ok ? sessR.value : [], config = configR.ok ? configR.value : null;
        setInfo(i); setTypes(t); setChannels(c.Items || []); setChannelsTotal(c.TotalRecordCount ?? (c.Items || []).length); setSessions(sess.filter(s => s.NowPlayingItem?.Type?.toLowerCase().includes('livetv'))); setGuide(g);
        setTuners(config?.TunerHosts || []); setProviders(config?.ListingProviders || []); setTimers(scheduled?.Items || []); setRecordings(recorded?.Items || []); setRecordingsTotal(recorded?.TotalRecordCount ?? (recorded?.Items || []).length);
        setMultiviewReported(users.some(u => 'EnableLiveTvMultiview' in (u.Policy || {})));
        setMultiviewUsers(users.filter(u => u.Policy?.EnableLiveTvMultiview === true).map(u => u.Name));
    }, [api]);
    useEffect(() => { load(); }, [load]);
    const loadDvr = useCallback(async () => {
        const [current, series] = await Promise.all([settle(api.getActiveRecordings(), 'request failed'), settle(api.getSeriesTimers(), 'request failed')]);
        if (current.ok) setActive(current.value);
        if (series.ok) setSeriesTimers(series.value);
        setDvrError(resourceErrors({ 'Active recordings': current, 'Series rules': series }).join('; '));
    }, [api]);
    useEffect(() => {
        if (tab !== 'Recordings') return;
        void loadDvr();
        const timer = window.setInterval(() => { if (!document.hidden) { void loadDvr(); void load(); } }, 30000);
        return () => window.clearInterval(timer);
    }, [tab, loadDvr, load]);

    const channelColumns = [
        { key: 'Number', label: 'Number', value: (c: Channel) => c.Number || '—' },
        { key: 'Name', label: 'Channel', value: (c: Channel) => c.Name || '—' },
        { key: 'Type', label: 'Type', value: (c: Channel) => c.Type || '—' },
        { key: 'Allowlist', label: 'RBAC', value: (_c: Channel) => <span class="ad-cell-sub">Configured in SSO mappings</span> },
    ];

    const hasLiveTv = info?.IsEnabled === true || tuners.length > 0 || channels.length > 0;
    return <PageShell title="Live TV" subtitle="Tuners, guide, channels, Multiview and RBAC allowlists">
        <Tabs tabs={['Overview', 'Tuners', 'Guide', 'Channels', 'Sessions', 'Recordings', 'DVR settings']} value={tab} onPick={setTab} />
        {loadErrors.length > 0 && <p role="alert" class="ad-error">Some Live TV data could not be loaded. {loadErrors.join('; ')}</p>}
        {tab === 'DVR settings' && <ConfigSection api={api} path="/System/Configuration/livetv" title="Recording settings" fields={DVR_FIELDS} note="Jellyfin has no global retention limit; per-series rules keep a set number of episodes." />}
        {!hasLiveTv && tab !== 'Tuners' && tab !== 'Guide' && tab !== 'DVR settings' && <Card title="Live TV"><Empty muted>{loadErrors.length ? 'Live TV status is unavailable' : 'Live TV is not configured on this server'}</Empty><button class="ad-btn" onClick={() => setTab('Tuners')}>Add tuner</button></Card>}
        {tab === 'Tuners' && <AdminLiveTvTuners api={api} tuners={tuners} types={types} onChanged={load} />}
        {tab === 'Guide' && <AdminLiveTvGuide api={api} providers={providers} tuners={tuners} onChanged={load} />}
        {hasLiveTv && tab === 'Overview' && <div class="ad-grid2">
            <Card title="Configured tuners" actions={<button class="ad-btn" onClick={() => setTab('Tuners')}>Manage tuners</button>}>{tuners.length ? tuners.map((t, index) => <div class="ad-info" key={t.Id || index}><span class="ad-info-k">{t.FriendlyName || t.Type || 'Tuner'}</span><StatusChip tone="blue">Configured</StatusChip></div>) : <Empty muted>No tuners configured</Empty>}{types.length > 0 && <p class="ad-note">Supported tuner types: {types.map(t => t.Name || t.Id).filter(Boolean).join(', ')}</p>}</Card>
            <Card title="Guide health" actions={<button class="ad-btn" onClick={() => setTab('Guide')}>Manage guide</button>}><div class="ad-info"><span class="ad-info-k">Guide providers</span><span class="ad-info-v">{providers.length}</span></div>{guide ? <><div class="ad-info"><span class="ad-info-k">Start</span><span class="ad-info-v">{guide.StartDate ? new Date(guide.StartDate).toLocaleString() : '—'}</span></div><div class="ad-info"><span class="ad-info-k">End</span><span class="ad-info-v">{guide.EndDate ? new Date(guide.EndDate).toLocaleString() : '—'}</span></div><div class="ad-info"><span class="ad-info-k">Channels</span><span class="ad-info-v">{channels.length}</span></div></> : <Empty muted>Guide data is unavailable</Empty>}</Card>
            {multiviewReported && <Card title="Multiview permissions"><p class="ad-note">{multiviewUsers.length ? `${multiviewUsers.join(', ')} can use Multiview.` : 'No users have Multiview permission.'}</p><button class="ad-btn" onClick={() => onNavigate('users')}>Manage permissions</button><p class="ad-note">The experimental viewing preference is per client. Active Multiview tiles are not reported by the server.</p></Card>}
            <Card title="RBAC allowlists" actions={<button class="ad-btn" onClick={() => onNavigate('users')}>Users & access</button>}><div class="ad-note">Live TV channel/category allowlists are defined by SSO group mappings.</div></Card>
        </div>}
        {hasLiveTv && tab === 'Channels' && <Card title="Channels"><DataTable rows={channels} columns={channelColumns} getKey={c => c.Id || c.Number || c.Name || ''} empty="No channels" />{channels.length < channelsTotal && <button class="ad-btn" disabled={channelsMore} onClick={async () => {
            if (channelsMore) return;
            setChannelsMore(true);
            try {
                const page = await api.getLiveTvChannels(channels.length);
                setChannels(current => current.concat((page.Items || []).filter(c => !current.some(existing => (existing.Id || existing.Number) === (c.Id || c.Number)))));
                setChannelsTotal(page.TotalRecordCount ?? channels.length);
            } catch (e) {
                setLoadErrors([`Channels: ${e instanceof Error ? e.message : 'request failed'}`]);
            } finally { setChannelsMore(false); }
        }}>{channelsMore ? 'Loading…' : `Show more (${channelsTotal - channels.length} remaining)`}</button>}</Card>}
        {hasLiveTv && tab === 'Sessions' && <Card title="Live TV sessions">{sessions.length === 0 ? <Empty muted>No active Live TV sessions</Empty> : sessions.map(s => <div class="ad-info" key={s.Id}><span class="ad-info-k">{s.UserName} · {s.Client}</span><span class="ad-info-v">{s.NowPlayingItem?.Name}</span></div>)}</Card>}
        {hasLiveTv && tab === 'Recordings' && <>
            {dvrError && <p role="alert" class="ad-error">Some DVR data could not be loaded. {dvrError}</p>}
            <p class="ad-note" role="status">Recording lists refresh every 30 seconds while this tab is open.</p>
            <Card title={`Recording now · ${active.length}`}>{active.length === 0 ? <Empty muted>Nothing is recording</Empty> : active.map(r => <div class="ad-info" key={r.Id}><span class="ad-info-k">{r.Name || 'Untitled'}{r.ChannelName ? ` · ${r.ChannelName}` : ''}</span><span class="ad-info-v">{r.EndDate ? `until ${new Date(r.EndDate).toLocaleTimeString()}` : 'In progress'}</span></div>)}</Card>
            <Card title="Series rules"><DataTable rows={seriesTimers} getKey={t => t.Id} empty="No series recording rules" columns={[
                { key: 'Name', label: 'Series', value: (t: typeof seriesTimers[number]) => t.Name || 'Untitled' },
                { key: 'Channel', label: 'Channel', value: (t: typeof seriesTimers[number]) => t.RecordAnyChannel ? 'Any channel' : t.ChannelName || '—' },
                { key: 'Rule', label: 'Rule', value: (t: typeof seriesTimers[number]) => [ t.RecordNewOnly ? 'New episodes' : 'All episodes', t.RecordAnyTime ? 'any time' : 'original time', t.KeepUpTo ? `keep ${t.KeepUpTo}` : 'keep all' ].join(' · ') },
                { key: 'Action', label: '', value: (t: typeof seriesTimers[number]) => <ConfirmButton label="Cancel series" tone="danger" onConfirm={async () => { await api.cancelSeriesTimer(t.Id); await loadDvr(); await load(); }} /> },
            ]} /></Card>
            <Card title="Upcoming recordings"><DataTable rows={timers} columns={[
                { key: 'Name', label: 'Programme', value: (t: typeof timers[number]) => t.Name || 'Untitled' },
                { key: 'Start', label: 'Starts', value: (t: typeof timers[number]) => t.StartDate ? new Date(t.StartDate).toLocaleString() : 'Not reported' },
                { key: 'State', label: 'State', value: (t: typeof timers[number]) => t.Status || 'Scheduled' },
                { key: 'Action', label: '', value: (t: typeof timers[number]) => <ConfirmButton label="Cancel recording" tone="danger" onConfirm={async () => { await api.cancelTimer(t.Id); await load(); }} /> },
            ]} getKey={t => t.Id} empty="No upcoming recordings" /></Card>
            <Card title="Recent recordings"><DataTable rows={recordings} columns={[
                { key: 'Name', label: 'Recording', value: (r: typeof recordings[number]) => r.Name || 'Untitled' },
                { key: 'Year', label: 'Year', value: (r: typeof recordings[number]) => r.ProductionYear || 'Not reported' },
                { key: 'Action', label: '', value: (r: typeof recordings[number]) => <ConfirmButton label="Delete recording" tone="danger" onConfirm={async () => { await api.deleteItem(r.Id); setRecordings(current => current.filter(x => x.Id !== r.Id)); setRecordingsTotal(total => Math.max(0, total - 1)); }} /> },
            ]} getKey={r => r.Id} empty="No recordings" />{recordings.length < recordingsTotal && <button class="ad-btn" disabled={recordingsMore} onClick={async () => {
                if (recordingsMore) return;
                setRecordingsMore(true);
                try {
                    const page = await api.raw<{ Items?: typeof recordings; TotalRecordCount?: number }>(`/LiveTv/Recordings?${new URLSearchParams({ StartIndex: String(recordings.length), Limit: '50', EnableTotalRecordCount: 'true' })}`);
                    setRecordings(current => current.concat((page.Items || []).filter(r => !current.some(existing => existing.Id === r.Id))));
                    setRecordingsTotal(page.TotalRecordCount ?? recordings.length);
                } finally { setRecordingsMore(false); }
            }}>{recordingsMore ? 'Loading…' : `Show more (${recordingsTotal - recordings.length} remaining)`}</button>}</Card>
        </>}
    </PageShell>;
}
