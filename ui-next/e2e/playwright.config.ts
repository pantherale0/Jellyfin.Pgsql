import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const mode = process.env.E2E_APP || 'dev';
if (mode !== 'dev' && mode !== 'preview') throw new Error('E2E_APP must be "dev" or "preview".');

const fakePort = 8097;
const fakeServerUrl = `http://127.0.0.1:${fakePort}`;
const appPort = mode === 'preview' ? 4179 : 5179;
const appUrl = `http://127.0.0.1:${appPort}`;
const authFile = resolve(projectRoot, 'test-results/.auth/user.json');
const tvUserAgent = 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/68.0.3440.106 Safari/537.36 WebAppManager';
const appCommand = mode === 'preview'
    ? `npm run build -- --mode e2e && npx vite preview --host 127.0.0.1 --port ${appPort} --strictPort`
    : `npx vite --host 127.0.0.1 --port ${appPort} --strictPort`;

process.env.E2E_FAKE_SERVER_URL = fakeServerUrl;
process.env.E2E_AUTH_FILE = authFile;

export default defineConfig({
    testDir: '.',
    fullyParallel: false,
    forbidOnly: Boolean(process.env.CI),
    retries: process.env.CI ? 1 : 0,
    workers: 1,
    timeout: 30_000,
    expect: { timeout: 5_000 },
    outputDir: resolve(projectRoot, 'test-results'),
    reporter: [ [ 'list' ], [ 'html', { outputFolder: resolve(projectRoot, 'playwright-report'), open: 'never' } ] ],
    use: {
        baseURL: appUrl,
        viewport: { width: 1280, height: 900 },
        reducedMotion: 'reduce',
        trace: 'on-first-retry',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
        launchOptions: { args: [ '--autoplay-policy=no-user-gesture-required' ] }
    },
    projects: [
        {
            name: 'setup',
            testMatch: 'support/auth.setup.ts',
            use: { ...devices['Desktop Chrome'], storageState: { cookies: [], origins: [] } }
        },
        {
            name: 'chromium',
            testMatch: 'tests/**/*.spec.ts',
            testIgnore: 'tests/tv-*.spec.ts',
            dependencies: [ 'setup' ],
            use: { ...devices['Desktop Chrome'], storageState: authFile }
        },
        {
            name: 'tv',
            testMatch: 'tests/tv-*.spec.ts',
            dependencies: [ 'setup' ],
            use: {
                ...devices['Desktop Chrome'],
                userAgent: tvUserAgent,
                viewport: { width: 1920, height: 1080 },
                storageState: authFile
            }
        }
    ],
    webServer: [
        {
            command: 'node e2e/fake-server/server.mjs',
            cwd: projectRoot,
            url: `${fakeServerUrl}/__control/health`,
            timeout: 30_000,
            reuseExistingServer: false,
            stderr: 'pipe',
            env: { E2E_FAKE_SERVER_PORT: String(fakePort) }
        },
        {
            command: appCommand,
            cwd: projectRoot,
            url: appUrl,
            timeout: 120_000,
            reuseExistingServer: false,
            env: {
                JELLYFIN_BACKEND_URL: fakeServerUrl,
                VITE_JELLYFIN_SERVER_URL: '',
                UI_NEXT_PROBE_ALLOWED_ORIGINS: appUrl
            }
        }
    ]
});
