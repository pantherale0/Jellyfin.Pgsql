import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { extname } from 'node:path';
import { test } from 'node:test';
import { readSource } from './source.mjs';

registerHooks({
    resolve(specifier, context, nextResolve) {
        return nextResolve(specifier.startsWith('.') && !extname(specifier) ? `${specifier}.ts` : specifier, context);
    }
});

const source = file => readSource(new URL(`../src/${file}`, import.meta.url), 'utf8');

test('player OSD: one Hugeicons family, no emoji or text-glyph controls', async () => {
    const player = source('player.tsx');
    assert.match(player, /@hugeicons\/core-free-icons/);
    for (const glyph of [ '|◀', '▶|', '⏮', '⏭', '⤮', '⧉', '⛶', '⚙', '🔁', '🔂', '🔇', '🔊', '←', '❚❚', '>−10', '>+10' ]) {
        assert.doesNotMatch(player, new RegExp(glyph.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `glyph should be replaced by an SVG icon: ${glyph}`);
    }
    const css = source('style.css');
    assert.match(css, /\.player-menu-scrim \{[^}]*z-index/);
    assert.doesNotMatch(css, /\.player-control:hover, \.player-control\.active, \.player-play \{/, 'play/pause must not be a permanently filled disc');
});

test('player OSD: popouts close with a full-stage click-away scrim', () => {
    const player = source('player.tsx');
    assert.match(player, /\{menu && <div class="player-menu-scrim"/);
    assert.match(player, /class="player-menu-scrim"[^>]*onPointerDown=\{closeMenu\}/);
    assert.match(player, /data-menu-open=\{menu \? 'true' : 'false'\}/, 'CSS gates menu-open behavior on the stage attribute');
    const css = source('style.css');
    assert.match(css, /\[data-menu-open="true"\] \.player-osd \{ z-index: 4; pointer-events: none; \}/);
    assert.match(css, /\[data-menu-open="true"\] \.player-osd :is\([^\]]+\) \{ pointer-events: auto; \}/);
    assert.match(css, /\[data-menu-open="true"\] \.player-drawer \{ z-index: 6; \}/);
    assert.match(player, /closest\('\.player-osd, \.player-drawer, \.player-menu-scrim, \.player-error, \.player-end-screen'\)/, 'clicks in the movie end screen must not also start the play toggle');
});

test('player OSD: Magic Remote pointer and TV keys summon the bar without side effects', () => {
    const player = source('player.tsx');
    // Chromium 53 (webOS TV 4) predates PointerEvent, so the Magic Remote's mouse-compat
    // events need fallbacks that stay silent where pointer events exist.
    assert.match(player, /onMouseDown=\{onMouseDown\}/);
    assert.match(player, /onMouseMove=\{onMouseMove\}/);
    assert.match(player, /typeof \(window as Window & \{ PointerEvent\?: unknown \}\)\.PointerEvent !== 'undefined'/);
    assert.match(player, /const onMouseMove = \(event: MouseEvent\) => \{\n\s+if \(pointerEventsSupported\) return;/);
    assert.match(player, /const onMouseDown = \(event: MouseEvent\) => \{\n\s+if \(pointerEventsSupported\) return;/);
    // Slider drags and the menu scrim need the same fallback, and the drag release must
    // survive both pointerup and compat mouseup reaching it.
    assert.match(player, /onMouseDown=\{\(\) => \{ if \(!pointerEventsSupported\) holdUntilRelease\(true\); \}\}/);
    assert.match(player, /onMouseDown=\{\(\) => \{ if \(!pointerEventsSupported\) holdUntilRelease\(false\); \}\}/);
    assert.match(player, /class="player-menu-scrim"[^>]*onMouseDown=\{closeMenu\}/);
    assert.match(player, /window\.addEventListener\('mouseup', release\);/);
    assert.match(player, /if \(releaseRef\.current !== release\) return;/);
    // Magic Remote wheel adjusts volume on TV clients only; desktop wheel is untouched.
    assert.match(player, /onWheel=\{onStageWheel\}/);
    assert.match(player, /if \(!tvRef\.current\) return;/);
    assert.match(player, /setPlayerVolume\(video\.volume \+ \(delta < 0 \? 0\.05 : -0\.05\), false\)/);
    // TV pattern: with the bar hidden, the first arrow press only summons it instead of
    // seeking or changing the volume as a side effect of peeking.
    assert.match(player, /if \(tvRef\.current && !osdRef\.current && arrow\) \{\n\s+event\.preventDefault\(\);\n\s+reveal\(\);\n\s+return;\n\s+\}/);
    const css = source('style.css');
    assert.match(css, /html:not\(\.tv-client\) \.player-stage\[data-osd-open="false"\]/, 'hiding the cursor would also hide the Magic Remote pointer');
});

test('player OSD: every transport control renders from the shared icon registry', () => {
    const player = source('player.tsx');
    for (const name of [ 'back', 'chapters', 'episodes', 'previous', 'next', 'chapter-prev', 'chapter-next', 'rewind-10', 'forward-10', 'shuffle', 'captions', 'settings', 'close' ]) {
        assert.match(player, new RegExp(`name="${name}"`), `registry icon has a consumer: ${name}`);
    }
    assert.match(player, /name=\{paused \? 'play' : 'pause'\}/);
    assert.match(player, /name=\{queue\.repeat === 'one' \? 'repeat-one' : 'repeat'\}/);
    assert.match(player, /name=\{muted \|\| volume === 0 \? 'volume-mute' : 'volume-high'\}/);
    assert.match(player, /name=\{pip \? 'pip-exit' : 'pip'\}/);
    assert.match(player, /name=\{fullscreen \? 'fullscreen-exit' : 'fullscreen'\}/);
});
