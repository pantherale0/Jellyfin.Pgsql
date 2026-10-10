import assert from 'node:assert/strict';
import { test } from 'node:test';

const buildFeatures = await import('../src/build-features.ts').catch(() => ({}));

test('classic web links remain available unless the build explicitly disables them', () => {
    const classicWebAvailable = buildFeatures.classicWebAvailable;
    assert.equal(typeof classicWebAvailable, 'function', 'classic web build flag helper must exist');
    assert.equal(classicWebAvailable(undefined), true);
    assert.equal(classicWebAvailable('true'), true);
    assert.equal(classicWebAvailable('false'), false);
});
