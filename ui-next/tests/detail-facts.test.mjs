import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readSource } from './source.mjs';

const source = file => readSource(new URL(`../src/${file}`, import.meta.url), 'utf8');

test('detail page: external links sit inside the badge row, not as a stray link paragraph', () => {
    const facts = source('detail-sections.tsx');
    assert.match(facts, /class="detail-badges">\s*\{[\s\S]*links\.map[\s\S]*class="detail-badge detail-link"/, 'links render in the badges row as badge anchors');
    assert.doesNotMatch(facts, /class="detail-links"/, 'the separate link paragraph is gone');
    const css = source('style.css');
    assert.doesNotMatch(css, /\.detail-links/);
    assert.match(css, /\.detail-link \{ color: var\(--accent\); text-decoration: none/);
});

test('detail page: episode navigation states what the chips are', () => {
    const app = source('main.tsx');
    assert.match(app, /detail-episode-nav[\s\S]{0,200}<h2>/, 'nav heading matches the "More like this" section style');
    assert.match(app, /More in this season/);
    assert.match(app, /detail-episode-nav-tag">Previous</, 'prev chip is labelled Previous');
    assert.match(app, /detail-episode-nav-tag">Next</, 'next chip is labelled Next');
    const css = source('style.css');
    assert.match(css, /\.detail-episode-chip \{ display: grid;[^\n]+/);
    assert.match(css, /\.detail-episode-nav-tag \{[^\n]+text-transform: uppercase/);
    assert.match(css, /\.detail-episode-nav h2, \.detail-linked h2/, 'heading shares the section h2 rules');
});
