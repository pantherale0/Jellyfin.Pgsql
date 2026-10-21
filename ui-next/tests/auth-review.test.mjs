import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { extname } from 'node:path';
import { beforeEach, test } from 'node:test';
import { readSource } from './source.mjs';

registerHooks({
    resolve(specifier, context, nextResolve) {
        return nextResolve(specifier.startsWith('.') && !extname(specifier) ? `${specifier}.ts` : specifier, context);
    }
});

const requests = [];
const responses = [];
const storage = new Map();
beforeEach(() => { requests.length = 0; responses.length = 0; storage.clear(); });
globalThis.window = { location: { href: 'https://jellyfin.example.test/web/' }, setTimeout };
globalThis.localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key)
};
if (typeof globalThis.document === 'undefined') globalThis.document = { createElement: () => ({ canPlayType: () => '' }) };
globalThis.XMLHttpRequest = class {
    constructor() { this.headers = {}; }
    open(method, url) { this.method = method; this.url = url; this.responseURL = url; }
    setRequestHeader(name, value) { this.headers[name] = value; }
    send() {
        requests.push({ method: this.method, url: this.url, headers: this.headers });
        const response = responses.shift() || { status: 200, body: '{}' };
        queueMicrotask(() => {
            this.status = response.status;
            this.responseText = response.body;
            this.onload();
        });
    }
};

const main = readSource(new URL('../src/main.tsx', import.meta.url), 'utf8');
const body = (start, end) => {
    const from = main.indexOf(start);
    assert.notEqual(from, -1, `missing ${start}`);
    const to = main.indexOf(end, from + start.length);
    assert.notEqual(to, -1, `missing ${end}`);
    return main.slice(from, to);
};
const session = { server: 'https://jellyfin.example.test', token: 'token', user: { Id: 'user-id', Name: 'User' }, serverId: 'server-id' };

test('AUTH-01 a new account generation retires every earlier owner', async () => {
    const { AccountGeneration } = await import('../src/account-generation.ts');
    const generation = new AccountGeneration();
    const first = generation.current();
    generation.begin();
    assert.equal(generation.isCurrent(first), false);
    const second = generation.current();
    generation.invalidate();
    assert.equal(generation.isCurrent(second), false);
});

test('AUTH-01 home, discovery and post-playback writes all check the account owner', () => {
    const checks = [
        [ body('const loadHome = useCallback(', '}, [ api ]);'), [ 'isLoadCurrent()', 'isSectionCurrent()' ] ],
        [ body('const applyReportedPlayback = async', 'const leavePlayer'), [ 'accountGeneration.isCurrent(account)' ] ]
    ];
    for (const [ source, guards ] of checks) {
        const lines = source.split('\n');
        lines.forEach((line, index) => {
            // Every async continuation that writes state must be guarded on the same line or open with an early return.
            if (!/\.(then|catch|finally)\(/.test(line) && !/^\s*(const \w+ = )?await /.test(lines[index - 1] || '')) return;
            if (!/\bset[A-Z]\w*\(/.test(line)) {
                if (/=> \{\s*$/.test(line) && /\bset[A-Z]\w*\(/.test(lines[index + 1] || '')) {
                    assert.ok(guards.some(guard => lines[index + 1].includes(guard)), `unguarded continuation: ${line.trim()} / ${lines[index + 1].trim()}`);
                }
                return;
            }
            assert.ok(guards.some(guard => line.includes(guard)) || line.includes('saveExtra'), `unguarded write: ${line.trim()}`);
        });
    }
    assert.match(checks[0][0], /const isSectionCurrent = \(\) => isLoadCurrent\(\) && homeSectionGenerations\[section\]\.isCurrent/);
    const playback = checks[1][0];
    assert.match(playback, /await api\.getItem\(itemId\);\s*if \(!accountGeneration\.isCurrent\(account\)\) return;/);
    assert.match(playback, /if \(accountGeneration\.isCurrent\(account\)\) setResumeItems/);
    assert.match(playback, /if \(accountGeneration\.isCurrent\(account\)\) setNextUpItems/);
});

test('AUTH-02 every sign-in path commits through the guarded owner', () => {
    const commit = body('const commitSignIn =', '};');
    assert.match(commit, /clearLoginMarkers\(\)/);
    assert.match(commit, /accountGeneration\.begin\(\)/);
    assert.match(commit, /setSession\(nextSession\)/);
    assert.ok((main.match(/commitSignIn\(/g) || []).length >= 4, 'password, Quick Connect, SSO and remembered sign-ins share the commit');
    const direct = (main.match(/setSession\([^)]*\)/g) || []).sort();
    assert.deepEqual(direct, [ 'setSession(change.session)', 'setSession(nextSession)', 'setSession(null)', 'setSession(previous)' ].sort(),
        'only the shared commit, sign-out, cross-tab adoption and picker return may set the session');
});

test('AUTH-02 abandoned Quick Connect tokens are signed out instead of left live', () => {
    const quickConnect = body('if (cancelled || !authAttempt.isCurrent(attempt)) {', 'commitSignIn(result);');
    assert.match(quickConnect, /new JellyfinApi\(result\)\.logout\(\)/);
    assert.match(quickConnect, /return;/);
});

test('AUTH-02 late remembered-user results cannot touch a newer attempt', () => {
    const remembered = body('const switchToRememberedUser =', 'const signInAsAnotherUser =');
    assert.match(remembered, /\.then\(currentUser => \{\s*if \(!authAttempt\.isCurrent\(attempt\)\) return;/);
    assert.match(remembered, /\.catch\(\(\) => \{\s*if \(!authAttempt\.isCurrent\(attempt\)\) return;/);
    assert.match(body('const returnToUserSwitcher =', 'setSession(previous)'), /authAttempt\.invalidate\(\)/);
    assert.match(body('const signIn = async', 'const useLocalLogin'), /catch[\s\S]*?if \(!authAttempt\.isCurrent\(attempt\)\) return;/);
});

test('AUTH-04 Quick Connect and SSO share the successful-login cleanup', async () => {
    assert.match(body('const commitSignIn =', '};'), /clearLoginMarkers\(\)/);
    const quickConnect = body('if (cancelled || !authAttempt.isCurrent(attempt)) {', 'commitSignIn(result);');
    assert.ok(quickConnect.length > 0);
    const { clearLoginMarkers } = await import('../src/login-markers.ts');
    assert.equal(typeof clearLoginMarkers, 'function');
});

test('AUTH-07 remembered sessions resolve the token owner through /Users/Me', async () => {
    const { JellyfinApi } = await import('../src/api.ts');
    responses.push({ status: 200, body: JSON.stringify({ Id: 'user-id', Name: 'User' }) });
    assert.deepEqual(await JellyfinApi.getUserSession(session), { Id: 'user-id', Name: 'User' });
    assert.equal(requests[0].url, 'https://jellyfin.example.test/Users/Me');
    responses.push({ status: 200, body: JSON.stringify({ Id: 'admin-id', Name: 'Admin' }) });
    await assert.rejects(JellyfinApi.getUserSession(session), error => error.status === 401);
});

test('AUTH-07 SSO restoration rejects a handoff token that belongs to someone else', async () => {
    const { JellyfinApi } = await import('../src/api.ts');
    const handoff = { server: 'https://jellyfin.example.test', token: 'sso-token', userId: 'user-id', serverId: 'server-id' };
    responses.push({ status: 200, body: JSON.stringify({ Id: 'user-id', Name: 'User' }) });
    responses.push({ status: 200, body: JSON.stringify({ Id: 'server-id' }) });
    const restored = await JellyfinApi.restoreSsoSession(handoff);
    assert.equal(restored.user.Id, 'user-id');
    assert.ok(requests.some(request => request.url === 'https://jellyfin.example.test/Users/Me'));
    assert.ok(!requests.some(request => request.url.includes('/Users/user-id')));
    responses.push({ status: 200, body: JSON.stringify({ Id: 'admin-id', Name: 'Admin' }) });
    responses.push({ status: 200, body: JSON.stringify({ Id: 'server-id' }) });
    await assert.rejects(JellyfinApi.restoreSsoSession(handoff));
});

test('AUTH-09 the remembered store is bounded, deduplicated and identity-checked', async () => {
    const remembered = await import('../src/remembered-users.ts');
    const users = Array.from({ length: 20 }, (_, index) => ({ userId: `user-${index % 12}`, name: `User ${index}`, lastSignedIn: index }));
    const servers = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [ `server-${index}`, [ { userId: 'u', name: 'U', lastSignedIn: 1 } ] ]));
    storage.set('jellyfin-ui-next-remembered-users', JSON.stringify({
        'server-id': [
            ...users,
            { userId: 'victim', name: 'Victim', lastSignedIn: 100, session: { ...session, user: { Id: 'admin-id', Name: 'Admin' } } },
            { userId: 'x'.repeat(5000), name: 'Huge', lastSignedIn: 99 }
        ],
        ...servers
    }));
    const list = remembered.getRememberedUsers(session);
    assert.ok(list.length <= 8, 'per-server list is capped');
    assert.equal(new Set(list.map(user => user.userId)).size, list.length, 'one entry per user');
    assert.equal(list[0].lastSignedIn, 19, 'most recent duplicate wins');
    assert.ok(!list.some(user => user.userId === 'victim'), 'a token for another user is not offered');
    assert.ok(!list.some(user => user.userId.length > 512));
    remembered.rememberUser(session);
    const stored = JSON.parse(storage.get('jellyfin-ui-next-remembered-users'));
    assert.ok(Object.keys(stored).length <= 16, 'server keys are capped on rewrite');
    assert.ok(stored['server-id'].length <= 8);
});

test('AUTH-13 the SSO probe offers a retry that re-runs the probe', () => {
    assert.match(main, /const \[ ssoProbe, setSsoProbe \] = useState\(0\);/);
    assert.match(main, /\}, \[ server, tvClient, ssoProbe \]\);/);
    assert.match(main, /onClick=\{\(\) => setSsoProbe\(count => count \+ 1\)\}>Retry<\/button>/);
});

test('AUTH-14 sign-in failures are classified from the HTTP status, not message text', async () => {
    const { signInFailure, signInMessage } = await import('../src/ui-errors.ts');
    const { JellyfinRequestError } = await import('../src/api.ts');
    assert.equal(signInFailure(new JellyfinRequestError(401, 'nope')), 'credentials');
    assert.equal(signInFailure(new JellyfinRequestError(403, 'nope')), 'credentials');
    assert.equal(signInFailure(new JellyfinRequestError(500, 'Server said (401)')), 'other');
    assert.equal(signInFailure(new Error('Request failed (401)')), 'other');
    assert.match(signInMessage(new JellyfinRequestError(401, 'x')), /username and password/);
    assert.doesNotMatch(main, /indexOf\('\(40[13]\)'\)|includes\('\(40[13]\)'\)/);
    assert.match(body('const signIn = async', 'const useLocalLogin'), /setError\(signInMessage\(e\)\)/);
});
