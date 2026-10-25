import { useCallback, useEffect, useState } from 'preact/hooks';
import type { AdminApi } from '../admin-api';
import type { JellyfinSession, ListingsProviderInfo, TunerHostInfo } from '../types';
import { PageShell, Card, StatusChip, Empty, Tabs, DataTable, ConfirmButton, ConfigSection } from '../ui';
import { DVR_FIELDS } from '../server-settings';
import { AdminLiveTvTuners } from './admin-livetv-tuners';
import { AdminLiveTvGuide } from './admin-livetv-guide';
import { resourceErrors, settle } from '../admin-state';
import { t } from '../../i18n';

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
        { key: 'Number', label: t('Number'), value: (c: Channel) => c.Number || '—' },
        { key: 'Name', label: t('Channel'), value: (c: Channel) => c.Name || '—' },
        { key: 'Type', label: t('Type'), value: (c: Channel) => c.Type || '—' },
        { key: 'Allowlist', label: 'RBAC', value: (_c: Channel) => <span class="ad-cell-sub">{t('Configured in SSO mappings')}</span> },
    ];

    const hasLiveTv = info?.IsEnabled === true || tuners.length > 0 || channels.length > 0;
    return <PageShell title={t('Live TV')} subtitle={t('Tuners, guide, channels, Multiview and RBAC allowlists')}>
        <Tabs tabs={['Overview', 'Tuners', 'Guide', 'Channels', 'Sessions', 'Recordings', 'DVR settings']} value={tab} onPick={setTab} />
        {loadErrors.length > 0 && <p role="alert" class="ad-error">{t('Some Live TV data could not be loaded. {0}', loadErrors.join('; '))}</p>}
        {tab === 'DVR settings' && <ConfigSection api={api} path="/System/Configuration/livetv" title={t('Recording settings')} fields={DVR_FIELDS} note={t('Jellyfin has no global retention limit; per-series rules keep a set number of episodes.')} />}
        {!hasLiveTv && tab !== 'Tuners' && tab !== 'Guide' && tab !== 'DVR settings' && <Card title={t('Live TV')}><Empty muted>{loadErrors.length ? t('Live TV status is unavailable') : t('Live TV is not configured on this server')}</Empty><button class="ad-btn" onClick={() => setTab('Tuners')}>{t('Add tuner')}</button></Card>}
        {tab === 'Tuners' && <AdminLiveTvTuners api={api} tuners={tuners} types={types} onChanged={load} />}
        {tab === 'Guide' && <AdminLiveTvGuide api={api} providers={providers} tuners={tuners} onChanged={load} />}
        {hasLiveTv && tab === 'Overview' && <div class="ad-grid2">
            <Card title={t('Configured tuners')} actions={<button class="ad-btn" onClick={() => setTab('Tuners')}>{t('Manage tuners')}</button>}>{tuners.length ? tuners.map((tuner, index) => <div class="ad-info" key={tuner.Id || index}><span class="ad-info-k">{tuner.FriendlyName || tuner.Type || t('Tuner')}</span><StatusChip tone="blue">{t('Configured')}</StatusChip></div>) : <Empty muted>{t('No tuners configured')}</Empty>}{types.length > 0 && <p class="ad-note">{t('Supported tuner types: {0}', types.map(tuner => tuner.Name || tuner.Id).filter(Boolean).join(', '))}</p>}</Card>
            <Card title={t('Guide health')} actions={<button class="ad-btn" onClick={() => setTab('Guide')}>{t('Manage guide')}</button>}><div class="ad-info"><span class="ad-info-k">{t('Guide providers')}</span><span class="ad-info-v">{providers.length}</span></div>{guide ? <><div class="ad-info"><span class="ad-info-k">{t('Start')}</span><span class="ad-info-v">{guide.StartDate ? new Date(guide.StartDate).toLocaleString() : '—'}</span></div><div class="ad-info"><span class="ad-info-k">{t('End')}</span><span class="ad-info-v">{guide.EndDate ? new Date(guide.EndDate).toLocaleString() : '—'}</span></div><div class="ad-info"><span class="ad-info-k">{t('Channels')}</span><span class="ad-info-v">{channels.length}</span></div></> : <Empty muted>{t('Guide data is unavailable')}</Empty>}</Card>
            {multiviewReported && <Card title={t('Multiview permissions')}><p class="ad-note">{multiviewUsers.length ? t('{0} can use Multiview.', multiviewUsers.join(', ')) : t('No users have Multiview permission.')}</p><button class="ad-btn" onClick={() => onNavigate('users')}>{t('Manage permissions')}</button><p class="ad-note">{t('The experimental viewing preference is per client. Active Multiview tiles are not reported by the server.')}</p></Card>}
            <Card title={t('RBAC allowlists')} actions={<button class="ad-btn" onClick={() => onNavigate('users')}>{t('Users & access')}</button>}><div class="ad-note">{t('Live TV channel/category allowlists are defined by SSO group mappings.')}</div></Card>
        </div>}
        {hasLiveTv && tab === 'Channels' && <Card title={t('Channels')}><DataTable rows={channels} columns={channelColumns} getKey={c => c.Id || c.Number || c.Name || ''} empty={t('No channels')} />{channels.length < channelsTotal && <button class="ad-btn" disabled={channelsMore} onClick={async () => {
            if (channelsMore) return;
            setChannelsMore(true);
            try {
                const page = await api.getLiveTvChannels(channels.length);
                setChannels(current => current.concat((page.Items || []).filter(c => !current.some(existing => (existing.Id || existing.Number) === (c.Id || c.Number)))));
                setChannelsTotal(page.TotalRecordCount ?? channels.length);
            } catch (e) {
                setLoadErrors([`Channels: ${e instanceof Error ? e.message : 'request failed'}`]);
            } finally { setChannelsMore(false); }
        }}>{channelsMore ? t('Loading…') : t('Show more ({0} remaining)', channelsTotal - channels.length)}</button>}</Card>}
        {hasLiveTv && tab === 'Sessions' && <Card title={t('Live TV sessions')}>{sessions.length === 0 ? <Empty muted>{t('No active Live TV sessions')}</Empty> : sessions.map(s => <div class="ad-info" key={s.Id}><span class="ad-info-k">{s.UserName} · {s.Client}</span><span class="ad-info-v">{s.NowPlayingItem?.Name}</span></div>)}</Card>}
        {hasLiveTv && tab === 'Recordings' && <>
            {dvrError && <p role="alert" class="ad-error">{t('Some DVR data could not be loaded. {0}', dvrError)}</p>}
            <p class="ad-note" role="status">{t('Recording lists refresh every 30 seconds while this tab is open.')}</p>
            <Card title={t('Recording now · {0}', active.length)}>{active.length === 0 ? <Empty muted>{t('Nothing is recording')}</Empty> : active.map(r => <div class="ad-info" key={r.Id}><span class="ad-info-k">{r.Name || t('Untitled')}{r.ChannelName ? ` · ${r.ChannelName}` : ''}</span><span class="ad-info-v">{r.EndDate ? t('until {0}', new Date(r.EndDate).toLocaleTimeString()) : t('In progress')}</span></div>)}</Card>
            <Card title={t('Series rules')}><DataTable rows={seriesTimers} getKey={timer => timer.Id} empty={t('No series recording rules')} columns={[
                { key: 'Name', label: t('Series'), value: (timer: typeof seriesTimers[number]) => timer.Name || 'Untitled' },
                { key: 'Channel', label: t('Channel'), value: (timer: typeof seriesTimers[number]) => timer.RecordAnyChannel ? 'Any channel' : timer.ChannelName || '—' },
                { key: 'Rule', label: t('Rule'), value: (timer: typeof seriesTimers[number]) => [ timer.RecordNewOnly ? 'New episodes' : 'All episodes', timer.RecordAnyTime ? 'any time' : 'original time', timer.KeepUpTo ? `keep ${timer.KeepUpTo}` : 'keep all' ].join(' · ') },
                { key: 'Action', label: '', value: (timer: typeof seriesTimers[number]) => <ConfirmButton label={t('Cancel series')} tone="danger" onConfirm={async () => { await api.cancelSeriesTimer(timer.Id); await loadDvr(); await load(); }} /> },
            ]} /></Card>
            <Card title={t('Upcoming recordings')}><DataTable rows={timers} columns={[
                { key: 'Name', label: t('Programme'), value: (timer: typeof timers[number]) => timer.Name || 'Untitled' },
                { key: 'Start', label: t('Starts'), value: (timer: typeof timers[number]) => timer.StartDate ? new Date(timer.StartDate).toLocaleString() : 'Not reported' },
                { key: 'State', label: t('State'), value: (timer: typeof timers[number]) => timer.Status || 'Scheduled' },
                { key: 'Action', label: '', value: (timer: typeof timers[number]) => <ConfirmButton label={t('Cancel recording')} tone="danger" onConfirm={async () => { await api.cancelTimer(timer.Id); await load(); }} /> },
            ]} getKey={timer => timer.Id} empty={t('No upcoming recordings')} /></Card>
            <Card title={t('Recent recordings')}><DataTable rows={recordings} columns={[
                { key: 'Name', label: t('Recording'), value: (r: typeof recordings[number]) => r.Name || 'Untitled' },
                { key: 'Year', label: t('Year'), value: (r: typeof recordings[number]) => r.ProductionYear || 'Not reported' },
                { key: 'Action', label: '', value: (r: typeof recordings[number]) => <ConfirmButton label={t('Delete recording')} tone="danger" onConfirm={async () => { await api.deleteItem(r.Id); setRecordings(current => current.filter(x => x.Id !== r.Id)); setRecordingsTotal(total => Math.max(0, total - 1)); }} /> },
            ]} getKey={r => r.Id} empty={t('No recordings')} />{recordings.length < recordingsTotal && <button class="ad-btn" disabled={recordingsMore} onClick={async () => {
                if (recordingsMore) return;
                setRecordingsMore(true);
                try {
                    const page = await api.raw<{ Items?: typeof recordings; TotalRecordCount?: number }>(`/LiveTv/Recordings?${new URLSearchParams({ StartIndex: String(recordings.length), Limit: '50', EnableTotalRecordCount: 'true' })}`);
                    setRecordings(current => current.concat((page.Items || []).filter(r => !current.some(existing => existing.Id === r.Id))));
                    setRecordingsTotal(page.TotalRecordCount ?? recordings.length);
                } finally { setRecordingsMore(false); }
            }}>{recordingsMore ? t('Loading…') : t('Show more ({0} remaining)', recordingsTotal - recordings.length)}</button>}</Card>
        </>}
    </PageShell>;
}
