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

const { applyDisplaySettings, DEFAULT_DISPLAY, normalizeDisplaySettings } = await import('../src/display-settings.ts');
const { inlineSign, loadMessages, resolveLanguage } = await import('../src/i18n.ts');
const { libraryColumnCount } = await import('../src/library-geometry.ts');

const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');

test('display settings normalize unknown and partial values to the defaults', () => {
    assert.deepEqual(normalizeDisplaySettings(null), DEFAULT_DISPLAY);
    assert.deepEqual(normalizeDisplaySettings({ theme: 'sepia', textSize: 120, reducedMotion: 'yes' }), DEFAULT_DISPLAY);
    assert.deepEqual(normalizeDisplaySettings({ theme: 'light', textSize: '115', reducedMotion: true }), { theme: 'light', textSize: 115, reducedMotion: true });
    assert.deepEqual(normalizeDisplaySettings({ theme: 'system', textSize: 90 }), { theme: 'system', textSize: 90, reducedMotion: false });
});

test('display settings apply theme, root font size and motion to the document element', () => {
    const root = { dataset: {}, style: { fontSize: '' } };
    applyDisplaySettings({ theme: 'light', textSize: 130, reducedMotion: true }, root);
    assert.deepEqual({ ...root.dataset }, { theme: 'light', motion: 'reduce' });
    assert.equal(root.style.fontSize, '130%');
    applyDisplaySettings(DEFAULT_DISPLAY, root);
    assert.deepEqual({ ...root.dataset }, { theme: 'dark' });
    assert.equal(root.style.fontSize, '');
});

test('the stylesheet defines light and system themes and keeps the player dark', () => {
    assert.match(css, /html\[data-theme=light\] \{[^}]*--text:/);
    assert.match(css, /@media \(prefers-color-scheme: light\) \{\s*html\[data-theme=system\]/);
    assert.match(css, /\.player-stage \{[^}]*--ink: 255, 255, 255/);
    assert.match(css, /html\[data-motion=reduce\] \*/);
    assert.equal((css.match(/rgba\(\s*255\s*,\s*255\s*,\s*255/g) || []).length, 0, 'white overlays use rgba(var(--ink), …) so the light theme can invert them');
});

test('right-to-left layout flips arrows and scroll direction but keeps time axes left to right', () => {
    assert.match(css, /\[dir=rtl\] \.dir-arrow \{[^}]*scaleX\(-1\)/);
    assert.match(css, /\[dir=rtl\] \.player-timeline[^{]*\.live-guide-scroll \{ direction: ltr; \}/);
    const physical = css.split('\n').filter(line => !line.startsWith('.player') && !line.includes('safe-area-inset') && !line.includes('tv-client') && /(?<![-\w])(margin|padding)-(left|right):/.test(line));
    assert.deepEqual(physical, [], 'spacing outside the left-to-right player and TV physical fallback uses logical properties');
    const tvLogical = css.split('\n').filter(line => line.includes('tv-client') && !line.includes(':not(.tv-client)') && /(?<![-\w])(margin|padding)-inline|(?<![-\w])inset(?:-(?:inline|block))?(?:-(?:start|end))?:/.test(line));
    assert.deepEqual(tvLogical, [], 'TV rules avoid logical spacing and inset properties unsupported on webOS 4 / Chromium 53');
    assert.match(css, /html\.tv-client \.topbar > \* \+ \* \{ margin-left: var\(--tv-space\); \}/);
    assert.match(css, /html\.tv-client \.topbar \.search-box \{[^}]*margin-left: auto; padding-left: var\(--tv-space\); \}/);
    assert.match(css, /html\.tv-client \.login-page \{ display: flex; align-items: center; justify-content: center;/);
    assert.match(css, /html\.tv-client\.tv-no-grid \.login-card\.login-layout \{ display: flex; align-items: center; justify-content: space-between; gap: 0; \}/);
    assert.match(css, /html\.tv-client \.login-panel \.quick-connect-code \{ margin: 24px 0 16px; padding: 24px 16px; font-size: 56px;/);
    assert.match(css, /html\.tv-client \.library-quality \{ right: \.45rem; \}/);
    assert.match(css, /html\[dir="rtl"\]\.tv-client \.topbar > \* \+ \* \{ margin-left: 0; margin-right: var\(--tv-space\); \}/);
    assert.match(css, /html\[dir="rtl"\]\.tv-client \.topbar \.search-box \{ margin-left: 0; margin-right: auto; padding-left: 0; padding-right: var\(--tv-space\); \}/);
    assert.match(css, /html\[dir="rtl"\]\.tv-client \.library-quality \{ right: auto; left: \.45rem; \}/);
    assert.match(css, /html\[dir="rtl"\]\.tv-client\.tv-no-grid \.login-intro \{ margin-right: 0; margin-left: 64px; \}/);
    assert.match(css, /html\[dir="rtl"\]\.tv-client\.tv-no-grid \.library-grid-cell/);
    assert.match(css, /html\[dir="rtl"\]\.tv-client\.tv-no-grid \.live-channel/);
    assert.equal(libraryColumnCount({ getPropertyValue: () => '', gridTemplateColumns: undefined }), 1, 'Chromium 53 undefined gridTemplateColumns falls back safely before TV CSS variables apply');
    const main = readSource(new URL('../src/main.tsx', import.meta.url));
    assert.doesNotMatch(main, /\u2315|⌕/, 'search button avoids the U+2315 glyph missing on webOS TV fonts');
    assert.match(main, /class="search-toggle"[\s\S]*?<svg viewBox="0 0 24 24"/);
    assert.match(main, /const tvClient = isTvClient\(\);\s*document\.documentElement\.classList\.toggle\('tv-client', tvClient\);\s*document\.documentElement\.classList\.toggle\('tv-no-grid', tvClient && !supportsCssGrid\(\)\);/);
    loadMessages('ar', {});
    assert.equal(inlineSign(), -1);
    loadMessages('en-us', {});
    assert.equal(inlineSign(), 1);
    assert.equal(resolveLanguage('pt', [ 'pt-br', 'fr' ]), 'pt-br');
    assert.equal(resolveLanguage('xx', [ 'fr' ]), 'en-us');
});

test('the Display screen is reachable from the profile menu and changing language reloads', () => {
    const profile = readSource(new URL('../src/profile.tsx', import.meta.url));
    const main = readSource(new URL('../src/main.tsx', import.meta.url));
    assert.match(main, /openProfileScreen\('display'\)/);
    assert.match(profile, /screen === 'display' && <section/);
    assert.match(profile, /storeLanguage\(session\.user\.Id, code\);[\s\S]*window\.location\.reload\(\)/);
    assert.match(main, /resolveLanguage\(readStoredLanguage\(session\.user\.Id\)/);
    assert.match(readSource(new URL('../src/boot.ts', import.meta.url)), /applyDisplaySettings\(loadDisplaySettings\(\)\)/);
});
