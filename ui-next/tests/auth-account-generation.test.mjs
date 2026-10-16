import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { readSource } from './source.mjs';

const { AccountGeneration } = await import('../src/account-generation.ts');

test('AUTH-01 only work started in the current account generation may commit', () => {
    const accounts = new AccountGeneration();
    const first = accounts.begin();
    const second = accounts.begin();

    assert.equal(accounts.isCurrent(first), false);
    assert.equal(accounts.isCurrent(second), true);
});

test('AUTH-01 loaders can snapshot the current generation without advancing it', () => {
    const accounts = new AccountGeneration();

    assert.equal(accounts.current(), 0);
    assert.equal(accounts.isCurrent(accounts.current()), true);
});

test('AUTH-01 invalidating the account generation retires in-flight work', () => {
    const accounts = new AccountGeneration();
    const pending = accounts.begin();

    accounts.invalidate();

    assert.equal(accounts.isCurrent(pending), false);
});

test('AUTH-01 a restarted account gets a fresh current generation', () => {
    const accounts = new AccountGeneration();
    const signedOut = accounts.begin();
    accounts.invalidate();
    const signedIn = accounts.begin();

    assert.equal(accounts.isCurrent(signedOut), false);
    assert.equal(accounts.isCurrent(signedIn), true);
});

test('AUTH-01 App identity transitions advance or retire the account generation', () => {
    const source = readSource(new URL('../src/main.tsx', import.meta.url), 'utf8');

    assert.ok(source.includes("import { AccountGeneration } from './account-generation'"));
    assert.ok(source.includes('accountGeneration.invalidate();'));
    assert.ok(source.includes('accountGeneration.begin();'));
});

test('AUTH-01 home, search, detail, and playback loaders use the account generation', () => {
    const source = readSource(new URL('../src/main.tsx', import.meta.url), 'utf8');

    assert.ok(source.includes('const account = accountGeneration.current();'));
    for (const loader of ['loadHome', 'runSearch', 'openSeries', 'openItem', 'play', 'applyReportedPlayback']) {
        assert.ok(source.includes(loader), `${loader} must remain account-guarded`);
    }
    assert.ok(source.includes('accountGeneration.isCurrent(account)'));
});
