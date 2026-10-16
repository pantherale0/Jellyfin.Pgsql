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
globalThis.window = { location: { href: 'https://jf.test/web/', origin: 'https://jf.test' }, setTimeout };
globalThis.localStorage = { getItem: key => store.has(key) ? store.get(key) : null, setItem: (key, value) => { store.set(key, String(value)); }, removeItem: key => { store.delete(key); } };
if (typeof globalThis.document === 'undefined') globalThis.document = { createElement: () => ({ canPlayType: () => '' }) };

const bulk = await import('../src/bulk-actions.ts');
const source = path => readSource(new URL(`../src/${path}`, import.meta.url), 'utf8');
const movie = (id, extra = {}) => ({ Id: id, Name: id, Type: 'Movie', MediaType: 'Video', ...extra });
const admin = { Policy: { IsAdministrator: true } };
const viewer = { Policy: { IsAdministrator: false } };

test('MISS-27: selection toggles, select-all merges, and both respect the cap', () => {
    let selection = bulk.toggleSelection(new Map(), movie('a'));
    assert.deepEqual([ ...selection.keys() ], [ 'a' ]);
    selection = bulk.toggleSelection(selection, movie('a'));
    assert.equal(selection.size, 0);
    const many = Array.from({ length: bulk.MAX_SELECTION + 25 }, (_, index) => movie(`m${index}`));
    selection = bulk.selectAll(new Map([ [ 'x', movie('x') ] ]), many);
    assert.equal(selection.size, bulk.MAX_SELECTION);
    assert.ok(selection.has('x'));
    assert.equal(bulk.toggleSelection(selection, movie('extra')).size, bulk.MAX_SELECTION);
});

test('MISS-27: capabilities gate collection/delete and targets skip disallowed items', () => {
    const items = [ movie('a', { CanDelete: true }), movie('b'), { Id: 'p', Name: 'Person', Type: 'Person' } ];
    const adminCaps = bulk.bulkCapabilities(items, admin);
    assert.equal(adminCaps.played, true);
    assert.equal(adminCaps.favorite, true);
    assert.equal(adminCaps.collection, false, 'entities cannot be added to collections');
    assert.equal(adminCaps.deletable, 1);
    assert.equal(bulk.bulkCapabilities([ movie('a') ], viewer).collection, false);
    assert.equal(bulk.bulkCapabilities([ movie('a') ], admin).collection, true);
    assert.deepEqual(bulk.actionTargets(items, 'delete').map(item => item.Id), [ 'a' ]);
    assert.deepEqual(bulk.actionTargets(items, 'played').map(item => item.Id), [ 'a', 'b' ]);
});

test('MISS-27: runBatch bounds concurrency and reports partial failures', async () => {
    let active = 0;
    let peak = 0;
    const items = Array.from({ length: 10 }, (_, index) => movie(`m${index}`));
    const result = await bulk.runBatch(items, async item => {
        active++;
        peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 2));
        active--;
        if (item.Id === 'm3' || item.Id === 'm7') throw new Error('nope');
        return item.Id.toUpperCase();
    }, 3);
    assert.equal(peak, 3);
    assert.equal(result.succeeded.length, 8);
    assert.deepEqual(result.failed.map(item => item.Id).sort(), [ 'm3', 'm7' ]);
    assert.equal(result.succeeded.find(entry => entry.item.Id === 'm0').value, 'M0');
    assert.deepEqual(await bulk.runBatch([], async () => 1), { succeeded: [], failed: [] });
});

test('MISS-27: batch messages summarise success, failure and skipped items', () => {
    assert.deepEqual(bulk.batchMessage('played', 3, 0), { text: 'Marked played: 3 items.', error: false });
    assert.deepEqual(bulk.batchMessage('delete', 1, 1, 2), { text: 'Deleted: 1 item. 1 item failed. 2 items skipped (not allowed).', error: true });
    assert.equal(bulk.batchMessage('favorite', 0, 0).text, 'Nothing to change.');
});

test('MISS-27: library grid wires select mode, bulk bar and two-step delete', () => {
    const library = source('library.tsx');
    assert.match(library, /class="library-bulk-bar" role="toolbar"/);
    assert.match(library, /aria-pressed=\{selecting \? selected : undefined\}/);
    assert.match(library, /if \(selecting\) onToggleSelect\?\.\(item\); else onSelect\(item\);/);
    assert.match(library, /confirmBulkDelete\s*\? <button[^>]*onClick=\{\(\) => void runBulk\('delete'\)\}/);
    assert.match(library, /runBatch\(targets,/);
    assert.match(library, /setSelection\(new Map\(result\.failed\.map/);
    assert.match(library, /<CollectionPicker api=\{api\} itemIds=\{selected\.map\(item => item\.Id\)\}/);
    assert.match(source('detail-sections.tsx'), /export function CollectionPicker\(\{ api, itemIds, onDone \}/);
});
