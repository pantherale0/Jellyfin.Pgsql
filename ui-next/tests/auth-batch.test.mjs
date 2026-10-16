import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { extname } from 'node:path';
import { test } from 'node:test';
import { readSource } from './source.mjs';

registerHooks({
    resolve(specifier, context, nextResolve) {
        return nextResolve(specifier.startsWith('.') && !extname(specifier) ? `${specifier}.ts` : specifier, context);
    }
});

const store = new Map();
globalThis.localStorage = {
    getItem: key => store.has(key) ? store.get(key) : null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key),
};

const auth = await import('../src/auth-state.ts');
const remembered = await import('../src/remembered-users.ts');
const { SSO_HANDOFF_MAX_AGE_MS } = await import('../src/sso-session.ts');
const source = path => readSource(new URL(`../${path}`, import.meta.url), 'utf8');
const repo = path => readSource(new URL(`../../${path}`, import.meta.url), 'utf8');

const policy = { configuredServer: '', pageOrigin: 'https://media.example.test', allowInsecureHttp: false };
const session = (token, server = 'https://media.example.test', id = 'u1') => ({ server, token, user: { Id: id, Name: 'Ann' }, serverId: 'srv' });

test('AUTH-03: tabs share one session and never erase a newer sign-in', () => {
    assert.deepEqual(auth.sharedSessionChange(JSON.stringify(session('new')), 'old', policy), { action: 'adopt', session: session('new') });
    assert.deepEqual(auth.sharedSessionChange(JSON.stringify(session('same')), 'same', policy), { action: 'none' });
    assert.deepEqual(auth.sharedSessionChange(null, 'old', policy), { action: 'signout' });
    assert.deepEqual(auth.sharedSessionChange(null, null, policy), { action: 'none' });
    assert.deepEqual(auth.sharedSessionChange('{bad json', 'old', policy), { action: 'none' });
    assert.deepEqual(auth.sharedSessionChange(JSON.stringify(session('x', 'http://evil.example')), 'old', policy), { action: 'none' }, 'invalid sessions are not adopted');

    assert.equal(auth.shouldRemoveStoredSession(JSON.stringify(session('mine')), 'mine'), true);
    assert.equal(auth.shouldRemoveStoredSession(JSON.stringify(session('newer')), 'mine'), false);
    assert.equal(auth.shouldRemoveStoredSession(null, 'mine'), false);
    assert.equal(auth.shouldRemoveStoredSession('corrupt', 'mine'), true);

    store.clear();
    const old = session('old-token');
    remembered.rememberUser(session('new-token'));
    remembered.clearRememberedToken(old);
    assert.equal(remembered.getRememberedUsers(old)[0].session.token, 'new-token', 'a rejected old token does not clear a newer remembered token');
    remembered.clearRememberedToken(session('new-token'));
    assert.equal(remembered.getRememberedUsers(old)[0].session, undefined);

    const main = source('src/main.tsx');
    assert.match(main, /shouldRemoveStoredSession\(localStorage\.getItem\(SESSION_KEY\), session\?\.token \|\| null\)/);
    assert.match(main, /sharedSessionChange\(event\.newValue, activeSession\.current\?\.token \|\| null, sessionPolicy\(\)\)/);
});

test('AUTH-05: Quick Connect stops on terminal errors, retries a few transient ones and expires codes', () => {
    const t0 = 1_000_000;
    assert.equal(auth.quickConnectPollOutcome(404, 1, t0, t0 + 1000), 'expired');
    assert.equal(auth.quickConnectPollOutcome(401, 1, t0, t0 + 1000), 'stop');
    assert.equal(auth.quickConnectPollOutcome(403, 1, t0, t0 + 1000), 'stop');
    assert.equal(auth.quickConnectPollOutcome(500, 1, t0, t0 + 1000), 'retry');
    assert.equal(auth.quickConnectPollOutcome(undefined, auth.QUICK_CONNECT_MAX_TRANSIENT_FAILURES, t0, t0 + 1000), 'stop');
    assert.equal(auth.quickConnectPollOutcome(500, 1, t0, t0 + auth.QUICK_CONNECT_CODE_LIFETIME_MS), 'expired');
    const main = source('src/main.tsx');
    assert.match(main, /const endCode = \(message: string\) => \{\s*setQuickConnectCode\(''\);\s*setQuickConnectExpired\(true\);/);
    assert.match(main, /if \(outcome === 'retry'\) \{ schedule\(secret\); return; \}/);
    assert.match(main, /if \(!cancelled\) endCode\(messageOf\(e\)\);/, 'a failed challenge also offers a new code');
    assert.match(main, /quickConnectExpired && <button[^>]*onClick=\{\(\) => setQuickConnectAttempt/);
});

test('AUTH-06: the password field allows passwordless accounts', () => {
    const input = source('src/main.tsx').split('\n').find(line => line.includes('<label>Password<input'));
    assert.ok(input);
    assert.doesNotMatch(input, /\brequired\b/);
    assert.match(input, /Leave empty for passwordless accounts/);
});

test('AUTH-08: remembered sessions pass the active-session checks and must match the current server', () => {
    assert.ok(auth.validStoredSession(session('t'), policy));
    assert.equal(auth.validStoredSession(session('t', 'http://dev.example:8096'), policy), null, 'plain HTTP to another host is refused');
    assert.ok(auth.validStoredSession(session('t', 'http://localhost:8096'), policy));
    assert.ok(auth.validStoredSession(session('t', 'http://dev.example:8096'), { ...policy, allowInsecureHttp: true }));
    assert.equal(auth.validStoredSession(session('t', 'https://user:pw@media.example.test'), policy), null);
    assert.equal(auth.validStoredSession({ ...session('t'), token: '' }, policy), null);
    assert.equal(auth.validStoredSession(session('t', 'https://other.example.test'), { ...policy, configuredServer: 'https://media.example.test/web/' }), null);
    const current = session('current');
    assert.ok(auth.usableRememberedSession(session('r'), current, policy));
    assert.equal(auth.usableRememberedSession(session('r', 'https://staging.example.test'), current, policy), null, 'a token is never sent to another server');
    assert.equal(auth.usableRememberedSession(undefined, current, policy), null);
    assert.match(source('src/main.tsx'), /const remembered = usableRememberedSession\(user\.session, session, sessionPolicy\(\)\);/);
});

test('AUTH-10: preference saves apply only edited fields onto a fresh configuration', () => {
    const fresh = { AudioLanguagePreference: 'fra', SubtitleMode: 'Always', OrderedViews: ['a'] };
    const draft = { AudioLanguagePreference: 'eng', SubtitleMode: 'Default', OrderedViews: [] };
    assert.deepEqual(auth.mergeEditedFields(fresh, draft, ['AudioLanguagePreference']), { AudioLanguagePreference: 'eng', SubtitleMode: 'Always', OrderedViews: ['a'] });
    assert.deepEqual(auth.mergeEditedFields(undefined, draft, []), {});
    const profile = source('src/profile.tsx');
    assert.match(profile, /if \(!configLoaded\) return;/);
    assert.match(profile, /mergeEditedFields\(fresh\.Configuration/);
    assert.match(profile, /editedKeys\.current\.add\(key\)/);
});

test('AUTH-11: preference feedback is bound to the current screen and operation', () => {
    const profile = source('src/profile.tsx');
    assert.match(profile, /setSaved\(false\);\s*setSaving\(false\);\s*setConfigLoaded\(false\);\s*saveOp\.current \+= 1;/);
    assert.match(profile, /if \(current\(operation\)\) setSaving\(false\);/);
    assert.match(profile, /saveOp\.current === op && screenRef\.current === savedScreen/);
});

test('AUTH-12: classic links hand over the active account on the same origin and are labelled otherwise', () => {
    const s = session('tok');
    const existing = JSON.stringify({ Servers: [{ Id: 'srv', AccessToken: 'other', UserId: 'u9', Name: 'Home' }, { Id: 'srv2', AccessToken: 'x' }] });
    const next = JSON.parse(auth.classicCredentialsWithSession(existing, s, 42));
    assert.deepEqual(next.Servers[0], { Id: 'srv', Name: 'Home', ManualAddress: 'https://media.example.test', AccessToken: 'tok', UserId: 'u1', DateLastAccessed: 42 });
    assert.equal(next.Servers.length, 2);
    assert.equal(JSON.parse(auth.classicCredentialsWithSession('broken', s, 1)).Servers.length, 1);
    assert.equal(auth.classicCredentialsWithSession(null, { ...s, serverId: '' }, 1), null);
    assert.equal(auth.canHandOffToClassic(s, 'https://media.example.test'), true);
    assert.equal(auth.canHandOffToClassic(s, 'https://ui.example.test'), false);
    const main = source('src/main.tsx');
    assert.match(main, /classicHandoff \? 'Classic dashboard' : 'Classic dashboard \(separate sign-in\)'/);
    assert.match(main, /localStorage\.setItem\('jellyfin_credentials', credentials\)/);
});

test('SSO-01/02/03: OIDC state is browser-bound, aged on consumption and bounded', () => {
    const patch = repo('patches/jellyfin_sso.patch');
    assert.match(patch, /\+\s+Response\.Cookies\.Append\(StateCookieName, browserNonce/);
    assert.match(patch, /\+\s+HttpOnly = true,/);
    assert.match(patch, /\+\s+SameSite = SameSiteMode\.Lax,/);
    assert.match(patch, /CryptographicOperations\.FixedTimeEquals/);
    assert.match(patch, /\+\s+if \(!NonceMatches\(presentedNonce, cachedState\.BrowserNonce\)\)/);
    assert.match(patch, /\+\s+\|\| DateTime\.UtcNow - cachedState\.CreatedAt > _stateLifetime\)/);
    assert.match(patch, /\+\s+private const int MaxPendingStates = 1000;/);
    assert.match(patch, /\+\s+if \(_stateStore\.Count >= MaxPendingStates\)/);
    assert.match(patch, /\+\s+if \(!force && now\.Ticks - last < _pruneInterval\.Ticks\)/);
    assert.match(patch, /RandomNumberGenerator\.GetBytes\(16\)/);
    assert.match(patch, /_stateLifetime = TimeSpan\.FromMinutes\(10\)/);
    assert.equal(SSO_HANDOFF_MAX_AGE_MS, 10 * 60 * 1000, 'client handoff lifetime matches the server state lifetime');
});

test('SSO-05: the dev SSO probe only reaches configured backends and loopback clients', () => {
    const origins = auth.devProbeOrigins('http://localhost:8096', 'https://media.example.test, not a url ,');
    assert.deepEqual([...origins].sort(), ['http://localhost:8096', 'https://media.example.test']);
    assert.equal(auth.devProbeAllowed(new URL('http://localhost:8096/web'), origins, '127.0.0.1', false), true);
    assert.equal(auth.devProbeAllowed(new URL('http://localhost:8096'), origins, '::ffff:127.0.0.1', false), true);
    assert.equal(auth.devProbeAllowed(new URL('http://169.254.169.254'), origins, '127.0.0.1', false), false);
    assert.equal(auth.devProbeAllowed(new URL('http://localhost:8096'), origins, '192.168.1.20', false), false);
    assert.equal(auth.devProbeAllowed(new URL('http://localhost:8096'), origins, '192.168.1.20', true), true);
    const pkg = JSON.parse(source('package.json'));
    for (const name of ['dev', 'dev:debug', 'preview']) assert.doesNotMatch(pkg.scripts[name], /0\.0\.0\.0/, name);
    assert.match(pkg.scripts['dev:lan'], /UI_NEXT_DEV_LAN=true/);
    assert.match(source('vite.config.ts'), /devProbeAllowed\(target, probeOrigins, request\.socket\.remoteAddress, allowLanProbe\)/);
});
