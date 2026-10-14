import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
const store = new Map();
beforeEach(() => { requests.length = 0; responses.length = 0; store.clear(); });
globalThis.window = { location: { href: 'https://jf.test/web/', origin: 'https://jf.test' }, setTimeout };
globalThis.localStorage = { getItem: key => store.has(key) ? store.get(key) : null, setItem: (key, value) => { store.set(key, String(value)); }, removeItem: key => { store.delete(key); } };
if (typeof globalThis.document === 'undefined') globalThis.document = { createElement: () => ({ canPlayType: () => '' }) };
globalThis.XMLHttpRequest = class {
    constructor() { this.headers = {}; }
    open(method, url) { this.method = method; this.url = url; this.responseURL = url; }
    setRequestHeader(name, value) { this.headers[name] = value; }
    abort() { this.onabort?.(); }
    send(body) {
        requests.push({ method: this.method, url: this.url, headers: this.headers, body });
        const response = responses.shift() || { status: 204, body: '' };
        queueMicrotask(() => { this.status = response.status; this.responseText = response.body; this.onload(); });
    }
};

const account = await import('../src/account.ts');
const controls = await import('../src/controls.ts');
const { preferredScrollBehavior } = await import('../src/live-model.ts');
const { JellyfinApi } = await import('../src/api.ts');
const source = path => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
const session = { server: 'https://jf.test', token: 'token', user: { Id: 'me', Name: 'Me' }, serverId: 's' };

test('MISS-44: TV profile menu reaches playback, subtitle and control settings', () => {
    const main = source('main.tsx');
    const menu = main.slice(main.indexOf('<div class="profile-menu" role="menu"'), main.indexOf('Switch user</button>'));
    const tvOnlyStart = menu.indexOf('{!tvClient && <>');
    for (const screen of [ 'playback', 'subtitles', 'controls' ]) {
        const at = menu.indexOf(`openProfileScreen('${screen}')`);
        assert.ok(at > 0 && at < tvOnlyStart, `${screen} must be outside the desktop-only block`);
    }
});

test('MISS-46: forgot-password outcomes and PIN redemption', async () => {
    const now = Date.parse('2026-10-14T12:00:00Z');
    const pin = account.forgotPasswordOutcome({ Action: 'PinCode', PinFile: '/config/passwordreset1.json', PinExpirationDate: '2026-10-14T12:30:00Z' }, now);
    assert.equal(pin.askPin, true);
    assert.match(pin.message, /reset PIN.*30 minutes/);
    assert.doesNotMatch(pin.message, /passwordreset1\.json|\/config/);
    assert.deepEqual(account.forgotPasswordOutcome({ Action: 'InNetworkRequired' }).askPin, false);
    assert.match(account.forgotPasswordOutcome({ Action: 'ContactAdmin' }).message, /administrator/);
    assert.deepEqual(account.pinRedeemMessage({ Success: true, UsersReset: [ 'ann' ] }).ok, true);
    assert.equal(account.pinRedeemMessage({ Success: false }).ok, false);

    responses.push({ status: 200, body: JSON.stringify({ Action: 'PinCode' }) }, { status: 404, body: '' });
    await JellyfinApi.forgotPassword('https://jf.test', 'ann');
    assert.deepEqual(await JellyfinApi.redeemPasswordPin('https://jf.test', '12-34'), { Success: false });
    assert.equal(requests[0].url, 'https://jf.test/Users/ForgotPassword');
    assert.deepEqual(JSON.parse(requests[0].body), { EnteredUsername: 'ann' });
    assert.equal(requests[1].url, 'https://jf.test/Users/ForgotPassword/Pin');
    const main = source('main.tsx');
    assert.match(main, /Forgot password\?/);
    assert.match(main, /redeemPasswordPin/);
});

test('MISS-47: own password change and avatar upload/delete', async () => {
    assert.match(account.validatePasswordChange('', 'n', 'n', true), /current/);
    assert.match(account.validatePasswordChange('a', 'b', 'c', true), /match/);
    assert.match(account.validatePasswordChange('a', 'a', 'a', true), /different/);
    assert.equal(account.validatePasswordChange('', 'new', 'new', false), '');
    assert.match(account.validateAvatar({ type: 'image/svg+xml', size: 10 }), /PNG/);
    assert.match(account.validateAvatar({ type: 'image/png', size: 11 * 1024 * 1024 }), /10 MB/);
    assert.equal(account.base64FromDataUrl('data:image/png;base64,QUJD'), 'QUJD');
    assert.equal(account.base64FromDataUrl('data:text/plain,hello'), '');

    const api = new JellyfinApi(session);
    await api.changeOwnPassword('old', 'new');
    await api.uploadOwnAvatar('QUJD', 'image/png');
    await api.deleteOwnAvatar();
    assert.deepEqual(requests.map(r => `${r.method} ${r.url}`), [ 'POST https://jf.test/Users/Password?userId=me', 'POST https://jf.test/UserImage?userId=me', 'DELETE https://jf.test/UserImage?userId=me' ]);
    assert.deepEqual(JSON.parse(requests[0].body), { CurrentPw: 'old', NewPw: 'new' });
    assert.equal(requests[1].headers['Content-Type'], 'image/png');
    assert.equal(requests[1].body, 'QUJD');
    assert.equal(account.userImageUrl('https://jf.test/', 'me', 'tag1', 96), 'https://jf.test/UserImage?userId=me&maxHeight=96&quality=90&tag=tag1');
    assert.match(source('profile.tsx'), /screen === 'account' && account/);
});

test('MISS-48: public users are listed and passwordless users sign in directly', async () => {
    assert.deepEqual(account.publicUsers([ { Id: 'a', Name: 'Ann', HasPassword: false }, { Id: 'b', Name: '' }, null, { Id: 'c', Name: 'Cy', PrimaryImageTag: 't' } ]), [
        { Id: 'a', Name: 'Ann', HasPassword: false, PrimaryImageTag: undefined }, { Id: 'c', Name: 'Cy', HasPassword: true, PrimaryImageTag: 't' },
    ]);
    responses.push({ status: 500, body: '' });
    assert.deepEqual(await JellyfinApi.getPublicUsers('https://jf.test'), []);
    const main = source('main.tsx');
    assert.match(main, /if \(!user\.HasPassword\) \{ void signIn\(user\.Name, ''\); return; \}/);
    assert.match(main, /aria-label="Users on this server"/);
});

test('MISS-50: control preferences drive gamepad navigation and smooth scrolling', () => {
    assert.deepEqual(controls.loadControlPreferences(), { gamepad: true, smoothScroll: 'auto' });
    controls.saveControlPreferences({ smoothScroll: 'off', gamepad: false });
    assert.deepEqual(controls.loadControlPreferences(), { gamepad: false, smoothScroll: 'off' });
    assert.equal(preferredScrollBehavior(), 'auto');
    controls.saveControlPreferences({ smoothScroll: 'on' });
    assert.equal(preferredScrollBehavior(), 'smooth');
    assert.deepEqual(controls.normalizeControls({ smoothScroll: 'weird', gamepad: 'yes' }), { gamepad: true, smoothScroll: 'auto' });

    const pressed = index => Array.from({ length: 16 }, (_, i) => ({ pressed: i === index }));
    assert.deepEqual(controls.gamepadDirections(pressed(12), [ 0, 0 ]), [ 'ArrowUp' ]);
    assert.deepEqual(controls.gamepadDirections(pressed(0), [ 0.9, 0 ]), [ 'ArrowRight', 'Enter' ]);
    assert.deepEqual(controls.gamepadDirections(pressed(1), [ 0, 0 ]), [ 'Escape' ]);

    const held = new Map();
    assert.deepEqual(controls.gamepadKeysToEmit(held, [ 'ArrowDown', 'Enter' ], 0), [ 'ArrowDown', 'Enter' ]);
    assert.deepEqual(controls.gamepadKeysToEmit(held, [ 'ArrowDown', 'Enter' ], 100), []);
    assert.deepEqual(controls.gamepadKeysToEmit(held, [ 'ArrowDown', 'Enter' ], controls.GAMEPAD_REPEAT_DELAY_MS), [ 'ArrowDown' ]);
    assert.deepEqual(controls.gamepadKeysToEmit(held, [], 1000), []);
    assert.deepEqual(controls.gamepadKeysToEmit(held, [ 'Enter' ], 1001), [ 'Enter' ]);
    assert.match(source('main.tsx'), /gamepadEnabled \? startGamepadBridge\(\) : undefined/);
    assert.doesNotMatch(source('main.tsx'), /behavior: 'smooth'/);
});
