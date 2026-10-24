import { JellyfinRequestError, RequestTimeoutError } from '../api';
import type { PackageInfo, PackageVersion, PluginInfo, RepositoryInfo } from './types';
import { t } from '../i18n';

const MAX_PACKAGES = 1000;
const MAX_VERSIONS = 100;
const MAX_REPOSITORIES = 100;
const MAX_NAME = 200;
const MAX_TEXT = 4000;
const MAX_URL = 2000;

/** The PostgreSQL provider: the database cannot run without it, so UI Next never offers to remove or disable it. */
export const PROTECTED_PLUGIN_IDS = [ '27e7ad18ea714b19b1a96e4c2e4d5e18' ];

const TRUSTED_REPOSITORY_HOST = 'repo.jellyfin.org';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
    return trimmed ? trimmed.slice(0, max) : undefined;
}

function httpsUrl(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.length > MAX_URL) return undefined;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined;
    } catch {
        return undefined;
    }
}

export function normalizeGuid(value: unknown): string {
    if (typeof value !== 'string') return '';
    const compact = value.replace(/[{}-]/g, '').toLowerCase();
    return /^[0-9a-f]{32}$/.test(compact) ? compact : '';
}

export function isProtectedPlugin(id: unknown): boolean {
    return PROTECTED_PLUGIN_IDS.includes(normalizeGuid(id));
}

/** Compares dotted numeric versions (up to four parts); missing or non-numeric parts count as 0. */
export function compareVersions(a: string | undefined, b: string | undefined): number {
    const parts = (value: string | undefined) => {
        const numbers = (value || '').split('.').slice(0, 4).map(part => Number.parseInt(part, 10));
        while (numbers.length < 4) numbers.push(0);
        return numbers.map(part => (Number.isFinite(part) && part >= 0 ? part : 0));
    };
    const left = parts(a);
    const right = parts(b);
    for (let index = 0; index < 4; index++) {
        if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
    }
    return 0;
}

function asVersion(raw: unknown): PackageVersion | null {
    if (!isRecord(raw)) return null;
    const version = text(raw.version, 40);
    const repositoryUrl = text(raw.repositoryUrl, MAX_URL);
    if (!version || !/^\d+(\.\d+){0,3}$/.test(version) || !repositoryUrl) return null;
    const result: PackageVersion = { version, repositoryUrl, repositoryName: text(raw.repositoryName, MAX_NAME) || repositoryUrl };
    const changelog = text(raw.changelog, MAX_TEXT);
    if (changelog) result.changelog = changelog;
    const targetAbi = text(raw.targetAbi, 40);
    if (targetAbi) result.targetAbi = targetAbi;
    const timestamp = text(raw.timestamp, 40);
    if (timestamp && !Number.isNaN(Date.parse(timestamp))) result.timestamp = timestamp;
    return result;
}

/** Validates `/Packages`: unusable entries are dropped and everything is bounded. */
export function asPackages(raw: unknown): PackageInfo[] {
    if (!Array.isArray(raw)) throw new Error(t('The plugin catalog returned an unexpected response.'));
    const packages: PackageInfo[] = [];
    const seen = new Set<string>();
    for (const entry of raw.slice(0, MAX_PACKAGES * 2)) {
        if (packages.length >= MAX_PACKAGES) break;
        if (!isRecord(entry)) continue;
        const guid = normalizeGuid(entry.guid);
        const name = text(entry.name, MAX_NAME);
        if (!guid || !name || seen.has(guid)) continue;
        seen.add(guid);
        const versions = (Array.isArray(entry.versions) ? entry.versions.slice(0, MAX_VERSIONS * 2) : [])
            .map(asVersion)
            .filter((version): version is PackageVersion => version !== null)
            .sort((a, b) => compareVersions(b.version, a.version))
            .slice(0, MAX_VERSIONS);
        const info: PackageInfo = { guid, name, versions };
        const description = text(entry.description, MAX_TEXT);
        if (description) info.description = description;
        const overview = text(entry.overview, MAX_TEXT);
        if (overview) info.overview = overview;
        const owner = text(entry.owner, MAX_NAME);
        if (owner) info.owner = owner;
        const category = text(entry.category, 80);
        if (category) info.category = category;
        const imageUrl = httpsUrl(entry.imageUrl);
        if (imageUrl) info.imageUrl = imageUrl;
        packages.push(info);
    }
    return packages;
}

/** Validates `/Repositories` (PascalCase). */
export function asRepositories(raw: unknown): RepositoryInfo[] {
    if (!Array.isArray(raw)) throw new Error(t('The repository list returned an unexpected response.'));
    return raw.slice(0, MAX_REPOSITORIES).flatMap(entry => {
        if (!isRecord(entry)) return [];
        const url = text(entry.Url, MAX_URL);
        if (!url) return [];
        return [ { Name: text(entry.Name, MAX_NAME) || url, Url: url, Enabled: entry.Enabled !== false } ];
    });
}

export function isTrustedRepository(url: string | undefined): boolean {
    try {
        const parsed = new URL(url || '');
        return parsed.protocol === 'https:' && parsed.hostname === TRUSTED_REPOSITORY_HOST && !parsed.username && !parsed.password;
    } catch {
        return false;
    }
}

export interface RepositoryValidation {
    error?: string;
    warning?: string;
    repository?: RepositoryInfo;
}

export function validateRepository(name: string, url: string, existing: RepositoryInfo[]): RepositoryValidation {
    const trimmedName = name.trim();
    const trimmedUrl = url.trim();
    if (!trimmedName) return { error: t('Enter a name for the repository.') };
    if (trimmedName.length > MAX_NAME) return { error: t('The repository name is too long.') };
    let parsed: URL;
    try {
        parsed = new URL(trimmedUrl);
    } catch {
        return { error: t('Enter the full repository address, starting with https://.') };
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { error: t('Repository addresses must start with https:// or http://.') };
    if (parsed.username || parsed.password) return { error: t('Do not put a username or password in the repository address.') };
    if (trimmedUrl.length > MAX_URL) return { error: t('The repository address is too long.') };
    if (existing.some(repository => repository.Url.trim().toLowerCase() === parsed.href.toLowerCase() || repository.Url.trim().toLowerCase() === trimmedUrl.toLowerCase())) {
        return { error: t('This repository is already in the list.') };
    }
    return {
        repository: { Name: trimmedName, Url: trimmedUrl, Enabled: true },
        warning: parsed.protocol === 'http:' ? t('This address is not encrypted; plugins downloaded from it could be altered in transit.') : undefined
    };
}

export interface CatalogRow {
    id: string;
    name: string;
    /** Catalog name; the install endpoint looks packages up by this. */
    packageName?: string;
    description?: string;
    category?: string;
    owner?: string;
    imageUrl?: string;
    installed?: PluginInfo;
    /** Newest first. */
    versions: PackageVersion[];
    latest?: PackageVersion;
    updateAvailable: boolean;
    /** Installed but cannot be uninstalled (shipped with the server). */
    bundled: boolean;
    protected: boolean;
}

const STATUS_RANK: Record<string, number> = { Active: 3, Restart: 2, Disabled: 1 };

function bestInstalled(plugins: PluginInfo[]): PluginInfo | undefined {
    return [ ...plugins ].sort((a, b) => ((STATUS_RANK[b.Status || ''] || 0) - (STATUS_RANK[a.Status || ''] || 0)) || compareVersions(b.Version, a.Version))[0];
}

/** One row per plugin GUID, joining installed plugins with catalog packages; sorted by name. */
export function mergeCatalog(plugins: PluginInfo[], packages: PackageInfo[]): CatalogRow[] {
    const installedById = new Map<string, PluginInfo[]>();
    plugins.forEach(plugin => {
        const id = normalizeGuid(plugin.Id);
        if (!id) return;
        installedById.set(id, [ ...(installedById.get(id) || []), plugin ]);
    });
    const packageById = new Map(packages.map(pkg => [ pkg.guid, pkg ]));
    const ids = new Set([ ...packageById.keys(), ...installedById.keys() ]);
    return Array.from(ids).map(id => {
        const pkg = packageById.get(id);
        const installed = bestInstalled(installedById.get(id) || []);
        const versions = pkg?.versions || [];
        const latest = versions[0];
        return {
            id,
            name: installed?.Name || pkg?.name || id,
            packageName: pkg?.name,
            description: installed?.Description || pkg?.description || pkg?.overview,
            category: pkg?.category,
            owner: pkg?.owner,
            imageUrl: pkg?.imageUrl,
            installed,
            versions,
            latest,
            updateAvailable: Boolean(installed && latest && compareVersions(latest.version, installed.Version) > 0),
            bundled: Boolean(installed && installed.CanUninstall === false),
            protected: isProtectedPlugin(id)
        };
    }).sort((a, b) => a.name.localeCompare(b.name));
}

export type VersionAction = 'install' | 'update' | 'reinstall' | 'downgrade';

export function versionAction(row: CatalogRow, version: PackageVersion): VersionAction {
    if (!row.installed) return 'install';
    const order = compareVersions(version.version, row.installed.Version);
    return order > 0 ? 'update' : order < 0 ? 'downgrade' : 'reinstall';
}

export function needsRestart(plugins: PluginInfo[]): boolean {
    return plugins.some(plugin => plugin.Status === 'Restart');
}

export function installErrorMessage(error: unknown): string {
    if (error instanceof RequestTimeoutError) return t('Still installing on the server…');
    if (error instanceof JellyfinRequestError) {
        if (error.status === 404) return t('This version is not available for this server.');
        if (error.status === 403) return t('Only administrators can install plugins.');
    }
    return t('The plugin could not be installed. Check the server log for details.');
}
