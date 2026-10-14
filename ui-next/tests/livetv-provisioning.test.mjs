import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { extname } from 'node:path';
import { beforeEach, test } from 'node:test';

registerHooks({
    resolve(specifier, context, nextResolve) {
        return nextResolve(specifier.startsWith('.') && !extname(specifier) ? `${specifier}.ts` : specifier, context);
    }
});

const requests = [];
const responses = [];
beforeEach(() => { requests.length = 0; responses.length = 0; });
globalThis.window = { location: { href: 'https://jellyfin.example.test/web/' }, setTimeout };
globalThis.localStorage = { getItem: () => null, setItem: () => undefined };
if (typeof globalThis.document === 'undefined') globalThis.document = { createElement: () => ({ canPlayType: () => '' }) };
globalThis.XMLHttpRequest = class {
    open(method, url) { this.method = method; this.url = url; this.responseURL = url; }
    setRequestHeader() {}
    send(body) {
        requests.push({ method: this.method, url: this.url, body });
        const response = responses.shift() || { status: 200, body: '{}' };
        queueMicrotask(() => {
            this.status = response.status;
            this.responseText = response.body;
            this.onload();
        });
    }
};

const { JellyfinApi } = await import('../src/api.ts');
const { createAdminApi } = await import('../src/admin/admin-api.ts');
const live = await import('../src/admin/livetv-provisioning.ts');
const session = {
    server: 'https://jellyfin.example.test', token: 'token',
    user: { Id: 'user-id', Name: 'Admin' }, serverId: 'server-id'
};
const adminApi = () => createAdminApi(new JellyfinApi(session));

test('MISS-31 tuner payload keeps stored server fields and converts the bitrate', () => {
    const stored = { Id: 't1', Type: 'm3u', Source: 'nextpvr', Url: '/old.m3u', FutureOption: 7, TunerCount: 2, FallbackMaxStreamingBitrate: 20_000_000 };
    const draft = { ...live.tunerDraftFrom(stored), Url: ' /new.m3u ', TunerCount: 4, FallbackMaxStreamingBitrateMbps: 12.5 };
    const payload = live.buildTunerPayload(stored, draft);
    assert.equal(payload.Id, 't1');
    assert.equal(payload.Source, 'nextpvr', 'M3U variants keep their source');
    assert.equal(payload.FutureOption, 7, 'fields the form does not render survive');
    assert.equal(payload.Url, '/new.m3u');
    assert.equal(payload.TunerCount, 4);
    assert.equal(payload.FallbackMaxStreamingBitrate, 12_500_000);
    assert.equal(live.tunerDraftFrom(stored).FallbackMaxStreamingBitrateMbps, 20);
});

test('MISS-31 tuner payload clears options that belong to the other tuner type', () => {
    const stored = { Type: 'm3u', EnableStreamLooping: true, TunerCount: 3, UserAgent: 'VLC', AllowStreamSharing: true };
    const draft = { ...live.tunerDraftFrom(stored), Type: 'hdhomerun', Url: '192.168.1.50', AllowHWTranscoding: true };
    const payload = live.buildTunerPayload(stored, draft);
    assert.equal(payload.EnableStreamLooping, false);
    assert.equal(payload.AllowStreamSharing, false);
    assert.equal(payload.TunerCount, 0);
    assert.equal('UserAgent' in payload, false);
    assert.equal(payload.AllowHWTranscoding, true, 'HDHomeRun options are kept');

    const m3u = live.buildTunerPayload({ Type: 'hdhomerun', ImportFavoritesOnly: true }, { ...live.tunerDraftFrom(null, 'm3u'), Url: '/a.m3u', ImportFavoritesOnly: true });
    assert.equal(m3u.ImportFavoritesOnly, false);
});

test('MISS-31 tuner validation requires an address and sane numbers', () => {
    const base = live.tunerDraftFrom(null, 'm3u');
    assert.match(live.validateTunerDraft(base), /M3U/);
    assert.equal(live.validateTunerDraft({ ...base, Url: '/a.m3u' }), null);
    assert.match(live.validateTunerDraft({ ...base, Url: '/a.m3u', TunerCount: -1 }), /0 or more/);
    assert.match(live.validateTunerDraft({ ...base, Url: '/a.m3u', FallbackMaxStreamingBitrateMbps: 0 }), /bitrate/);
    assert.match(live.validateTunerDraft({ ...base, Type: 'satip', Url: 'x' }), /supported/);
    assert.equal(live.tunerFieldVisibility('hdhomerun').tunerCount, false);
    assert.equal(live.tunerFieldVisibility('m3u').streamLooping, true);
});

test('MISS-31 XMLTV payload parses categories and keeps saved channel mappings from the latest copy', () => {
    const stale = { Id: 'p1', Type: 'xmltv', Path: '/old.xml', ChannelMappings: [{ Name: '1', Value: 'old' }] };
    const latest = { ...stale, ChannelMappings: [{ Name: '1', Value: 'bbc1' }, { Name: '2', Value: 'bbc2' }], Unknown: 'keep' };
    const draft = { ...live.providerDraftFrom(stale), Path: ' /new.xml ', MovieCategories: 'Film| Movie |', EnableAllTuners: false, EnabledTuners: ['t1'] };
    const payload = live.buildProviderPayload(latest, draft);
    assert.equal(payload.Path, '/new.xml');
    assert.deepEqual(payload.MovieCategories, ['Film', 'Movie']);
    assert.deepEqual(payload.ChannelMappings, latest.ChannelMappings, 'mappings saved by the mapping endpoint are not overwritten');
    assert.equal(payload.Unknown, 'keep');
    assert.equal(payload.EnableAllTuners, false);
    assert.deepEqual(payload.EnabledTuners, ['t1']);
    assert.deepEqual(live.buildProviderPayload(latest, { ...draft, EnableAllTuners: true }).EnabledTuners, [], 'all tuners clears the explicit list');
});

test('MISS-31 Schedules Direct keeps the stored password unless a new one is typed', () => {
    const stored = { Id: 'sd', Type: 'SchedulesDirect', Username: 'me', Password: 'stored-secret', ListingsId: 'GBR-1' };
    const draft = live.providerDraftFrom(stored);
    assert.equal(draft.Password, '', 'the stored password is never loaded into the form');
    assert.equal(live.buildProviderPayload(stored, draft).Password, 'stored-secret');
    assert.equal(live.buildProviderPayload(stored, { ...draft, Password: 'new-secret' }).Password, 'new-secret');
});

test('MISS-31 provider validation follows the sign-in and lineup stages', () => {
    const sd = live.providerDraftFrom(null, 'SchedulesDirect');
    assert.match(live.validateProviderDraft(sd, 'login', false), /username/);
    assert.match(live.validateProviderDraft({ ...sd, Username: 'me' }, 'login', false), /password/);
    assert.equal(live.validateProviderDraft({ ...sd, Username: 'me' }, 'login', true), null, 'a stored password is enough to re-validate');
    assert.match(live.validateProviderDraft({ ...sd, Username: 'me' }, 'listings', true), /country/);
    assert.match(live.validateProviderDraft({ ...sd, Username: 'me', Country: 'GBR', ZipCode: 'SW1' }, 'listings', true), /lineup/);
    assert.equal(live.validateProviderDraft({ ...sd, Username: 'me', Country: 'GBR', ZipCode: 'SW1', ListingsId: 'L' }, 'listings', true), null);
    const xml = live.providerDraftFrom(null, 'xmltv');
    assert.match(live.validateProviderDraft(xml, 'listings', false), /XMLTV/);
    assert.match(live.validateProviderDraft({ ...xml, Path: '/g.xml', EnableAllTuners: false, EnabledTuners: [] }, 'listings', false), /tuner/);
});

test('MISS-31 channel mapping rows prefer saved mappings over server suggestions', () => {
    const rows = live.mergeChannelMappings({
        TunerChannels: [
            { Id: '101', Name: 'BBC One', ProviderChannelId: 'auto-1', ProviderChannelName: 'BBC One HD' },
            { Id: '102', Name: 'BBC Two', ProviderChannelId: 'auto-2', ProviderChannelName: 'BBC Two' },
            { Id: '103', Name: 'Local' },
        ],
        ProviderChannels: [{ Id: 'auto-1', Name: 'BBC One HD' }, { Id: 'manual-2', Name: 'BBC Two England' }, { Id: 'auto-2', Name: 'BBC Two' }],
        Mappings: [{ Name: '102', Value: 'manual-2' }],
    });
    assert.deepEqual(rows.map(r => [r.tunerChannelId, r.providerChannelId, r.providerChannelName, r.explicit]), [
        ['101', 'auto-1', 'BBC One HD', false],
        ['102', 'manual-2', 'BBC Two England', true],
        ['103', '', '', false],
    ]);
});

test('MISS-31 Schedules Direct countries skip the placeholder region and sort by name', () => {
    assert.deepEqual(live.schedulesDirectCountries({
        'North America': [{ fullName: 'United States', shortName: 'USA' }, { fullName: 'Canada', shortName: 'CAN' }],
        ZZZ: [{ fullName: 'Example', shortName: 'ZZZ' }],
        Europe: [{ fullName: 'United Kingdom', shortName: 'GBR' }],
    }), [
        { name: 'Canada', value: 'CAN' },
        { name: 'United Kingdom', value: 'GBR' },
        { name: 'United States', value: 'USA' },
    ]);
});

test('MISS-31 late loads cannot populate another tuner or provider draft', () => {
    const tracker = new live.ProvisioningLoadTracker();
    const a = tracker.begin('tuner-a');
    const b = tracker.begin('tuner-b');
    assert.equal(tracker.isCurrent(a, 'tuner-a'), false);
    assert.equal(tracker.isCurrent(b, 'tuner-a'), false);
    assert.equal(tracker.isCurrent(b, 'tuner-b'), true);
    tracker.cancel();
    assert.equal(tracker.isCurrent(b, 'tuner-b'), false);
    assert.equal(live.canSaveProvisioningDraft('loading', undefined, 'new', false), false);
    assert.equal(live.canSaveProvisioningDraft('error', 'p1', 'p1', false), false, 'a failed load is not saveable');
    assert.equal(live.canSaveProvisioningDraft('ready', 'p1', 'p2', false), false);
    assert.equal(live.canSaveProvisioningDraft('ready', 'p1', 'p1', true), false);
    assert.equal(live.canSaveProvisioningDraft('ready', 'new', 'new', false), true);
});

test('MISS-31 admin API uses the Live TV provisioning endpoints', async () => {
    const api = adminApi();
    responses.push(
        { status: 200, body: '[]' },
        { status: 200, body: '{"Id":"t1"}' },
        { status: 204, body: '' },
        { status: 200, body: '{"Id":"p1"}' },
        { status: 204, body: '' },
        { status: 200, body: '[]' },
        { status: 200, body: '{}' },
        { status: 200, body: '{"Id":"101"}' },
    );
    await api.discoverTuners();
    await api.saveTunerHost({ Type: 'm3u', Url: '/a.m3u' });
    await api.deleteTunerHost('t1');
    await api.saveListingProvider({ Type: 'SchedulesDirect', Username: 'me', Password: 'secret' }, { validateLogin: true });
    await api.deleteListingProvider('p 1');
    await api.getLineups({ Id: 'p1', Type: 'SchedulesDirect', ZipCode: 'SW1A 1AA', Country: 'GBR' });
    await api.getChannelMappingOptions('p1');
    await api.setChannelMapping('p1', '101', 'bbc1');

    const [discover, saveTuner, deleteTuner, saveProvider, deleteProvider, lineups, options, mapping] = requests;
    assert.equal(new URL(discover.url).pathname, '/LiveTv/Tuners/Discover');
    assert.equal(new URL(discover.url).searchParams.get('newDevicesOnly'), 'true');

    assert.equal(saveTuner.method, 'POST');
    assert.equal(new URL(saveTuner.url).pathname, '/LiveTv/TunerHosts');
    assert.deepEqual(JSON.parse(saveTuner.body), { Type: 'm3u', Url: '/a.m3u' });

    assert.equal(deleteTuner.method, 'DELETE');
    assert.equal(new URL(deleteTuner.url).searchParams.get('id'), 't1');

    const providerUrl = new URL(saveProvider.url);
    assert.equal(providerUrl.pathname, '/LiveTv/ListingProviders');
    assert.equal(providerUrl.searchParams.get('validateLogin'), 'true');
    assert.equal(providerUrl.searchParams.has('pw'), false, 'pw would make the server store a pre-hashed password that is hashed again at sign-in');
    assert.equal(JSON.parse(saveProvider.body).Password, 'secret');

    assert.equal(deleteProvider.method, 'DELETE');
    assert.equal(new URL(deleteProvider.url).searchParams.get('id'), 'p 1');

    const lineupUrl = new URL(lineups.url);
    assert.equal(lineupUrl.pathname, '/LiveTv/ListingProviders/Lineups');
    assert.equal(lineupUrl.searchParams.get('location'), 'SW1A 1AA');
    assert.equal(lineupUrl.searchParams.get('country'), 'GBR');

    assert.equal(new URL(options.url).searchParams.get('providerId'), 'p1');

    assert.equal(mapping.method, 'POST');
    assert.equal(new URL(mapping.url).pathname, '/LiveTv/ChannelMappings');
    assert.deepEqual(JSON.parse(mapping.body), { ProviderId: 'p1', TunerChannelId: '101', ProviderChannelId: 'bbc1' });
});
