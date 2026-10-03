import { resolve } from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import legacy from '@vitejs/plugin-legacy';
import preact from '@preact/preset-vite';

export default defineConfig(({ command, mode }) => {
    const input: Record<string, string> = { app: resolve(__dirname, 'index.html') };
    if (command !== 'build') input.debug = resolve(__dirname, 'debug.html');

    const env = loadEnv(mode, process.cwd(), '');
    const backend = env.JELLYFIN_BACKEND_URL || env.VITE_JELLYFIN_SERVER_URL || 'http://localhost:8096';

    return ({
    plugins: [
        preact(),
        {
            name: 'ui-next-debug-sso-probe',
            configureServer(devServer) {
                devServer.middlewares.use('/__debug/sso-config', async (request, response) => {
                    const query = request.url?.split('?')[1] || '';
                    const serverInput = new URLSearchParams(query).get('server');
                    try {
                        if (!serverInput || serverInput.length > 2048) throw new Error('Invalid server address.');
                        const target = new URL(serverInput);
                        if ((target.protocol !== 'http:' && target.protocol !== 'https:')
                            || target.username || target.password || target.search || target.hash) {
                            throw new Error('Invalid server address.');
                        }
                        target.pathname = target.pathname.replace(/\/(web|web\/index\.html)\/?$/i, '').replace(/\/$/, '');
                        const abort = new AbortController();
                        const timeout = setTimeout(() => abort.abort(), 5000);
                        try {
                            const result = await fetch(`${target.toString().replace(/\/$/, '')}/sso/config`, {
                                redirect: 'manual',
                                signal: abort.signal
                            });
                            if (result.status < 200 || result.status >= 300) throw new Error('SSO status unavailable.');
                            const config = await result.json() as { Enabled?: boolean; enabled?: boolean };
                            response.statusCode = 200;
                            response.setHeader('Content-Type', 'application/json; charset=utf-8');
                            response.setHeader('Cache-Control', 'no-store');
                            response.end(JSON.stringify({ Enabled: config.Enabled === true || config.enabled === true }));
                        } finally {
                            clearTimeout(timeout);
                        }
                    } catch (_error) {
                        response.statusCode = 502;
                        response.setHeader('Content-Type', 'application/json; charset=utf-8');
                        response.setHeader('Cache-Control', 'no-store');
                        response.end(JSON.stringify({ error: 'Could not check SSO configuration on that backend.' }));
                    }
                });
            }
        },
        legacy({
            targets: [ 'chrome >= 38', 'safari >= 10', 'firefox >= 45' ],
            modernTargets: [ 'chrome >= 64', 'safari >= 12', 'firefox >= 67' ],
            renderLegacyChunks: true,
            modernPolyfills: false,
            polyfills: [ 'es.promise', 'es.array.iterator', 'es.object.to-string', 'web.dom-collections.iterator' ]
        })
    ],
    base: './',
    publicDir: 'public',
    build: {
        cssCodeSplit: false,
        sourcemap: false,
        rollupOptions: {
            input
        }
    },
    server: {
        proxy: {
            '/sso/config': {
                target: backend,
                changeOrigin: true
            },
            '/System': backend,
            '/Users': backend,
            '/UserItems': backend,
            '/Movies': backend,
            '/Items': backend,
            '/UserViews': backend,
            '/Shows': backend,
            '/LiveTv': backend,
            '/Search': backend,
            '/Videos': backend,
            '/MediaSegments': backend,
            '/PlaybackInfo': backend,
            '/Sessions': backend,
            '/Localization': backend,
            '/QuickConnect': backend,
            '/Pgsql': backend
        }
    }
    });
});
