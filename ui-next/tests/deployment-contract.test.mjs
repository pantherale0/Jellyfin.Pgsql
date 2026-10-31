import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const dockerfile = readFileSync(new URL('../../docker/Dockerfile', import.meta.url), 'utf8');
const workflow = readFileSync(new URL('../../.github/workflows/docker.yaml', import.meta.url), 'utf8');

test('UI Next packages the webOS wrapper manifest', () => {
    const manifestPath = new URL('../public/manifest.json', import.meta.url);
    assert.equal(existsSync(manifestPath), true, 'UI Next public assets include manifest.json');

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.start_url, 'index.html');
    assert.match(dockerfile, /^COPY ui-next\/public\/ \.\/public\/$/m);
});

test('the default Docker target serves UI Next and has no classic web build', () => {
    const stages = [ ...dockerfile.matchAll(/^FROM .+ AS ([\w-]+)$/gm) ].map(match => match[1]);

    assert.equal(stages.at(-1), 'ui-next');
    assert.match(dockerfile, /^ENV JELLYFIN_WEB_DIR=\/jellyfin\/ui-next$/m);
    assert.match(dockerfile, /^COPY --from=ui-next-build \/src\/ui-next\/dist\//m);
    assert.match(dockerfile, /^COPY ui-next\/e2e\/fake-server\/ \.\/e2e\/fake-server\/$/m);
    assert.doesNotMatch(dockerfile, /web-build|jellyfin-web|ui-next-test|AS classic|VITE_CLASSIC_WEB_AVAILABLE/);
});

test('the Docker workflow publishes UI Next under the standard image tags', () => {
    assert.match(workflow, /^\s+target: ui-next$/m);
    assert.ok(workflow.includes('${{ env.IMAGE_NAME }}:${{ steps.image-tag.outputs.tag }}'));
    assert.ok(workflow.includes('${{ env.IMAGE_NAME }}:latest'));
    assert.doesNotMatch(workflow, /web_ui|ui-next-test|target: classic/);
});

test('the repository patch targets contain only the Jellyfin server', () => {
    const repo = fileURLToPath(new URL('../../', import.meta.url));
    const gitmodules = readFileSync(new URL('../../.gitmodules', import.meta.url), 'utf8');
    const patchFiles = readdirSync(new URL('../../patches/', import.meta.url));
    // apply-patches.sh is POSIX sh; use sh so the suite also runs in the Alpine image build.
    const patchList = execFileSync('sh', [ 'scripts/apply-patches.sh', '--list', 'all' ], {
        cwd: repo,
        encoding: 'utf8'
    });

    assert.doesNotMatch(gitmodules, /jellyfin-web/);
    assert.equal(existsSync(new URL('../../jellyfin-web', import.meta.url)), false);
    assert.deepEqual(patchFiles.filter(name => name.startsWith('jellyfin_web') && name.endsWith('.patch')), []);
    assert.doesNotMatch(patchList, /jellyfin-web|jellyfin_web/);
});

test('server patch application rejects legacy web patch names', () => {
    const repo = fileURLToPath(new URL('../../', import.meta.url));
    const patchesDir = mkdtempSync(join(tmpdir(), 'jellyfin-web-patches-'));
    try {
        writeFileSync(join(patchesDir, 'jellyfin_web_old.patch'), '');
        const result = spawnSync('sh', [ 'scripts/apply-patches.sh', '--list', 'all', patchesDir ], { cwd: repo, encoding: 'utf8' });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /web patches are no longer supported/);
    } finally {
        rmSync(patchesDir, { recursive: true, force: true });
    }
});
