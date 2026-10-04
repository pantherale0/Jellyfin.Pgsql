import { useCallback, useEffect, useState } from 'preact/hooks';
import type { AdminApi } from '../admin-api';
import type { JellyfinSession } from '../types';
import { PageShell, Card, StatusChip, Empty, Tabs, DataTable, ConfirmButton } from '../ui';

interface Channel { Id?: string; Name?: string; Number?: string; Type?: string }

export function AdminLiveTv({ adminApi: api, onNavigate }: { adminApi: AdminApi; onNavigate: (section: string) => void }) {
    const [tab, setTab] = useState('Overview');
    const [info, setInfo] = useState<{ IsEnabled?: boolean; Services?: Array<{ Name?: string; HomePageUrl?: string }> } | null>(null);
    const [types, setTypes] = useState<Array<{ Id?: string; Name?: string }>>([]);
    const [channels, setChannels] = useState<Channel[]>([]);
    const [sessions, setSessions] = useState<JellyfinSession[]>([]);
    const [guide, setGuide] = useState<{ StartDate?: string; EndDate?: string } | null>(null);
    const [tuners, setTuners] = useState<Array<{ Id?: string; FriendlyName?: string; Type?: string }>>([]);
    const [timers, setTimers] = useState<Array<{ Id: string; Name?: string; StartDate?: string; Status?: string }>>([]);
    const [recordings, setRecordings] = useState<Array<{ Id: string; Name?: string; ProductionYear?: number }>>([]);
    const [multiviewUsers, setMultiviewUsers] = useState<string[]>([]);
    const [multiviewReported, setMultiviewReported] = useState(false);

    const load = useCallback(async () => {
        const [i, t, c, sess, g, config, scheduled, recorded, users] = await Promise.all([
            api.getLiveTvInfo().catch(() => null), api.getTunerHostTypes().catch(() => []),
            api.getLiveTvChannels().catch(() => ({ Items: [] as Channel[] })), api.getSessions().catch(() => []),
            api.raw<{ StartDate?: string; EndDate?: string }>('/LiveTv/GuideInfo').catch(() => null),
            api.raw<{ TunerHosts?: Array<{ Id?: string; FriendlyName?: string; Type?: string }> }>('/System/Configuration/livetv').catch(() => null),
            api.raw<{ Items?: Array<{ Id: string; Name?: string; StartDate?: string; Status?: string }> }>('/LiveTv/Timers?IsScheduled=true').catch(() => null),
            api.raw<{ Items?: Array<{ Id: string; Name?: string; ProductionYear?: number }> }>('/LiveTv/Recordings?Limit=50').catch(() => null),
            api.getUsers().catch(() => []),
        ]);
        setInfo(i); setTypes(t); setChannels(c.Items || []); setSessions(sess.filter(s => s.NowPlayingItem?.Type?.toLowerCase().includes('livetv'))); setGuide(g);
        setTuners(config?.TunerHosts || []); setTimers(scheduled?.Items || []); setRecordings(recorded?.Items || []);
        setMultiviewReported(users.some(u => 'EnableLiveTvMultiview' in (u.Policy || {})));
        setMultiviewUsers(users.filter(u => u.Policy?.EnableLiveTvMultiview === true).map(u => u.Name));
    }, [api]);
    useEffect(() => { load(); }, [load]);

    const channelColumns = [
        { key: 'Number', label: 'Number', value: (c: Channel) => c.Number || '—' },
        { key: 'Name', label: 'Channel', value: (c: Channel) => c.Name || '—' },
        { key: 'Type', label: 'Type', value: (c: Channel) => c.Type || '—' },
        { key: 'Allowlist', label: 'RBAC', value: (_c: Channel) => <span class="ad-cell-sub">Configured in SSO mappings</span> },
    ];

    const hasLiveTv = info?.IsEnabled === true || tuners.length > 0 || channels.length > 0;
    return <PageShell title="Live TV" subtitle="Tuners, guide, channels, Multiview and RBAC allowlists">
        <Tabs tabs={['Overview', 'Channels', 'Sessions', 'Recordings']} value={tab} onPick={setTab} />
        {!hasLiveTv && <Card title="Live TV"><Empty muted>Live TV is not configured on this server</Empty></Card>}
        {hasLiveTv && tab === 'Overview' && <div class="ad-grid2">
            <Card title="Configured tuners">{tuners.length ? tuners.map((t, index) => <div class="ad-info" key={t.Id || index}><span class="ad-info-k">{t.FriendlyName || t.Type || 'Tuner'}</span><StatusChip tone="blue">Configured</StatusChip></div>) : <Empty muted>No tuners configured</Empty>}{types.length > 0 && <p class="ad-note">Supported tuner types: {types.map(t => t.Name || t.Id).filter(Boolean).join(', ')}</p>}</Card>
            <Card title="Guide health">{guide ? <><div class="ad-info"><span class="ad-info-k">Start</span><span class="ad-info-v">{guide.StartDate ? new Date(guide.StartDate).toLocaleString() : '—'}</span></div><div class="ad-info"><span class="ad-info-k">End</span><span class="ad-info-v">{guide.EndDate ? new Date(guide.EndDate).toLocaleString() : '—'}</span></div><div class="ad-info"><span class="ad-info-k">Channels</span><span class="ad-info-v">{channels.length}</span></div></> : <Empty muted>Guide data is unavailable</Empty>}</Card>
            {multiviewReported && <Card title="Multiview permissions"><p class="ad-note">{multiviewUsers.length ? `${multiviewUsers.join(', ')} can use Multiview.` : 'No users have Multiview permission.'}</p><button class="ad-btn" onClick={() => onNavigate('users')}>Manage permissions</button><p class="ad-note">The experimental viewing preference is per client. Active Multiview tiles are not reported by the server.</p></Card>}
            <Card title="RBAC allowlists" actions={<button class="ad-btn" onClick={() => onNavigate('users')}>Users & access</button>}><div class="ad-note">Live TV channel/category allowlists are defined by SSO group mappings.</div></Card>
        </div>}
        {hasLiveTv && tab === 'Channels' && <Card title="Channels"><DataTable rows={channels} columns={channelColumns} getKey={c => c.Id || c.Number || c.Name || ''} empty="No channels" /></Card>}
        {hasLiveTv && tab === 'Sessions' && <Card title="Live TV sessions">{sessions.length === 0 ? <Empty muted>No active Live TV sessions</Empty> : sessions.map(s => <div class="ad-info" key={s.Id}><span class="ad-info-k">{s.UserName} · {s.Client}</span><span class="ad-info-v">{s.NowPlayingItem?.Name}</span></div>)}</Card>}
        {hasLiveTv && tab === 'Recordings' && <>
            <Card title="Upcoming recordings"><DataTable rows={timers} columns={[
                { key: 'Name', label: 'Programme', value: (t: typeof timers[number]) => t.Name || 'Untitled' },
                { key: 'Start', label: 'Starts', value: (t: typeof timers[number]) => t.StartDate ? new Date(t.StartDate).toLocaleString() : 'Not reported' },
                { key: 'State', label: 'State', value: (t: typeof timers[number]) => t.Status || 'Scheduled' },
                { key: 'Action', label: '', value: (t: typeof timers[number]) => <ConfirmButton label="Cancel recording" tone="danger" onConfirm={async () => { await api.cancelTimer(t.Id); await load(); }} /> },
            ]} getKey={t => t.Id} empty="No upcoming recordings" /></Card>
            <Card title="Recent recordings"><DataTable rows={recordings} columns={[
                { key: 'Name', label: 'Recording', value: (r: typeof recordings[number]) => r.Name || 'Untitled' },
                { key: 'Year', label: 'Year', value: (r: typeof recordings[number]) => r.ProductionYear || 'Not reported' },
            ]} getKey={r => r.Id} empty="No recordings" /></Card>
        </>}
    </PageShell>;
}
