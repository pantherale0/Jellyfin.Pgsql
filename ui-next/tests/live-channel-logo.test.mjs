import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { extname } from 'node:path';
import { test } from 'node:test';

registerHooks({
    resolve(specifier, context, nextResolve) {
        return nextResolve(specifier.startsWith('.') && !extname(specifier) ? `${specifier}.ts` : specifier, context);
    }
});

const liveModel = await import('../src/live-model.ts');

test('guide uses channel-specific images in order and ignores backdrops', () => {
    assert.equal(liveModel.guideChannelLogoType({ ImageTags: { Primary: 'primary', Thumb: 'thumb', Logo: 'logo' } }), 'Primary');
    assert.equal(liveModel.guideChannelLogoType({ ImageTags: { Thumb: 'thumb', Logo: 'logo' } }), 'Thumb');
    assert.equal(liveModel.guideChannelLogoType({ ImageTags: { Logo: 'logo' } }), 'Logo');
    assert.equal(liveModel.guideChannelLogoType({ ImageTags: {}, BackdropImageTags: [ 'backdrop' ] }), null);
});
