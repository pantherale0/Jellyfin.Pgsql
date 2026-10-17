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
    assert.match(player, /closest\('\.player-osd, \.player-drawer, \.player-menu-scrim, \.player-error'\)/, 'a scrim close must not also start the play toggle');
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
