import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { extname } from 'node:path';
import { test } from 'node:test';

registerHooks({
    resolve(specifier, context, nextResolve) {
        return nextResolve(specifier.startsWith('.') && !extname(specifier) ? `${specifier}.ts` : specifier, context);
    }
});

const store = new Map();
globalThis.window = { location: { href: 'https://jellyfin.example.test/web/' } };
globalThis.localStorage = { getItem: key => store.has(key) ? store.get(key) : null, setItem: (key, value) => { store.set(key, String(value)); }, removeItem: key => { store.delete(key); } };

class FakeElement {
    constructor(name, children = []) {
        this.name = name;
        this.tagName = 'DIV';
        this.attributes = new Map();
        this.children = children;
        this.parentElement = null;
        children.forEach(child => { child.parentElement = this; });
    }
    setAttribute(key, value) { this.attributes.set(key, value); }
    removeAttribute(key) { this.attributes.delete(key); }
    hasAttribute(key) { return this.attributes.has(key); }
}
globalThis.HTMLElement = FakeElement;

const source = file => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
const focus = () => import('../src/dialog-focus.ts');

test('UX-01/02/10 dialog lifecycle: Tab wraps inside, Back keys close, background goes inert', async () => {
    const { wrapTabTarget, isBackKey, inertOutside } = await focus();
    const controls = [ 'close', 'input', 'submit' ];
    assert.equal(wrapTabTarget(controls, 'submit', false), 'close', 'Tab from the last control wraps to the first');
    assert.equal(wrapTabTarget(controls, 'close', true), 'submit', 'Shift+Tab from the first wraps to the last');
    assert.equal(wrapTabTarget(controls, 'input', false), null, 'inner moves stay native');
    assert.equal(wrapTabTarget(controls, 'outside', false), 'close', 'focus outside the dialog is pulled back in');
    assert.equal(wrapTabTarget([], 'x', false), null);
    for (const key of [ { key: 'Escape' }, { key: 'GoBack' }, { key: 'Unidentified', keyCode: 461 }, { key: 'Unidentified', keyCode: 10009 } ]) assert.ok(isBackKey(key), JSON.stringify(key));
    assert.ok(!isBackKey({ key: 'Enter', keyCode: 13 }));

    const dialog = new FakeElement('dialog');
    const backdrop = new FakeElement('backdrop');
    backdrop.setAttribute('data-dialog-backdrop', '');
    const layer = new FakeElement('layer', [ backdrop, dialog ]);
    const header = new FakeElement('header');
    const main = new FakeElement('main');
    const shell = new FakeElement('shell', [ header, layer, main ]);
    const already = new FakeElement('already-inert');
    already.setAttribute('inert', '');
    const body = new FakeElement('body', [ shell, already ]);
    globalThis.document = { body };
    const restore = inertOutside(dialog);
    assert.ok(header.hasAttribute('inert') && main.hasAttribute('inert'), 'page chrome and content are inert');
    assert.ok(!backdrop.hasAttribute('inert'), 'click-to-close backdrops stay interactive');
    assert.ok(!layer.hasAttribute('inert') && !dialog.hasAttribute('inert'), 'the dialog path stays live');
    restore();
    assert.ok(!header.hasAttribute('inert') && !main.hasAttribute('inert'));
    assert.ok(already.hasAttribute('inert'), 'pre-existing inert state is not cleared');

    assert.match(source('profile.tsx'), /useDialogFocus\(dialogRef, screen === 'quickconnect'/, 'Quick Connect uses the shared lifecycle');
    assert.match(source('main.tsx'), /useDialogFocus\(mobileNavRef, isMobileNavOpen, closeMobileNav/, 'mobile drawer');
    assert.match(source('live-tv.tsx'), /useDialogFocus\(sheetRef, Boolean\(sheet\), closeSheet/, 'live program sheet');
    assert.match(source('live-tv.tsx'), /useDialogFocus\(editorRef, Boolean\(editor\)/, 'timer editor');
    assert.match(source('library.tsx'), /useDialogFocus\(menuRef, menu, closeMenu/, 'library card sheet');
    const admin = source('admin/admin-dashboard.tsx');
    assert.match(admin, /useDialogFocus\(sidebarRef, sidebarOpen && sidebarOverlay/, 'admin sidebar is modal only as an overlay');
    assert.match(admin, /class="admin-overlay" data-dialog-backdrop/);
});

test('UX-03 consumer views form a browser history with push for pages and replace within a page', async () => {
    const { routeFor, routeIdentity, historyAction, routeFromState, withRoute } = await import('../src/app-routes.ts');
    const home = routeFor({ view: 'home' });
    const library = routeFor({ view: 'library', libraryId: 'lib' });
    const guide = routeFor({ view: 'live', liveTab: 'guide' });
    const dvr = routeFor({ view: 'live', liveTab: 'dvr' });
    assert.deepEqual(library, { view: 'library', libraryId: 'lib' });
    assert.equal(routeFor({ view: 'library' }), null, 'incomplete routes are not recorded');
    assert.equal(routeFor({ view: 'admin' }), null, 'admin owns its hash routes');
    assert.equal(historyAction(null, home, false), 'replace', 'the first route replaces the landing entry');
    assert.equal(historyAction(home, library, false), 'push');
    assert.equal(historyAction(guide, dvr, false), 'replace', 'tab changes do not flood history');
    assert.equal(historyAction(guide, guide, false), 'none');
    assert.equal(historyAction(home, library, true), 'replace', 'Back/Forward restoration never pushes');
    assert.equal(routeIdentity(routeFor({ view: 'player', playerItemId: 'a' })), routeIdentity(routeFor({ view: 'player', playerItemId: 'b' })), 'next episode replaces the player entry');
    const state = withRoute({ other: 1 }, routeFor({ view: 'show', seriesId: 's', season: '2' }));
    assert.equal(state.other, 1, 'unrelated history state survives');
    assert.deepEqual(routeFromState(state), { view: 'show', seriesId: 's', season: '2' });
    assert.equal(routeFromState(null), null);
    assert.equal(routeFromState({ uiNext: { view: 'details' } }), null, 'malformed state is ignored');
    const main = source('main.tsx');
    assert.match(main, /window\.addEventListener\('popstate', onPopState\)/);
    assert.match(main, /if \(action === 'push' && previous\?\.view === 'player'\) \{[\s\S]*?window\.history\.back\(\);/, 'leaving the player steps back instead of duplicating the origin');
    assert.match(main, /window\.history\.replaceState\(window\.history\.state, ''/, 'query updates keep the recorded route');
});

test('UX-04 the player keeps keyboard focus on visible controls', () => {
    const player = source('player.tsx');
    assert.match(player, /if \(event\.key === 'Tab' && rootRef\.current\) \{\s*\/\/ Keyboard focus must never land on controls the user cannot see\.\s*if \(!osdRef\.current\) \{\s*event\.preventDefault\(\);\s*reveal\(\);/);
    const main = source('main.tsx');
    assert.match(main, /if \(view === 'player'\) shell\.setAttribute\('inert', ''\)/, 'the background is inert, not just aria-hidden');
});

test('UX-05 the profile menu owns arrow keys and opens from the keyboard', () => {
    const main = source('main.tsx');
    assert.match(main, /window\.addEventListener\('keydown', onMenuKeyDown, true\)/);
    assert.match(main, /event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*const index = items\.indexOf/, 'the TV geometric mover cannot move focus twice');
    assert.match(main, /if \(!profileMenuOpen && !isTvClient\(\) && \(event\.key === 'ArrowDown' \|\| event\.key === 'ArrowUp'\)\)/);
});

test('UX-06 native selects keep Up/Down on TV', async () => {
    const { nativeControlOwnsKey } = await focus();
    assert.ok(nativeControlOwnsKey({ tagName: 'select' }, 'ArrowDown'));
    assert.ok(!nativeControlOwnsKey({ tagName: 'SELECT' }, 'ArrowRight'), 'Left/Right leave a select');
    assert.ok(nativeControlOwnsKey({ tagName: 'INPUT', type: 'range' }, 'ArrowUp'));
    assert.ok(nativeControlOwnsKey({ tagName: 'INPUT', type: 'text' }, 'ArrowLeft'));
    assert.ok(!nativeControlOwnsKey({ tagName: 'BUTTON' }, 'ArrowDown'));
    assert.match(source('main.tsx'), /if \(event\.target instanceof HTMLSelectElement && nativeControlOwnsKey\(event\.target, event\.key\)\) return;/);
});

test('UX-07/08/17/18/21/22 CSS: visible focus, active+focused letters, TV type scale, hit areas, header overflow, scroll cues', () => {
    const css = source('style.css');
    assert.match(css, /\.search-box\.expanded:focus-within \{ border-color: var\(--accent\)/);
    assert.match(css, /select:focus-visible, textarea:focus-visible \{ outline: 3px solid/);
    assert.match(css, /\.tv-client \.alpha-scrubber button\.active\[data-focusable="true"\]:focus[^{]*\{ color: #11150c; background: var\(--accent\); box-shadow: inset 0 0 0 2px #fff; \}/);
    assert.match(css, /\.tv-client \{ --tv-min-text: 1rem;/);
    assert.match(css, /\.tv-client \.home-feed-card-overlay strong, \.tv-client \.library-card-copy strong/);
    assert.match(css, /@media \(pointer: coarse\) \{[\s\S]*\.recommendation-dot::after \{ content: ''; position: absolute; inset: -16px -6px; \}/);
    assert.match(css, /\.topbar \{ padding-left: max\(var\(--page-gutter\), env\(safe-area-inset-left\)\)/);
    assert.match(css, /\.primary-nav \{ flex: 0 1 auto; overflow-x: auto;/);
    assert.match(css, /\.admin-workspace, \.admin-workspace \*, textarea, pre,[^{]*\{\s*scrollbar-width: thin;/);
});

test('UX-09 virtualized grids continue Tab traversal into unmounted items and expose position', async () => {
    const { virtualTabTarget } = await focus();
    assert.equal(virtualTabTarget(23, 0, 24, 100, false), 24, 'Tab from the last mounted cell mounts the next');
    assert.equal(virtualTabTarget(24, 24, 48, 100, true), 23, 'Shift+Tab from the first mounted cell mounts the previous');
    assert.equal(virtualTabTarget(99, 76, 100, 100, false), null, 'the end of the list lets focus move on');
    assert.equal(virtualTabTarget(10, 0, 24, 100, false), null, 'inner cells move natively');
    assert.equal(virtualTabTarget(-1, 0, 24, 100, false), null);
    const main = source('main.tsx');
    assert.match(main, /role="listitem" aria-posinset=\{startIndex \+ offset \+ 1\} aria-setsize=\{items\.length\} data-grid-index/);
    assert.match(main, /'\.home-feed-blocks, \.library-grid-items, \.virtualized-poster-grid, /, 'search grid joins generic focus recovery');
    const library = source('library.tsx');
    assert.match(library, /role="listitem" aria-posinset=\{absStart \+ offset \+ 1\} aria-setsize=\{total\}/);
    assert.match(library, /virtualTabTarget\(Number\(cell\.dataset\.gridIndex\), absStart, absEnd, total, event\.shiftKey\)/);
});

test('UX-11 the guide is a coherent two-column grid with contextual program names', () => {
    const guide = source('live-guide.tsx');
    assert.match(guide, /role="grid" aria-label="Program guide" aria-rowcount=\{props\.channels\.length \+ 1\} aria-colcount=\{2\}/);
    assert.match(guide, /class="live-guide-head" role="row" aria-rowindex=\{1\}/);
    assert.match(guide, /role="row" aria-rowindex=\{index \+ 2\}/, 'rows carry absolute indices while virtualized');
    assert.match(guide, /class="live-channel" role="rowheader" aria-colindex=\{1\}/);
    assert.match(guide, /class="live-track" role="gridcell" aria-colindex=\{2\}/);
    assert.match(guide, /aria-label=\{programLabel\(program, channel, segment\.start, segment\.end, airing\)\}/);
    assert.match(guide, /`\$\{program\.Name \|\| 'Program'\}, \$\{channel\.Name \|\| 'channel'\}, \$\{formatClock\(from\)\} to \$\{formatClock\(to\)\}\$\{airing \? ', on now' : ''\}`/);
});

test('UX-12 selected states are exposed to assistive technology', () => {
    const player = source('player.tsx');
    assert.equal((player.match(/'player-menu-item active' : 'player-menu-item'\} aria-pressed=/g) || []).length, 8, 'audio, subtitles, secondary subtitles (off and tracks), speed, fit, version and quality');
    assert.match(player, /aria-pressed=\{entry\.Id === seasonId\}/);
    assert.match(player, /aria-pressed=\{pip\}/);
    assert.match(source('live-guide.tsx'), /aria-pressed=\{day\.start === dayStart\}/);
    const ui = source('admin/ui.tsx');
    assert.match(ui, /aria-pressed=\{value === o\}/);
    assert.match(ui, /aria-pressed=\{value === t\}/);
});

test('UX-14 spotlight favorite names its state and keeps failures visible', () => {
    const feed = source('home-feed.tsx');
    assert.match(feed, /aria-label=\{favorited \? 'Favorite \(saved\)' : 'Add to favorites'\}/);
    assert.match(feed, /\{favoriteError && <p class="notice error" role="alert">/);
    assert.doesNotMatch(feed, /[Ww]atchlist/);
    assert.match(source('style.css'), /\.home-spotlight-actions \.notice \{ grid-column: 1 \/ -1; \}/);
});

test('UX-15 the Quick Connect sign-in branch renders the shared expiry notice', () => {
    const main = source('main.tsx');
    const branch = main.slice(main.indexOf("if (!localLogin && quickConnectSelected && quickConnectEnabled) {"), main.indexOf('return <main class="login-page">\n            <section class="login-card login-layout"'));
    assert.match(branch, /\{error && <p class="notice error" role="alert">\{error\}<\/p>\}/);
    assert.match(main, /setError\('Your session expired\. Sign in again\.'\)/);
});

test('UX-16 consumer errors map HTTP failures to actions and keep raw text for diagnostics', async () => {
    const { userMessage, errorDiagnostic } = await import('../src/ui-errors.ts');
    const http = (status, message) => Object.assign(new Error(message), { status });
    assert.match(userMessage(http(500, 'NullReferenceException at Jellyfin.Server')), /server ran into a problem/);
    assert.doesNotMatch(userMessage(http(500, 'NullReferenceException')), /NullReference/);
    assert.match(userMessage(http(403, 'Forbidden')), /permission/);
    assert.match(userMessage(http(404, '')), /no longer available/);
    assert.match(userMessage(http(429, '')), /busy/);
    assert.match(userMessage(http(504, '')), /longer than expected/);
    assert.equal(userMessage(new Error('The Jellyfin server took too long to respond.')), 'The Jellyfin server took too long to respond.', 'client-authored copy is kept');
    assert.equal(userMessage('nope', 'Fallback.'), 'Fallback.');
    assert.equal(errorDiagnostic(http(500, 'raw body')), 'HTTP 500: raw body');
    assert.match(source('main.tsx'), /function messageOf\(error: unknown\): string \{\s*const message = userMessage\(error\);/);
    assert.match(source('live-tv.tsx'), /\?\.status === 403\) return denied;\s*return userMessage\(error\);/);
    assert.match(source('main.tsx'), /<div class="loading-bar" role="status" aria-live="polite"><span class="visually-hidden">Loading…<\/span><\/div>/);
    assert.match(source('main.tsx'), /title="More titles could not load"/, 'optional home paging failures are visible');
});

test('UX-20 layout follows an explicit choice, then the wrapper layout, then the user agent', async () => {
    const { classifyLayout, normalizeLayoutChoice, readLayoutChoice, saveLayoutChoice, LAYOUT_STORAGE_KEY } = await import('../src/layout-mode.ts');
    const desktopUa = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/141.0';
    const tvUa = 'Mozilla/5.0 (Web0S; Linux/SmartTV) Chrome/94';
    assert.equal(classifyLayout({ userAgent: desktopUa, nativeLayout: null }), 'desktop', 'a bridge without a layout no longer forces TV');
    assert.equal(classifyLayout({ userAgent: desktopUa, nativeLayout: 'tv' }), 'tv');
    assert.equal(classifyLayout({ userAgent: tvUa, nativeLayout: 'mobile' }), 'desktop', 'a wrapper that reports mobile wins over the UA');
    assert.equal(classifyLayout({ userAgent: tvUa }), 'tv');
    assert.equal(classifyLayout({ userAgent: tvUa, choice: 'desktop' }), 'desktop', 'explicit choice wins');
    assert.equal(normalizeLayoutChoice('nonsense'), 'auto');
    saveLayoutChoice('tv');
    assert.equal(store.get(LAYOUT_STORAGE_KEY), 'tv');
    assert.equal(readLayoutChoice(), 'tv');
    window.location.href = 'https://jellyfin.example.test/web/?layout=desktop';
    assert.equal(readLayoutChoice(), 'desktop', 'the URL overrides storage');
    window.location.href = 'https://jellyfin.example.test/web/';
    saveLayoutChoice('auto');
    assert.equal(store.has(LAYOUT_STORAGE_KEY), false);
    assert.match(source('main.tsx'), /function isTvClient\(\): boolean \{\s*return isTvLayout\(\);/);
    assert.match(source('profile.tsx'), /Layout on this device/);
});
