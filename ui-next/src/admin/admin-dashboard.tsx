import { useState, useMemo, useCallback, useEffect } from 'preact/hooks';
import type { JellyfinApi } from '../api';
import { createAdminApi, type AdminApi } from './admin-api';
import type { AdminSection, SystemInfo } from './types';
import { AdminOverview } from './pages/admin-overview';
import { AdminUsers } from './pages/admin-users';
import { AdminSettings } from './pages/admin-settings';

interface AdminDashboardProps {
    api: JellyfinApi;
    session: { server: string; user: { Id: string; Name: string } };
    onBack: () => void;
}

const NAV: Array<{ id: AdminSection; label: string }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'users', label: 'Users & access' },
    { id: 'libraries', label: 'Libraries' },
    { id: 'playback', label: 'Playback' },
    { id: 'live-tv', label: 'Live TV' },
    { id: 'recommendations', label: 'Recommendations' },
    { id: 'infrastructure', label: 'Infrastructure' },
    { id: 'activity', label: 'Activity' },
    { id: 'system', label: 'System' },
];

export function AdminDashboard({ api, session, onBack }: AdminDashboardProps) {
    const [section, setSection] = useState<AdminSection>('overview');
    const [sidebarOpen, setSidebarOpen] = useState(true);
    const [sys, setSys] = useState<SystemInfo | null>(null);
    const [scanBusy, setScanBusy] = useState(false);
    const [restartBusy, setRestartBusy] = useState(false);
    const [showShutdown, setShowShutdown] = useState(false);
    const adminApi = useMemo(() => createAdminApi(api), [api]);
    const navigate = useCallback((s: string) => setSection(s as AdminSection), []);

    useEffect(() => { adminApi.getSystemInfo().then(setSys).catch(() => undefined); }, [adminApi]);
    useEffect(() => {
        const h = () => setSidebarOpen(window.innerWidth >= 1400);
        h(); window.addEventListener('resize', h); return () => window.removeEventListener('resize', h);
    }, []);

    const doScan = useCallback(async () => {
        setScanBusy(true); try { await adminApi.scanAllLibraries(); } catch {} setTimeout(() => setScanBusy(false), 2000);
    }, [adminApi]);
    const doRestart = useCallback(async () => { setRestartBusy(true); try { await adminApi.restartServer(); } catch {} }, [adminApi]);
    const doShutdown = useCallback(async () => { try { await adminApi.shutdownServer(); } catch { setShowShutdown(false); } }, [adminApi]);

    const uptime = sys?.RunTimeTicks ? Math.floor(sys.RunTimeTicks / 600000000 / 60) : 0;

    return <div class="admin-workspace">
        {!sidebarOpen && <button class="admin-menu-btn" onClick={() => setSidebarOpen(true)} aria-label="Open navigation">☰</button>}
        <nav class={`admin-sidebar${sidebarOpen ? ' open' : ''}`} aria-label="Admin">
            <div class="admin-sidebar-head">
                <button class="admin-back-link" onClick={onBack}>← Media</button>
                <span class="admin-sidebar-label">Server</span>
            </div>
            <div class="admin-sidebar-body">
                {NAV.map(n => <button key={n.id} class={`admin-nav${section === n.id ? ' active' : ''}`}
                    onClick={() => { setSection(n.id); if (window.innerWidth < 1400) setSidebarOpen(false); }}>{n.label}</button>)}
            </div>
            {window.innerWidth < 1400 && <div class="admin-sidebar-foot"><button class="admin-nav" onClick={() => setSidebarOpen(false)}>✕ Close</button></div>}
        </nav>
        {sidebarOpen && window.innerWidth < 1400 && <div class="admin-overlay" onClick={() => setSidebarOpen(false)} />}
        <main class="admin-content">
            <header class="admin-topbar">
                <div class="admin-topbar-left">
                    {!sidebarOpen && <button class="admin-back-link" onClick={onBack}>← Media</button>}
                    <span class="admin-topbar-name">{sys?.ServerName || 'Jellyfin'} {sys?.Version && <span class="admin-topbar-version">{sys.Version}</span>}</span>
                    {uptime > 0 && <span class="admin-topbar-uptime">Up {Math.floor(uptime / 24)}d {uptime % 24}h</span>}
                </div>
                <div class="admin-topbar-right">
                    <button class="admin-btn" onClick={doScan} disabled={scanBusy}>{scanBusy ? 'Scanning…' : 'Scan'}</button>
                    <button class="admin-btn" onClick={doRestart} disabled={restartBusy}>{restartBusy ? 'Restarting…' : 'Restart'}</button>
                    {!showShutdown
                        ? <button class="admin-btn danger" onClick={() => setShowShutdown(true)}>Shut down</button>
                        : <span class="admin-inline-confirm"><button class="admin-btn danger fill" onClick={doShutdown}>Confirm</button><button class="admin-btn" onClick={() => setShowShutdown(false)}>Cancel</button></span>}
                    <span class="admin-avatar">{session.user.Name[0]}</span>
                </div>
            </header>
            {section === 'overview' && <AdminOverview adminApi={adminApi} session={session} onNavigate={navigate} />}
            {section === 'users' && <AdminUsers api={adminApi} session={session} />}
            {section === 'infrastructure' && <AdminSettings api={adminApi} />}
            {['libraries', 'playback', 'live-tv', 'recommendations', 'activity', 'system'].includes(section) && <div class="admin-page"><h1 class="admin-page-title">{NAV.find(n => n.id === section)?.label}</h1><div class="admin-placeholder"><span>⊞</span><p>Coming soon</p></div></div>}
        </main>
    </div>;
}