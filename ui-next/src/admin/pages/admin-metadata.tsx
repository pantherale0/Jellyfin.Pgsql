import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { JellyfinApi } from '../../api';
import { asItemResponse } from '../../api-contracts';
import { ManageItemActions } from '../../metadata-editors';
import type { MediaItem } from '../../types';
import type { AdminApi } from '../admin-api';
import type { LibraryInfo } from '../types';
import { PageShell, Card, Tabs, DataTable, SearchInput, ConfigSection, Empty, StatusChip } from '../ui';
import { DATE_ADDED_FIELDS, DISPLAY_FIELDS, METADATA_DEFAULT_FIELDS, NFO_FIELDS } from '../server-settings';
import { t } from '../../i18n';

const PAGE_SIZE = 20;
const ITEM_TYPES: Array<[string, string]> = [
    [ '', 'All types' ], [ 'Movie', 'Movies' ], [ 'Series', 'Shows' ], [ 'Season', 'Seasons' ], [ 'Episode', 'Episodes' ], [ 'BoxSet', 'Collections' ],
    [ 'MusicArtist', 'Artists' ], [ 'MusicAlbum', 'Albums' ], [ 'Audio', 'Tracks' ], [ 'MusicVideo', 'Music videos' ], [ 'Video', 'Videos' ],
];
const EXPECTS_IDS = new Set([ 'Movie', 'Series', 'Episode', 'BoxSet', 'MusicAlbum', 'MusicArtist' ]);

export function metadataSearchParams({ userId, parentId, query, type, startIndex }: { userId: string; parentId: string; query: string; type: string; startIndex: number }): URLSearchParams {
    const params = new URLSearchParams({
        userId, ParentId: parentId, Recursive: String(Boolean(query.trim() || type)), SortBy: 'SortName', SortOrder: 'Ascending',
        StartIndex: String(startIndex), Limit: String(PAGE_SIZE), EnableTotalRecordCount: 'true', EnableImages: 'false', Fields: 'ProviderIds,Path',
    });
    if (query.trim()) params.set('SearchTerm', query.trim().slice(0, 200));
    if (type) params.set('IncludeItemTypes', type);
    return params;
}

export function AdminMetadata({ adminApi, api }: { adminApi: AdminApi; api: JellyfinApi }) {
    const [tab, setTab] = useState('Manager');
    const [cultures, setCultures] = useState<Array<[string, string]>>([]);
    const [countries, setCountries] = useState<Array<[string, string]>>([]);
    const [users, setUsers] = useState<Array<[string, string]>>([]);
    useEffect(() => {
        let active = true;
        adminApi.getCultures().then(list => { if (active) setCultures([ [ '', 'Not set' ], ...list.map(culture => [ culture.TwoLetterISOLanguageName || culture.ThreeLetterISOLanguageName, culture.DisplayName ] as [string, string]) ]); }).catch(() => undefined);
        adminApi.getCountries().then(list => { if (active) setCountries([ [ '', 'Not set' ], ...list.map(country => [ country.TwoLetterISORegionName, country.DisplayName ] as [string, string]) ]); }).catch(() => undefined);
        adminApi.getUsers().then(list => { if (active) setUsers([ [ '', 'None' ], ...list.map(user => [ user.Id, user.Name ] as [string, string]) ]); }).catch(() => undefined);
        return () => { active = false; };
    }, [adminApi]);
    return <PageShell title={t('Metadata')} subtitle={t('Edit item metadata and images, and set library display and metadata defaults')}>
        <Tabs tabs={[ 'Manager', 'Display', 'Metadata', 'NFO' ]} value={tab} onPick={setTab} />
        {tab === 'Manager' && <MetadataManager adminApi={adminApi} api={api} />}
        {tab === 'Display' && <>
            <ConfigSection api={adminApi} path="/System/Configuration" title={t('Library display')} fields={DISPLAY_FIELDS} />
            <ConfigSection api={adminApi} path="/System/Configuration/metadata" title={t('Date added')} fields={DATE_ADDED_FIELDS} />
        </>}
        {tab === 'Metadata' && <ConfigSection api={adminApi} path="/System/Configuration" title={t('Metadata defaults')} fields={METADATA_DEFAULT_FIELDS}
            options={{ PreferredMetadataLanguage: cultures, MetadataCountryCode: countries }}
            note={t('Libraries and items can override the language and country. Changes apply to the next refresh.')} />}
        {tab === 'NFO' && <ConfigSection api={adminApi} path="/System/Configuration/xbmcmetadata" title={t('NFO settings')} fields={NFO_FIELDS} options={{ UserId: users }}
            note={t('Applies to libraries that save metadata as NFO files.')} />}
    </PageShell>;
}

function MetadataManager({ adminApi, api }: { adminApi: AdminApi; api: JellyfinApi }) {
    const [libraries, setLibraries] = useState<LibraryInfo[] | null>(null);
    const [libraryId, setLibraryId] = useState('');
    const [crumbs, setCrumbs] = useState<Array<{ Id: string; Name: string }>>([]);
    const [type, setType] = useState('');
    const [query, setQuery] = useState('');
    const [debounced, setDebounced] = useState('');
    const [startIndex, setStartIndex] = useState(0);
    const [items, setItems] = useState<MediaItem[] | null>(null);
    const [total, setTotal] = useState(0);
    const [error, setError] = useState('');
    const [revision, setRevision] = useState(0);
    const request = useRef(0);

    useEffect(() => {
        let active = true;
        adminApi.getLibraries().then(list => {
            if (!active) return;
            const usable = list.filter(library => library.ItemId);
            setLibraries(usable);
            setLibraryId(current => current || usable[0]?.ItemId || '');
        }).catch(cause => { if (active) { setLibraries([]); setError(cause instanceof Error ? cause.message : t('Libraries could not be loaded.')); } });
        return () => { active = false; };
    }, [adminApi]);
    useEffect(() => {
        const timer = window.setTimeout(() => setDebounced(query), 300);
        return () => window.clearTimeout(timer);
    }, [query]);
    useEffect(() => setStartIndex(0), [libraryId, crumbs, type, debounced]);

    const parentId = crumbs.length ? crumbs[crumbs.length - 1].Id : libraryId;
    useEffect(() => {
        if (!parentId) return;
        const id = ++request.current;
        setError('');
        api.request<unknown>(`/Items?${metadataSearchParams({ userId: api.session.user.Id, parentId, query: debounced, type, startIndex })}`).then(raw => {
            if (id !== request.current) return;
            const page = asItemResponse(raw);
            setItems(page.Items); setTotal(page.TotalRecordCount ?? page.Items.length);
        }).catch(cause => {
            if (id !== request.current) return;
            setItems([]); setTotal(0); setError(cause instanceof Error ? cause.message : t('Items could not be loaded.'));
        });
    }, [api, parentId, debounced, type, startIndex, revision]);
    useEffect(() => () => { request.current += 1; }, []);

    const reload = useCallback(() => setRevision(value => value + 1), []);
    const library = libraries?.find(entry => entry.ItemId === libraryId);
    if (libraries === null) return <Card><p role="status" class="ad-note">{t('Loading libraries…')}</p></Card>;
    if (!libraries.length) return <Card><Empty muted>{error || t('No libraries are set up yet.')}</Empty></Card>;
    const columns = [
        { key: 'Name', label: t('Name'), value: (item: MediaItem) => <div>
            {item.IsFolder && !debounced && !type
                ? <button type="button" class="ad-link" onClick={() => setCrumbs([ ...crumbs, { Id: item.Id, Name: item.Name } ])}>{item.Name}</button>
                : <span>{item.Name}</span>}
            {item.Path && <div class="ad-cell-sub">{item.Path}</div>}
        </div>, searchValue: (item: MediaItem) => item.Name },
        { key: 'Type', label: t('Type'), value: (item: MediaItem) => item.Type || '—' },
        { key: 'Year', label: t('Year'), value: (item: MediaItem) => item.ProductionYear ? String(item.ProductionYear) : '—' },
        { key: 'Status', label: t('Status'), value: (item: MediaItem) => <span class="ad-flex">
            {item.LockData && <StatusChip tone="blue">{t('Locked')}</StatusChip>}
            {EXPECTS_IDS.has(item.Type || '') && !Object.values(item.ProviderIds || {}).some(Boolean) && <StatusChip tone="amber">{t('No external IDs')}</StatusChip>}
        </span>, searchValue: (item: MediaItem) => `${item.LockData ? 'locked' : ''}` },
        { key: 'Actions', label: '', value: (item: MediaItem) => <ManageItemActions api={api} item={item} user={api.session.user} onChanged={reload} buttonClass="ad-btn" layout="desktop" compact /> },
    ];
    return <Card title={t('Metadata manager')}>
        <div class="ad-toolbar ad-flex">
            <label class="ad-inline-label">{t('Library')}{' '}<select class="ad-form-input" value={libraryId} onChange={event => { setLibraryId(event.currentTarget.value); setCrumbs([]); }}>
                {libraries.map(entry => <option key={entry.ItemId} value={entry.ItemId}>{entry.Name}</option>)}</select></label>
            <label class="ad-inline-label">{t('Type')}{' '}<select class="ad-form-input" value={type} onChange={event => setType(event.currentTarget.value)}>
                {ITEM_TYPES.map(([ value, label ]) => <option key={value} value={value}>{t(label)}</option>)}</select></label>
            <SearchInput value={query} onInput={setQuery} placeholder={t('Search this library…')} />
        </div>
        <nav class="ad-breadcrumbs" aria-label={t('Folder path')}>
            <button type="button" class="ad-link" disabled={!crumbs.length} onClick={() => setCrumbs([])}>{library?.Name || t('Library')}</button>
            {crumbs.map((crumb, index) => <span key={crumb.Id}> / <button type="button" class="ad-link" disabled={index === crumbs.length - 1} aria-current={index === crumbs.length - 1 ? 'page' : undefined} onClick={() => setCrumbs(crumbs.slice(0, index + 1))}>{crumb.Name}</button></span>)}
        </nav>
        {error && <p role="alert" class="ad-error">{error}</p>}
        {items === null ? <p role="status" class="ad-note">{t('Loading items…')}</p> : <DataTable rows={items} columns={columns} getKey={item => item.Id} query="" empty={debounced || type ? t('No items match.') : t('This folder is empty.')} />}
        {total > PAGE_SIZE && <div class="ad-pagination">
            <button class="ad-btn" disabled={!startIndex} onClick={() => setStartIndex(Math.max(0, startIndex - PAGE_SIZE))}>{t('Previous')}</button>
            <span>{t('{0}–{1} of {2}', startIndex + 1, Math.min(startIndex + PAGE_SIZE, total), total)}</span>
            <button class="ad-btn" disabled={startIndex + PAGE_SIZE >= total} onClick={() => setStartIndex(startIndex + PAGE_SIZE)}>{t('Next')}</button>
        </div>}
    </Card>;
}
