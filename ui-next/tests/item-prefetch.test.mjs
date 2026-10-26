import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { extname } from 'node:path';
import { test } from 'node:test';

registerHooks({
    resolve(specifier, context, nextResolve) {
        return nextResolve(specifier.startsWith('.') && !extname(specifier) ? `${specifier}.ts` : specifier, context);
    }
});

const { ItemDetailsPrefetcher } = await import('../src/item-prefetch.ts');
const item = { Id: 'movie-1', Name: 'Movie One', Type: 'Movie' };

test('prefetch leases share one request and abort it when the last owner leaves', async () => {
    let calls = 0;
    let requestSignal;
    const prefetcher = new ItemDetailsPrefetcher((itemId, signal, priority) => {
        calls++;
        requestSignal = signal;
        assert.equal(itemId, item.Id);
        assert.equal(priority, 'background');
        return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
                const error = new Error('Request aborted.');
                error.name = 'AbortError';
                reject(error);
            }, { once: true });
        });
    });

    const hero = prefetcher.acquire(item.Id, 'background');
    const card = prefetcher.acquire(item.Id, 'background');
    assert.equal(calls, 1);

    hero.release();
    assert.equal(requestSignal.aborted, false, 'the card still owns the request');
    card.release();
    assert.equal(requestSignal.aborted, true, 'the last owner leaving cancels the request');
    assert.deepEqual(await hero.promise, { kind: 'cancelled' });
});

test('a navigation lease keeps an in-flight prefetch alive and consumes its result', async () => {
    let calls = 0;
    let finishRequest = () => undefined;
    let requestSignal;
    const prefetcher = new ItemDetailsPrefetcher((_itemId, signal) => {
        calls++;
        requestSignal = signal;
        return new Promise(resolve => { finishRequest = resolve; });
    });

    const focus = prefetcher.acquire(item.Id, 'background');
    const navigation = prefetcher.acquire(item.Id, 'interactive');
    assert.equal(calls, 1, 'navigation joins the same item request');
    focus.release();
    assert.equal(requestSignal.aborted, false);

    finishRequest(item);
    assert.deepEqual(await navigation.promise, { kind: 'ready', item });
    assert.deepEqual(navigation.item, item);
    navigation.release();
    assert.equal(requestSignal.aborted, false, 'a completed request is not aborted');
});

test('a ready item is shared while an owner still holds its lease', async () => {
    let calls = 0;
    const prefetcher = new ItemDetailsPrefetcher(async () => {
        calls++;
        return item;
    });

    const hero = prefetcher.acquire(item.Id, 'background');
    assert.deepEqual(await hero.promise, { kind: 'ready', item });
    const navigation = prefetcher.acquire(item.Id, 'interactive');
    assert.deepEqual(navigation.item, item);
    assert.equal(calls, 1);
    hero.release();
    navigation.release();
});

test('a failed prefetch is removed so a later owner can retry', async () => {
    let calls = 0;
    const prefetcher = new ItemDetailsPrefetcher(async () => {
        calls++;
        if (calls === 1) throw new Error('temporary failure');
        return item;
    });

    const failed = prefetcher.acquire(item.Id, 'background');
    assert.equal((await failed.promise).kind, 'failed');
    failed.release();

    const retry = prefetcher.acquire(item.Id, 'background');
    assert.deepEqual(await retry.promise, { kind: 'ready', item });
    assert.equal(calls, 2);
    retry.release();
});
