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
    const physical = css.split('\n').filter(line => !line.startsWith('.player') && !line.includes('safe-area-inset') && /(?<![-\w])(margin|padding)-(left|right):/.test(line));
    assert.deepEqual(physical, [], 'spacing outside the left-to-right player uses logical properties');
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
