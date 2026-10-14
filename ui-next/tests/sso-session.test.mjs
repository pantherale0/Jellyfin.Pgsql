import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
const ssoSession = await import('../src/sso-session.ts');

const origin = 'https://jellyfin.example.test';
const startedAt = 1791622800000;
const serverId = 'server-id';
const accessToken = 'new-access-token';
const attempt = (overrides = {}) => JSON.stringify({
    server: origin,
    startedAt,
    previousAccessToken: null,
    ...overrides
});
const callbackCredentials = (dateLastAccessed, overrides = {}) => JSON.stringify({
    Servers: [
        {
            Id: serverId,
            ManualAddress: origin,
            LocalAddress: origin,
            UserId: 'user-id',
            AccessToken: accessToken,
            DateLastAccessed: dateLastAccessed,
            ...overrides
        }
    ]
});
const handoffInput = (overrides = {}) => ({
    serverOrigin: origin,
    credentials: callbackCredentials(startedAt + 1000),
    apiKey: accessToken,
    userId: 'user-id',
    serverId,
    attempt: attempt(),
    now: startedAt + 2000,
    ...overrides
});

function parseHandoff(input) {
    assert.equal(typeof ssoSession.parseSsoHandoff, 'function', 'classic SSO handoff parser must exist');
    return ssoSession.parseSsoHandoff(input);
}

test('parses a fresh classic web SSO callback for this origin', () => {
    assert.deepEqual(parseHandoff(handoffInput()), {
        server: origin,
        token: accessToken,
        userId: 'user-id',
        serverId
    });
});

test('rejects credentials not refreshed after the current SSO attempt', () => {
    assert.equal(parseHandoff(handoffInput({ credentials: callbackCredentials(startedAt - 1000) })), null);
});

test('rejects a token that did not change during the SSO attempt', () => {
    assert.equal(parseHandoff(handoffInput({ attempt: attempt({ previousAccessToken: accessToken }) })), null);
});

test('requires the global callback token and user id to match the selected server entry', () => {
    assert.equal(parseHandoff(handoffInput({ apiKey: 'other-token' })), null);
    assert.equal(parseHandoff(handoffInput({ userId: 'other-user' })), null);
});

test('accepts a newly-created callback credential without an id but verifies the id with the server', () => {
    const credentials = callbackCredentials(startedAt + 1000, { Id: undefined });
    const handoff = parseHandoff(handoffInput({ credentials }));
    assert.deepEqual(handoff, { server: origin, token: accessToken, userId: 'user-id', serverId });
    assert.equal(ssoSession.createSsoSession(handoff, { Id: 'user-id', Name: 'Jordan' }, { Id: 'other-server' }), null);
});

test('rejects credentials stored for a different server origin', () => {
    const credentials = JSON.stringify({ Servers: [ { ...JSON.parse(callbackCredentials(startedAt + 1000)).Servers[0], ManualAddress: 'https://other.example.test', LocalAddress: 'https://other.example.test' } ] });
    assert.equal(parseHandoff(handoffInput({ credentials })), null);
});

test('rejects a credential whose server id differs from the selected Jellyfin server', () => {
    assert.equal(parseHandoff(handoffInput({ credentials: callbackCredentials(startedAt + 1000, { Id: 'other-server-id' }) })), null);
});

test('rejects an expired SSO handoff marker', () => {
    assert.equal(parseHandoff(handoffInput({ now: startedAt + 16 * 60 * 1000 })), null);
});

test('preserves a same-origin Jellyfin base path for the follow-up API request', () => {
    const server = `${origin}/jellyfin`;
    const input = handoffInput({ attempt: attempt({ server }) });
    assert.equal(parseHandoff(input)?.server, server);
});

test('rejects an SSO attempt configured for a different origin', () => {
    assert.equal(parseHandoff(handoffInput({ attempt: attempt({ server: 'https://other.example.test' }) })), null);
});

test('rejects malformed or incomplete SSO callback storage', () => {
    assert.equal(parseHandoff(handoffInput({ credentials: '{' })), null);
    assert.equal(parseHandoff(handoffInput({ serverId: '' })), null);
    assert.equal(parseHandoff(handoffInput({ attempt: null })), null);
});

test('creates a UI Next session only for the authenticated user and server', () => {
    assert.equal(typeof ssoSession.createSsoSession, 'function', 'SSO session builder must exist');
    const handoff = { server: origin, token: accessToken, userId: 'user-id', serverId };
    assert.deepEqual(ssoSession.createSsoSession(handoff, {
        Id: 'user-id', Name: 'Jordan',
        Policy: { IsAdministrator: true, EnableCollectionManagement: true, IsDisabled: false },
        Configuration: { EnableNextEpisodeAutoPlay: false }
    }, { Id: serverId }), {
        server: origin,
        token: accessToken,
        user: {
            Id: 'user-id', Name: 'Jordan',
            Policy: { IsAdministrator: true, IsDisabled: false, EnableCollectionManagement: true },
            Configuration: { EnableNextEpisodeAutoPlay: false }
        },
        serverId
    });
    assert.equal(ssoSession.createSsoSession(handoff, { Id: 'other-user', Name: 'Other' }, { Id: serverId }), null);
    assert.equal(ssoSession.createSsoSession(handoff, { Id: 'user-id', Name: 'Jordan' }, { Id: 'other-server' }), null);
    assert.equal(ssoSession.createSsoSession(handoff, { Id: 'user-id' }, { Id: serverId }), null);
});

test('restores the patched callback with its hyphenated GUID and the API compact GUID', () => {
    const patch = readFileSync(new URL('../../patches/jellyfin_sso.patch', import.meta.url), 'utf8');
    const addedSource = patch.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).map(line => line.slice(1)).join('\n');
    const script = addedSource.match(/<script>\n([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script, 'server callback must contain its credential handoff script');
    const callbackUserId = 'aabbccdd-1122-3344-5566-778899aabbcc';
    const storage = new Map();
    const location = { origin, href: `${origin}/sso/callback` };
    runInNewContext(script
        .replaceAll('""', '"').replaceAll('{{', '{').replaceAll('}}', '}')
        .replace('{authResult.AccessToken}', accessToken)
        .replace('{authResult.User.Id.ToString()}', callbackUserId)
        .replace('{authResult.ServerId}', serverId), {
        localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
        window: { location },
        Date: { now: () => startedAt + 1000 }
    });
    assert.equal(location.href, '/web/index.html');
    const handoff = parseHandoff(handoffInput({
        credentials: storage.get('jellyfin_credentials'),
        apiKey: storage.get('api_key'),
        userId: storage.get('userId'),
        serverId: storage.get('serverId')
    }));
    assert.ok(handoff, 'the actual callback storage must be accepted');
    assert.deepEqual(ssoSession.createSsoSession(handoff, {
        Id: 'aabbccdd112233445566778899aabbcc', Name: 'Jordan'
    }, { Id: serverId }), {
        server: origin, token: accessToken,
        user: { Id: 'aabbccdd112233445566778899aabbcc', Name: 'Jordan' }, serverId
    });
});

test('GUID format compatibility still rejects different or malformed user identities', () => {
    const handoff = { server: origin, token: accessToken, userId: 'AABBCCDD-1122-3344-5566-778899AABBCC', serverId };
    const user = { Id: 'aabbccdd112233445566778899aabbcc', Name: 'Jordan' };
    assert.deepEqual(ssoSession.createSsoSession(handoff, user, { Id: serverId }), {
        server: origin, token: accessToken, user, serverId
    });
    assert.equal(ssoSession.createSsoSession(handoff, { ...user, Id: 'aabbccdd112233445566778899aabbcd' }, { Id: serverId }), null);
    assert.equal(ssoSession.createSsoSession({ ...handoff, userId: 'aabb-ccdd112233445566778899aabbcc' }, user, { Id: serverId }), null);
    assert.equal(ssoSession.createSsoSession(handoff, user, { Id: 'other-server' }), null);
});

test('a stale SSO restore cannot commit after the request is cancelled or another tab signs out', () => {
    assert.equal(typeof ssoSession.canCommitSsoRestore, 'function', 'SSO restore commit guard must exist');
    assert.equal(ssoSession.canCommitSsoRestore({ requestActive: true, signedOut: false }), true);
    assert.equal(ssoSession.canCommitSsoRestore({ requestActive: false, signedOut: false }), false);
    assert.equal(ssoSession.canCommitSsoRestore({ requestActive: true, signedOut: true }), false);
});
