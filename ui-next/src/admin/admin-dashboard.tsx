import { useState, useMemo, useCallback, useEffect, useRef } from 'preact/hooks';
import { useDialogFocus } from '../dialog-focus';
import type { JellyfinApi } from '../api';
import { createAdminApi, type AdminApi } from './admin-api';
import type { AdminSection, SystemInfo } from './types';
import { AdminOverview } from './pages/admin-overview';
import { AdminUsers } from './pages/admin-users';
import { AdminInfrastructure } from './pages/admin-infrastructure';
import { AdminPlayback } from './pages/admin-playback';
import { AdminActivity } from './pages/admin-activity';
import { AdminLibraries } from './pages/admin-libraries';
import { AdminLiveTv } from './pages/admin-livetv';
import { AdminRecommendations } from './pages/admin-recommendations';
import { AdminSystem } from './pages/admin-system';
import { AdminAllPlugins } from './pages/admin-all-plugins';
import { AdminPluginPostgres } from './pages/admin-plugin-postgres';
import { AdminPluginSeerr } from './pages/admin-plugin-seerr';
import { AdminPluginTmdb } from './pages/admin-plugin-tmdb';
import { AdminPluginGeneric } from './pages/admin-plugin-generic';
import { ConfirmButton } from './ui';
import type { PluginInfo } from './types';
import { adminRouteHash, confirmLeave, parseAdminRoute, pluginSection } from './admin-state';

interface AdminDashboardProps {
    api: JellyfinApi;
    session: { server: string; user: { Id: string; Name: string } };
    onBack: () => void;
}

const CORE_NAV: Array<{ id: AdminSection | string; label: string }> = [
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

interface PluginConfigPage {
    Name: string;
    DisplayName: string;
    PluginId: string;
    EnableInMainMenu: boolean;
}

const FIRST_CLASS = new Set(['postgresql database', 'seerr', 'tmdb']);

export function AdminDashboard({ api, session, onBack }: AdminDashboardProps) {
    const [section, setSection] = useState<AdminSection | string>('overview');
    const [sidebarOpen, setSidebarOpen] = useState(true);
    const [sidebarOverlay, setSidebarOverlay] = useState(() => window.innerWidth < 1400);
    const sidebarRef = useRef<HTMLElement>(null);
    useDialogFocus(sidebarRef, sidebarOpen && sidebarOverlay, () => setSidebarOpen(false), {
        initial: '.admin-nav.active, .admin-nav',
        fallback: () => document.querySelector<HTMLElement>('.admin-menu-btn')
    });
    const [sys, setSys] = useState<SystemInfo | null>(null);
    const [actionMessage, setActionMessage] = useState('');
    const [pluginPages, setPluginPages] = useState<PluginConfigPage[]>([]);
    const [pluginNavId, setPluginNavId] = useState('');
    const adminApi = useMemo(() => createAdminApi(api), [api]);
    const navigate = useCallback((s: string) => {
        if (!confirmLeave(message => window.confirm(message))) return;
        setSection(s);
        const url = new URL(window.location.href);
        url.hash = adminRouteHash(s);
        if (window.location.hash !== url.hash) window.history.pushState(null, '', url.toString());
        setSidebarOpen(window.innerWidth >= 1400);
        window.scrollTo(0, 0);
    }, []);

    const leaveAdmin = useCallback(() => { if (confirmLeave(message => window.confirm(message))) onBack(); }, [onBack]);

    useEffect(() => {
        const route = () => {
            const next = parseAdminRoute(window.location.hash);
            if (next) setSection(next);
        };
        route(); window.addEventListener('popstate', route); window.addEventListener('hashchange', route);
        return () => { window.removeEventListener('popstate', route); window.removeEventListener('hashchange', route); };
    }, []);

    useEffect(() => { adminApi.getSystemInfo().then(setSys).catch(() => undefined); }, [adminApi]);
    useEffect(() => {
        const media = window.matchMedia('(min-width: 1400px)');
        const h = () => { setSidebarOpen(media.matches); setSidebarOverlay(!media.matches); };
        h(); media.addEventListener('change', h); return () => media.removeEventListener('change', h);
    }, []);

    useEffect(() => {
        adminApi.raw<PluginConfigPage[]>('/web/ConfigurationPages').then(pages => {
            setPluginPages(pages || []);
            if (pages?.length && !pluginNavId) setPluginNavId(pluginSection(pages[0].PluginId));
        }).catch(() => undefined);
    }, [adminApi]);

    const isPlugin = (id: string) => id.startsWith('plugin-') || id === 'plugins';
    const activePlugin = isPlugin(section) && section !== 'plugins' ? pluginPages.find(p => section === pluginSection(p.PluginId)) : null;

    const doScan = useCallback(async () => {
        setActionMessage('');
        try { await adminApi.scanAllLibraries(); setActionMessage('Library scan requested. Follow progress in scheduled tasks.'); }
        catch (e) { setActionMessage(e instanceof Error ? e.message : 'Library scan request failed.'); }
    }, [adminApi]);
    const doRestart = useCallback(async () => { await adminApi.restartServer(); setActionMessage('Restart requested.'); }, [adminApi]);
    const doShutdown = useCallback(async () => { await adminApi.shutdownServer(); setActionMessage('Shutdown requested.'); }, [adminApi]);

    return <div class="admin-workspace">
        {!sidebarOpen && <button class="admin-menu-btn" onClick={() => setSidebarOpen(true)} aria-label="Open navigation">☰</button>}
        <nav ref={sidebarRef} class={`admin-sidebar${sidebarOpen ? ' open' : ''}`} aria-label="Admin" aria-hidden={!sidebarOpen} inert={!sidebarOpen} role={sidebarOverlay && sidebarOpen ? 'dialog' : undefined} aria-modal={sidebarOverlay && sidebarOpen ? true : undefined}>
            <div class="admin-sidebar-head">
                <button class="admin-back-link" onClick={leaveAdmin}>← Media</button>
                <span class="admin-sidebar-label">Server</span>
            </div>
            <div class="admin-sidebar-body">
                {CORE_NAV.map(n => <button key={n.id} class={`admin-nav${section === n.id ? ' active' : ''}`}
                    aria-current={section === n.id ? 'page' : undefined} onClick={() => navigate(n.id)}>{n.label}</button>)}
                {pluginPages.length > 0 && <>
                    <div class="admin-nav-divider" role="separator" />
                    <p class="admin-nav-group-label">Plugins</p>
                    <button class={`admin-nav${section === 'plugins' ? ' active' : ''}`} aria-current={section === 'plugins' ? 'page' : undefined} onClick={() => navigate('plugins')}>All plugins</button>
                    {pluginPages.filter(page => {
                        const lower = (page.Name || '').toLowerCase();
                        return !FIRST_CLASS.has(lower);
                    }).slice(0, 20).map(p => <button key={p.PluginId} class={`admin-nav${section === `plugin-${p.PluginId}` ? ' active' : ''}`}
                        aria-current={section === `plugin-${p.PluginId}` ? 'page' : undefined} onClick={() => navigate(`plugin-${p.PluginId}`)}>{p.DisplayName || p.Name}</button>)}
                </>}
            </div>
            {sidebarOverlay && <div class="admin-sidebar-foot"><button class="admin-nav" onClick={() => setSidebarOpen(false)}>✕ Close</button></div>}
        </nav>
        {sidebarOpen && sidebarOverlay && <div class="admin-overlay" data-dialog-backdrop onClick={() => setSidebarOpen(false)} />}
        <main class="admin-content">
            <header class="admin-topbar">
                <div class="admin-topbar-left">
                    {!sidebarOpen && <button class="admin-back-link" onClick={leaveAdmin}>← Media</button>}
                    <span class="admin-topbar-name">{sys?.ServerName || 'Jellyfin'} {sys?.Version && <span class="admin-topbar-version">{sys.Version}</span>}</span>
                    {sys?.HasPendingRestart && <span class="admin-topbar-uptime">Restart pending</span>}
                </div>
                <div class="admin-topbar-right">
                    <button class="admin-btn" onClick={doScan}>Scan</button>
                    <ConfirmButton label="Restart" onConfirm={doRestart} />
                    <ConfirmButton label="Shut down" tone="danger" onConfirm={doShutdown} />
                    <span class="admin-avatar" aria-label={`Signed in as ${session.user.Name}`} title={session.user.Name}>{session.user.Name[0]}</span>
                </div>
            </header>
            {actionMessage && <p role="status" class="ad-shell-message">{actionMessage}</p>}
            {section === 'overview' && <AdminOverview adminApi={adminApi} session={session} onNavigate={navigate} />}
            {section === 'users' && <AdminUsers adminApi={adminApi} session={session} />}
            {section === 'infrastructure' && <AdminInfrastructure adminApi={adminApi} />}
            {section === 'playback' && <AdminPlayback adminApi={adminApi} />}
            {section === 'activity' && <AdminActivity adminApi={adminApi} />}
            {section === 'libraries' && <AdminLibraries adminApi={adminApi} />}
            {section === 'live-tv' && <AdminLiveTv adminApi={adminApi} onNavigate={navigate} />}
            {section === 'recommendations' && <AdminRecommendations adminApi={adminApi} />}
            {section === 'system' && <AdminSystem adminApi={adminApi} />}
            {section === 'plugins' && <AdminAllPlugins adminApi={adminApi} onNavigate={navigate} configurablePluginIds={pluginPages.map(p => p.PluginId)} />}
            {isPlugin(section) && activePlugin && <PluginRouter name={activePlugin.Name || ''} displayName={activePlugin.DisplayName || activePlugin.Name || 'Plugin'} pluginId={activePlugin.PluginId} adminApi={adminApi} session={session} />}
            {isPlugin(section) && section !== 'plugins' && !activePlugin && pluginPages.length > 0 && <div class="ad-page"><h1 class="ad-page-title">Plugin not found</h1><p class="ad-note">The plugin configuration page could not be loaded. It may have been disabled or removed.</p></div>}
            {(!section || !CORE_NAV.some(n => n.id === section) && !isPlugin(section)) && <div class="ad-page"><h1 class="ad-page-title">Unknown section</h1><p class="ad-note">The requested admin section could not be found.</p></div>}
        </main>
    </div>;
}

function PluginRouter({ name, displayName, pluginId, adminApi, session }: {
    name: string; displayName: string; pluginId: string; adminApi: AdminApi; session: { server: string; user: { Id: string } };
}) {
    const [plugin, setPlugin] = useState<PluginInfo | null>(null);
    useEffect(() => {
        let active = true;
        setPlugin(null);
        adminApi.getPlugins().then(list => { if (active) setPlugin(list.find(p => p.Id === pluginId) || null); }).catch(() => undefined);
        return () => { active = false; };
    }, [adminApi, pluginId]);

    const lower = name.toLowerCase();
    if (lower.includes('postgresql database')) return <AdminPluginPostgres key={pluginId} adminApi={adminApi} plugin={plugin || { Name: name, Id: pluginId } as PluginInfo} session={session} />;
    if (lower.includes('seerr')) return <AdminPluginSeerr key={pluginId} adminApi={adminApi} plugin={plugin || { Name: name, Id: pluginId } as PluginInfo} session={session} />;
    if (lower.includes('tmdb')) return <AdminPluginTmdb key={pluginId} adminApi={adminApi} plugin={plugin || { Name: name, DisplayName: displayName, Id: pluginId } as PluginInfo} session={session} />;
    return <AdminPluginGeneric key={pluginId} adminApi={adminApi} plugin={plugin || { Name: name, DisplayName: displayName, Id: pluginId } as PluginInfo} session={session} />;
}
