import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { loadConfigFromFile } from 'vite';

test('production HTML makes a cache-busted classic request Android intercepts before module startup', async () => {
    const configPath = fileURLToPath(new URL('../vite.config.ts', import.meta.url));
    const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, configPath, resolve('..'), 'silent');
    assert.ok(loaded, 'the Vite production config must load');

    const plugins = loaded.config.plugins.flat(Infinity).filter(plugin => plugin && typeof plugin === 'object');
    const compatibilityPlugin = plugins.find(plugin => plugin.name === 'ui-next-android-webview-compat');
    assert.ok(compatibilityPlugin, 'the production Vite config must register the Android compatibility plugin');

    assert.equal(typeof compatibilityPlugin.buildStart, 'function', 'the build must emit the Android marker asset');
    const emittedAssets = [];
    compatibilityPlugin.buildStart.call({
        emitFile: asset => { emittedAssets.push(asset); return 'android-compat'; }
    });

    const marker = emittedAssets.find(asset => /(?:^|\/)main\.[^/\s]+\.bundle\.js$/.test(asset.fileName));
    assert.ok(marker, 'the build must emit an asset matching Android’s main bundle path');
    assert.equal(marker.source, ';', 'normal browsers should treat the marker as a no-op');

    const transformHook = compatibilityPlugin.transformIndexHtml;
    const transformIndexHtml = typeof transformHook === 'function' ? transformHook : transformHook?.handler;
    assert.equal(typeof transformIndexHtml, 'function', 'the build must inject a marker request into production HTML');
    assert.equal(transformHook.order, 'post', 'the marker must be inserted after Vite processes the HTML');

    const html = '<html><head><script type="module" src="./assets/app.js"></script></head><body></body></html>';
    const result = await transformIndexHtml.call({}, html, {
        path: '/index.html',
        filename: resolve('index.html')
    });
    assert.ok(Array.isArray(result));
    const markerTag = result.find(tag => tag.tag === 'script');
    assert.equal(markerTag.injectTo, 'head-prepend', 'Android must see the marker before deferred app modules');
    assert.equal(markerTag.attrs, undefined, 'the inline trigger itself is a classic script');
    assert.match(markerTag.children, new RegExp(marker.fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const requestedScripts = [];
    const document = {
        baseURI: 'https://jellyfin.example.test/web/',
        createElement: tagName => ({ tagName }),
        head: { appendChild: script => requestedScripts.push(script) }
    };
    runInNewContext(markerTag.children, { Date: { now: () => 12345 }, URL, document });

    assert.equal(requestedScripts.length, 1);
    assert.equal(requestedScripts[0].src, `https://jellyfin.example.test/web/${marker.fileName}?ts=12345`);

    const fixtureResult = await transformIndexHtml.call({}, html, {
        path: '/debug.html',
        filename: resolve('debug.html')
    });
    assert.equal(fixtureResult, undefined, 'the marker must not be added to non-app HTML entries');
});
