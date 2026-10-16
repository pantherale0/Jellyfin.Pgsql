import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { RequestTimeoutError } from '../../api';
import { useDialogFocus } from '../../dialog-focus';
import type { AdminApi } from '../admin-api';
import type { PackageInfo, PackageVersion, PluginInfo, RepositoryInfo } from '../types';
import { pluginSection } from '../admin-state';
import {
    compareVersions, installErrorMessage, isTrustedRepository, mergeCatalog, needsRestart, normalizeGuid, validateRepository, versionAction,
    type CatalogRow, type VersionAction,
} from '../plugin-catalog';
import { RESTART_MESSAGES, waitForRestart } from '../server-restart';
import { PageShell, Card, StatusChip, SearchInput, FilterPills, Empty, DataTable, ConfirmButton, Tabs, fmtDate } from '../ui';
import { t } from '../../i18n';

const TABS = [ 'Installed', 'Catalog', 'Repositories' ];
const INSTALL_POLL_MS = 5000;
const INSTALL_POLL_LIMIT_MS = 2 * 60_000;
const ACTION_LABEL: Record<VersionAction, string> = { install: 'Install', update: 'Update', reinstall: 'Reinstall', downgrade: 'Downgrade' };

export function AdminAllPlugins({ adminApi: api, onNavigate, configurablePluginIds }: { adminApi: AdminApi; onNavigate: (section: string) => void; configurablePluginIds: string[] }) {
    const [tab, setTab] = useState('Installed');
    const [plugins, setPlugins] = useState<PluginInfo[]>([]);
    const [packages, setPackages] = useState<PackageInfo[] | null>(null);
    const [packagesError, setPackagesError] = useState('');
    const [search, setSearch] = useState('');
    const [filter, setFilter] = useState('All');
    const [category, setCategory] = useState('All');
    const [busy, setBusy] = useState('');
    const [loadError, setLoadError] = useState('');
    const [message, setMessage] = useState('');
    const [changed, setChanged] = useState(false);
    const [restartState, setRestartState] = useState('');
    const [sheetId, setSheetId] = useState('');
    const generation = useRef(0);
    useEffect(() => () => { generation.current += 1; }, [api]);

    const loadPlugins = useCallback(async () => {
        const gen = generation.current;
        setLoadError('');
        try {
            const next = await api.getPlugins();
            if (gen === generation.current) setPlugins(next);
            return next;
        } catch (e) {
            if (gen === generation.current) setLoadError(e instanceof Error ? e.message : t('Plugin list failed.'));
            return null;
        }
    }, [api]);
    const loadPackages = useCallback(async () => {
        const gen = generation.current;
        setPackagesError('');
        try {
            const next = await api.getPackages();
            if (gen === generation.current) setPackages(next);
        } catch (e) {
            if (gen === generation.current) setPackagesError(e instanceof Error ? e.message : t('The plugin catalog could not be loaded.'));
        }
    }, [api]);
    const load = useCallback(() => Promise.all([ loadPlugins(), loadPackages() ]), [loadPlugins, loadPackages]);
    useEffect(() => { void load(); }, [load]);

    const rows = useMemo(() => mergeCatalog(plugins, packages || []), [plugins, packages]);
    const sheetRow = sheetId ? rows.find(row => row.id === sheetId) || null : null;

    const toggle = async (row: CatalogRow, enable: boolean) => {
        const plugin = row.installed;
        if (!plugin?.Id || row.protected) return;
        const gen = generation.current;
        setBusy(row.id); setMessage('');
        try {
            const version = String(plugin.Version);
            if (enable) await api.enablePlugin(plugin.Id, version);
            else await api.disablePlugin(plugin.Id, version);
            if (gen !== generation.current) return;
            await loadPlugins();
            setMessage(`${row.name} ${enable ? 'enabled' : 'disabled'}. Restart the server for the change to take effect.`);
        } catch (e) {
            if (gen === generation.current) setLoadError(e instanceof Error ? e.message : t('Plugin change failed.'));
        } finally {
            if (gen === generation.current) setBusy('');
        }
    };

    const waitForInstall = async (id: string, version: string, gen: number): Promise<boolean> => {
        const deadline = Date.now() + INSTALL_POLL_LIMIT_MS;
        while (Date.now() < deadline) {
            await new Promise(resolve => window.setTimeout(resolve, INSTALL_POLL_MS));
            if (gen !== generation.current) return false;
            const next = await api.getPlugins().catch(() => null);
            if (gen !== generation.current) return false;
            if (next?.some(plugin => normalizeGuid(plugin.Id) === id && compareVersions(plugin.Version, version) === 0)) {
                setPlugins(next);
                return true;
            }
        }
        return false;
    };

    /** Throws a user-facing error so ConfirmButton and the sheet can show it in place. */
    const install = async (row: CatalogRow, version: PackageVersion) => {
        if (!row.packageName) throw new Error(t('This plugin is not in any enabled repository.'));
        const gen = generation.current;
        setBusy(row.id); setMessage('');
        try {
            await api.installPackage({ name: row.packageName, id: row.id, version: version.version, repositoryUrl: version.repositoryUrl });
            if (gen !== generation.current) return;
            setChanged(true);
            setMessage(t('{0} {1} installed. Restart the server to finish.', row.name, version.version));
            await loadPlugins();
        } catch (e) {
            if (gen !== generation.current) return;
            if (e instanceof RequestTimeoutError) {
                setMessage(t('{0} {1} is still installing on the server…', row.name, version.version));
                const done = await waitForInstall(row.id, version.version, gen);
                if (gen !== generation.current) return;
                setChanged(true);
                setMessage(done
                    ? t('{0} {1} installed. Restart the server to finish.', row.name, version.version)
                    : t('{0} {1} did not finish installing within two minutes. Check the server log, then refresh.', row.name, version.version));
                return;
            }
            throw new Error(installErrorMessage(e));
        } finally {
            if (gen === generation.current) setBusy('');
        }
    };

    const uninstall = async (row: CatalogRow) => {
        const plugin = row.installed;
        if (!plugin?.Id || row.protected || row.bundled) return;
        const gen = generation.current;
        setBusy(row.id); setMessage('');
        try {
            await api.uninstallPlugin(plugin.Id, String(plugin.Version));
            if (gen !== generation.current) return;
            setChanged(true);
            setSheetId('');
            setMessage(t('{0} will be removed when the server restarts.', row.name));
            await loadPlugins();
        } catch (e) {
            if (gen === generation.current) throw new Error(e instanceof Error ? e.message : t('The plugin could not be uninstalled.'));
        } finally {
            if (gen === generation.current) setBusy('');
        }
    };

    const restart = async () => {
        await api.restartServer();
        const gen = generation.current;
        const back = await waitForRestart(api, setRestartState, RESTART_MESSAGES);
        if (back && gen === generation.current) { setChanged(false); void load(); }
    };

    const installedRows = rows.filter(row => row.installed).filter(row => {
        const status = row.installed?.Status;
        if (filter === 'Enabled' && status !== 'Active') return false;
        if (filter === 'Disabled' && status === 'Active') return false;
        if (filter === 'Updates' && !row.updateAvailable) return false;
        return true;
    });
    const catalogRows = rows.filter(row => !row.installed && row.latest);
    const categories = [ 'All', ...Array.from(new Set(catalogRows.map(row => row.category).filter((value): value is string => Boolean(value)))).sort() ];
    const visibleCatalog = catalogRows.filter(row => category === 'All' || row.category === category);
    const updates = rows.filter(row => row.updateAvailable).length;
    const restartPending = changed || needsRestart(plugins);

    const installedColumns = [
        { key: 'Name', label: t('Plugin'), value: (row: CatalogRow) => <><strong>{row.name}</strong><div class="ad-cell-sub">{row.installed?.Version || '—'}{row.updateAvailable && row.latest ? ` → ${row.latest.version}` : ''}</div></>, searchValue: (row: CatalogRow) => `${row.name} ${row.description || ''}` },
        { key: 'Description', label: t('Description'), value: (row: CatalogRow) => row.description || '—', searchValue: (row: CatalogRow) => row.description || '' },
        { key: 'Status', label: t('Status'), value: (row: CatalogRow) => <span class="ad-flex" style="gap:6px;flex-wrap:wrap">
            <StatusChip tone={row.installed?.Status === 'Active' ? 'green' : row.installed?.Status === 'Malfunctioned' ? 'red' : row.installed?.Status === 'Restart' ? 'amber' : 'muted'}>{row.installed?.Status === 'Restart' ? t('Restart required') : row.installed?.Status || t('Unknown')}</StatusChip>
            {row.updateAvailable && <StatusChip tone="blue">{t('Update available')}</StatusChip>}
        </span> },
        { key: 'Actions', label: '', value: (row: CatalogRow) => {
            const isBusy = busy === row.id;
            const plugin = row.installed!;
            const configurable = Boolean(plugin.Id) && configurablePluginIds.includes(plugin.Id!);
            const latest = row.latest;
            return <div class="ad-flex" style="gap:6px;flex-wrap:wrap">
                <button class="ad-btn" disabled={isBusy} onClick={() => setSheetId(row.id)}>{t('Details')}</button>
                {configurable && <button class="ad-btn" disabled={isBusy} onClick={() => onNavigate(pluginSection(plugin.Id!))}>{t('Configure')}</button>}
                {row.updateAvailable && latest && (isTrustedRepository(latest.repositoryUrl)
                    ? <ConfirmButton label={t('Update')} confirmLabel={t('Update to {0}', latest.version)} busy={isBusy} onConfirm={() => install(row, latest)} />
                    : <button class="ad-btn" disabled={isBusy} onClick={() => setSheetId(row.id)}>{t('Update…')}</button>)}
                {!row.protected && (plugin.Status === 'Active'
                    ? <ConfirmButton label={t('Disable')} tone="danger" busy={isBusy} onConfirm={() => toggle(row, false)} />
                    : <ConfirmButton label={t('Enable')} busy={isBusy} onConfirm={() => toggle(row, true)} />)}
                {!row.protected && !row.bundled && <ConfirmButton label={t('Uninstall')} tone="danger" confirmLabel={t('Uninstall plugin')} busy={isBusy} onConfirm={() => uninstall(row)} />}
                {row.protected && <span class="ad-note ad-inline-note">{t('Required by the PostgreSQL database')}</span>}
            </div>;
        } },
    ];

    const catalogColumns = [
        { key: 'Name', label: t('Plugin'), value: (row: CatalogRow) => <><strong>{row.name}</strong><div class="ad-cell-sub">{row.description || ''}</div></>, searchValue: (row: CatalogRow) => `${row.name} ${row.description || ''} ${row.owner || ''}` },
        { key: 'Category', label: t('Category'), value: (row: CatalogRow) => row.category || '—' },
        { key: 'Repository', label: t('Repository'), value: (row: CatalogRow) => <>{row.latest?.repositoryName || '—'}{row.latest && !isTrustedRepository(row.latest.repositoryUrl) && <div class="ad-cell-sub">{t('Third-party')}</div>}</> },
        { key: 'Version', label: t('Latest'), value: (row: CatalogRow) => row.latest?.version || '—' },
        { key: 'Actions', label: '', value: (row: CatalogRow) => <button class="ad-btn" disabled={busy === row.id} onClick={() => setSheetId(row.id)}>{t('View versions')}</button> },
    ];

    return <PageShell title={t('Plugins')} subtitle={t('Install, update, configure and remove server plugins')} actions={<button class="ad-btn" onClick={() => void load()}>{t('Refresh')}</button>}>
        {restartPending && <div class="ad-restart-banner" role="status">
            <span>{restartState || t('Restart the server to finish plugin changes.')}</span>
            {!restartState && <ConfirmButton label={t('Restart now')} confirmLabel={t('Restart server')} onConfirm={restart} />}
        </div>}
        {loadError && <p role="alert" class="ad-error">{loadError}</p>}
        {message && <p role="status" class="ad-note">{message}</p>}
        <Tabs tabs={TABS} value={tab} onPick={setTab} />
        {tab === 'Installed' && <Card title={t('Installed plugins')}>
            <div class="ad-toolbar">
                <SearchInput value={search} onInput={setSearch} placeholder={t('Search plugins…')} />
                <FilterPills options={[ 'All', 'Enabled', 'Disabled', 'Updates' ]} value={filter} onPick={setFilter} />
                <span class="ad-note">{t('{0} plugin{1}{2}', plugins.length, plugins.length !== 1 ? 's' : '', updates ? ` · ${updates} update${updates !== 1 ? 's' : ''}` : '')}</span>
            </div>
            <DataTable rows={installedRows} columns={installedColumns} getKey={row => row.id} query={search} empty={t('No plugins found')} />
            <p class="ad-note">{t('Install, update, uninstall and enable/disable changes take effect after a server restart.')}</p>
        </Card>}
        {tab === 'Catalog' && <Card title={t('Available plugins')}>
            {packagesError
                ? <p role="alert" class="ad-error">{packagesError} <button class="ad-btn" onClick={() => void loadPackages()}>{t('Retry')}</button></p>
                : packages === null
                    ? <Empty muted>{t('Loading the plugin catalog…')}</Empty>
                    : <>
                        <div class="ad-toolbar">
                            <SearchInput value={search} onInput={setSearch} placeholder={t('Search the catalog…')} />
                            {categories.length > 2 && <FilterPills options={categories} value={categories.includes(category) ? category : 'All'} onPick={setCategory} />}
                            <span class="ad-note">{t('{0} available', catalogRows.length)}</span>
                        </div>
                        <DataTable rows={visibleCatalog} columns={catalogColumns} getKey={row => row.id} query={search} empty={t('No plugins available from the enabled repositories')} />
                    </>}
        </Card>}
        {tab === 'Repositories' && <RepositoriesPanel api={api} onChanged={() => void loadPackages()} />}
        {sheetRow && <PluginSheet row={sheetRow} busy={busy === sheetRow.id} configurable={Boolean(sheetRow.installed?.Id) && configurablePluginIds.includes(sheetRow.installed!.Id!)}
            onInstall={version => install(sheetRow, version)} onUninstall={() => uninstall(sheetRow)} onConfigure={() => onNavigate(pluginSection(sheetRow.installed!.Id!))} onClose={() => setSheetId('')} />}
    </PageShell>;
}

function PluginSheet({ row, busy, configurable, onInstall, onUninstall, onConfigure, onClose }: {
    row: CatalogRow; busy: boolean; configurable: boolean;
    onInstall: (version: PackageVersion) => Promise<void>; onUninstall: () => Promise<void>; onConfigure: () => void; onClose: () => void;
}) {
    const sheet = useRef<HTMLElement>(null);
    useDialogFocus(sheet, true, onClose, { initial: '.ad-plugin-sheet-close' });
    const [pending, setPending] = useState<PackageVersion | null>(null);
    const [error, setError] = useState('');
    const [showAll, setShowAll] = useState(false);
    const versions = showAll ? row.versions : row.versions.slice(0, 8);
    const titleId = `plugin-sheet-${row.id}`;

    const run = async (version: PackageVersion) => {
        setError('');
        try {
            await onInstall(version);
            setPending(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : t('The plugin could not be installed.'));
        }
    };
    const choose = (version: PackageVersion) => {
        const action = versionAction(row, version);
        if (action === 'downgrade' || !isTrustedRepository(version.repositoryUrl)) setPending(version);
        else void run(version);
    };

    return <div class="ad-plugin-sheet-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
        <aside ref={sheet} class="ad-plugin-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId}>
            <div class="ad-plugin-sheet-head">
                {row.imageUrl && <img class="ad-plugin-sheet-image" src={row.imageUrl} alt="" loading="lazy" referrerpolicy="no-referrer" />}
                <div>
                    <h2 id={titleId}>{row.name}</h2>
                    <p class="ad-cell-sub">{[ row.owner && `by ${row.owner}`, row.category, row.installed ? `Installed ${row.installed.Version}` : 'Not installed' ].filter(Boolean).join(' · ')}</p>
                </div>
                <button class="ad-btn ad-plugin-sheet-close" onClick={onClose}>{t('Close')}</button>
            </div>
            {row.description && <p class="ad-plugin-sheet-description">{row.description}</p>}
            <div class="ad-flex" style="gap:6px;flex-wrap:wrap">
                {configurable && <button class="ad-btn" disabled={busy} onClick={onConfigure}>{t('Configure')}</button>}
                {row.installed && !row.protected && !row.bundled && <ConfirmButton label={t('Uninstall')} tone="danger" confirmLabel={t('Uninstall plugin')} busy={busy} onConfirm={onUninstall} />}
                {row.protected && <span class="ad-note">{t('This plugin provides the PostgreSQL database and cannot be removed or disabled here.')}</span>}
                {row.bundled && !row.protected && <span class="ad-note">{t('Bundled with the server; it cannot be uninstalled.')}</span>}
            </div>
            {pending && <div class="ad-plugin-confirm" role="group" aria-label={t('Confirm installation')}>
                {!isTrustedRepository(pending.repositoryUrl) && <p><strong>{t('Third-party repository.')}</strong> {pending.repositoryName} (<code>{pending.repositoryUrl}</code>{t(') is not maintained by Jellyfin. Plugins run with full server access; only install plugins you trust.')}</p>}
                {versionAction(row, pending) === 'downgrade' && <p><strong>{t('Downgrade.')}</strong>{' '}{t('Version {0} is older than the installed {1}; settings saved by the newer version may not load.', pending.version, row.installed?.Version)}</p>}
                <div class="ad-flex" style="gap:6px">
                    <button class="ad-btn danger fill" disabled={busy} onClick={() => void run(pending)}>{busy ? t('Working…') : `${ACTION_LABEL[versionAction(row, pending)]} ${pending.version}`}</button>
                    <button class="ad-btn" disabled={busy} onClick={() => setPending(null)}>{t('Cancel')}</button>
                </div>
            </div>}
            {error && <p role="alert" class="ad-error">{error}</p>}
            <h3 class="ad-plugin-sheet-subtitle">{t('Versions')}</h3>
            {row.versions.length === 0
                ? <Empty muted>{t('No versions of this plugin are available from the enabled repositories.')}</Empty>
                : <ol class="ad-plugin-versions">{versions.map(version => {
                    const action = versionAction(row, version);
                    return <li key={`${version.version}|${version.repositoryUrl}`}>
                        <div class="ad-plugin-version-head">
                            <strong>{version.version}</strong>
                            <span class="ad-cell-sub">{[ version.targetAbi && `Jellyfin ${version.targetAbi}+`, version.timestamp && fmtDate(version.timestamp), version.repositoryName ].filter(Boolean).join(' · ')}</span>
                            {!isTrustedRepository(version.repositoryUrl) && <StatusChip tone="amber">{t('Third-party')}</StatusChip>}
                            {action === 'reinstall' ? <StatusChip tone="green">{t('Installed')}</StatusChip>
                                : <button class="ad-btn" disabled={busy || Boolean(pending)} onClick={() => choose(version)}>{busy ? t('Working…') : ACTION_LABEL[action]}</button>}
                        </div>
                        {version.changelog && <pre class="ad-plugin-changelog">{version.changelog}</pre>}
                    </li>;
                })}</ol>}
            {!showAll && row.versions.length > versions.length && <button class="ad-btn" onClick={() => setShowAll(true)}>{t('Show all {0} versions', row.versions.length)}</button>}
        </aside>
    </div>;
}

function RepositoriesPanel({ api, onChanged }: { api: AdminApi; onChanged: () => void }) {
    const [repositories, setRepositories] = useState<RepositoryInfo[] | null>(null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [name, setName] = useState('');
    const [url, setUrl] = useState('');
    const [formError, setFormError] = useState('');
    const [httpWarning, setHttpWarning] = useState('');
    const alive = useRef(true);
    useEffect(() => () => { alive.current = false; }, []);

    const load = useCallback(async () => {
        setError('');
        try {
            const next = await api.getRepositories();
            if (alive.current) setRepositories(next);
        } catch (e) {
            if (alive.current) setError(e instanceof Error ? e.message : t('Repositories could not be loaded.'));
        }
    }, [api]);
    useEffect(() => { void load(); }, [load]);

    /** Re-reads the list before saving because the server replaces it wholesale. */
    const mutate = async (change: (current: RepositoryInfo[]) => RepositoryInfo[] | string) => {
        setBusy(true); setError('');
        try {
            const fresh = await api.getRepositories();
            const next = change(fresh);
            if (typeof next === 'string') { if (alive.current) { setRepositories(fresh); setFormError(next); } return false; }
            await api.setRepositories(next);
            if (!alive.current) return true;
            setRepositories(next);
            onChanged();
            return true;
        } catch (e) {
            if (alive.current) setError(e instanceof Error ? e.message : t('Repositories could not be saved.'));
            return false;
        } finally {
            if (alive.current) setBusy(false);
        }
    };

    const add = async (event: Event) => {
        event.preventDefault();
        setFormError('');
        const check = validateRepository(name, url, repositories || []);
        if (check.error) { setFormError(check.error); return; }
        if (check.warning && httpWarning !== url.trim()) { setHttpWarning(url.trim()); return; }
        const saved = await mutate(current => {
            const fresh = validateRepository(name, url, current);
            return fresh.error || [ ...current, fresh.repository! ];
        });
        if (saved && alive.current) { setName(''); setUrl(''); setHttpWarning(''); }
    };

    const columns = [
        { key: 'Name', label: t('Repository'), value: (repository: RepositoryInfo) => <><strong>{repository.Name}</strong><div class="ad-cell-sub ad-break">{repository.Url}</div></>, searchValue: (repository: RepositoryInfo) => `${repository.Name} ${repository.Url}` },
        { key: 'Source', label: t('Source'), value: (repository: RepositoryInfo) => isTrustedRepository(repository.Url) ? <StatusChip tone="green">{t('Jellyfin')}</StatusChip> : <StatusChip tone="amber">{t('Third-party')}</StatusChip> },
        { key: 'Enabled', label: t('Enabled'), value: (repository: RepositoryInfo) => <label class="ad-flex" style="gap:6px"><input type="checkbox" checked={repository.Enabled} disabled={busy}
            onChange={e => { const enabled = e.currentTarget.checked; void mutate(current => current.map(entry => entry.Url === repository.Url ? { ...entry, Enabled: enabled } : entry)); }} aria-label={t('Enable {0}', repository.Name)} />{repository.Enabled ? t('On') : t('Off')}</label> },
        { key: 'Actions', label: '', value: (repository: RepositoryInfo) => <ConfirmButton label={t('Remove')} tone="danger" busy={busy} onConfirm={() => mutate(current => current.filter(entry => entry.Url !== repository.Url))} /> },
    ];

    return <Card title={t('Plugin repositories')}>
        {error && <p role="alert" class="ad-error">{error} <button class="ad-btn" onClick={() => void load()}>{t('Retry')}</button></p>}
        {repositories === null && !error
            ? <Empty muted>{t('Loading repositories…')}</Empty>
            : repositories && <DataTable rows={repositories} columns={columns} getKey={repository => repository.Url} query="" empty={t('No repositories. Add one to browse plugins.')} />}
        <form class="ad-repo-form" onSubmit={e => void add(e)}>
            <label class="ad-field">{t('Name')}<input value={name} disabled={busy} maxLength={200} onInput={e => { setName(e.currentTarget.value); setFormError(''); }} /></label>
            <label class="ad-field">{t('Repository URL')}<input value={url} disabled={busy} placeholder={t('https://example.com/manifest.json')} onInput={e => { setUrl(e.currentTarget.value); setFormError(''); setHttpWarning(''); }} /></label>
            <button class="ad-btn" type="submit" disabled={busy}>{httpWarning ? t('Add anyway') : t('Add repository')}</button>
        </form>
        {formError && <p role="alert" class="ad-error">{formError}</p>}
        {httpWarning && !formError && <p role="alert" class="ad-error">{t('This address is not encrypted; plugins downloaded from it could be altered in transit. Select Add anyway to continue.')}</p>}
        <p class="ad-note">{t('Repository changes update the Catalog tab. Only add repositories you trust: their plugins run with full access to the server.')}</p>
    </Card>;
}
