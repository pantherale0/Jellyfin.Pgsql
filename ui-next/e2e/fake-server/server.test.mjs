import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FIXTURE_CREDENTIALS } from './fixtures.mjs';

const serverModule = await import('./server.mjs').catch(() => ({}));

async function openServer(options = {}) {
    assert.equal(typeof serverModule.createFakeServer, 'function', 'createFakeServer must be exported');
    const server = serverModule.createFakeServer(options);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server) {
    if (!server.listening) return;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test('control endpoints report readiness, reset and read backend requests', async () => {
    const { server, baseUrl } = await openServer();
    try {
        const health = await fetch(`${baseUrl}/__control/health`);
        assert.equal(health.status, 200);
        assert.deepEqual(await health.json(), { ready: true });

        const info = await fetch(`${baseUrl}/System/Info/Public`);
        assert.equal((await info.json()).ServerName, 'UI Next E2E');

        const requests = await fetch(`${baseUrl}/__control/requests`);
        assert.deepEqual((await requests.json()).map(request => request.path), [ '/System/Info/Public' ]);

        const reset = await fetch(`${baseUrl}/__control/reset`, { method: 'POST' });
        assert.equal(reset.status, 204);
        assert.deepEqual(await (await fetch(`${baseUrl}/__control/requests`)).json(), []);
    } finally {
        await closeServer(server);
    }
});

test('control routes reject bodies that they do not accept', async () => {
    const { server, baseUrl } = await openServer();
    try {
        const malformed = await fetch(`${baseUrl}/__control/reset`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
        });
        assert.equal(malformed.status, 400);

        const oversized = await fetch(`${baseUrl}/__control/reset`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: `{"value":"${'x'.repeat(1_048_577)}"}`
        });
        assert.equal(oversized.status, 413);
        assert.deepEqual(await (await fetch(`${baseUrl}/__control/requests`)).json(), []);
    } finally {
        await closeServer(server);
    }
});

test('unexpected backend failures return a generic response and log sanitized request context', async () => {
    const originalWrite = process.stderr.write.bind(process.stderr);
    let errorLog = '';
    process.stderr.write = chunk => {
        errorLog += String(chunk);
        return true;
    };
    const backend = {
        handle: async () => { throw new Error('secret backend details'); },
        reset() {},
        getRequests: () => []
    };
    const { server, baseUrl } = await openServer({ backend });
    try {
        const response = await fetch(`${baseUrl}/Items?ApiKey=not-for-logs`);
        assert.equal(response.status, 500);
        assert.deepEqual(await response.json(), { Message: 'Fake server request failed.' });
        assert.match(errorLog, /fake_server_request_error/);
        assert.match(errorLog, /"path":"\/Items"/);
        assert.doesNotMatch(errorLog, /secret backend details|not-for-logs/);
    } finally {
        process.stderr.write = originalWrite;
        await closeServer(server);
    }
});

test('HTTP forwarding records sanitized authentication requests', async () => {
    const { server, baseUrl } = await openServer();
    try {
        const response = await fetch(`${baseUrl}/Users/AuthenticateByName`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ Username: FIXTURE_CREDENTIALS.username, Pw: FIXTURE_CREDENTIALS.password })
        });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).AccessToken, FIXTURE_CREDENTIALS.accessToken);

        const requests = await (await fetch(`${baseUrl}/__control/requests`)).json();
        assert.equal(requests[0].path, '/Users/AuthenticateByName');
        assert.equal(requests[0].body.Pw, '[redacted]');
        assert.equal(JSON.stringify(requests).includes(FIXTURE_CREDENTIALS.password), false);
    } finally {
        await closeServer(server);
    }
});

test('WebM route serves the checked-in media and supports a byte range', async () => {
    const { server, baseUrl } = await openServer();
    try {
        const url = `${baseUrl}/Videos/e2e-movie-1/stream?ApiKey=${FIXTURE_CREDENTIALS.accessToken}`;
        const full = await fetch(url);
        assert.equal(full.status, 200);
        assert.equal(full.headers.get('Content-Type'), 'video/webm');
        assert.equal(full.headers.get('Accept-Ranges'), 'bytes');
        const fullBytes = Buffer.from(await full.arrayBuffer());
        assert.ok(fullBytes.length > 100);

        const partial = await fetch(url, { headers: { Range: 'bytes=0-3' } });
        assert.equal(partial.status, 206);
        assert.equal(partial.headers.get('Content-Range'), `bytes 0-3/${fullBytes.length}`);
        assert.equal(partial.headers.get('Content-Length'), '4');
        assert.deepEqual(Buffer.from(await partial.arrayBuffer()), fullBytes.subarray(0, 4));
    } finally {
        await closeServer(server);
    }
});

test('unsatisfiable media ranges return 416 and the resource size', async () => {
    const { server, baseUrl } = await openServer();
    try {
        const response = await fetch(`${baseUrl}/Videos/e2e-movie-1/stream?ApiKey=${FIXTURE_CREDENTIALS.accessToken}`, {
            headers: { Range: 'bytes=999999999-' }
        });
        assert.equal(response.status, 416);
        assert.match(response.headers.get('Content-Range'), /^bytes \*\/\d+$/);
    } finally {
        await closeServer(server);
    }
});

test('image routes return a valid PNG placeholder', async () => {
    const { server, baseUrl } = await openServer();
    try {
        const response = await fetch(`${baseUrl}/Items/e2e-movie-1/Images/Primary?tag=movie-one-image`);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('Content-Type'), 'image/png');
        assert.deepEqual(Buffer.from(await response.arrayBuffer()).subarray(0, 8), Buffer.from([ 137, 80, 78, 71, 13, 10, 26, 10 ]));
    } finally {
        await closeServer(server);
    }
});

test('HTTP server rejects oversized bodies and closes cleanly', async () => {
    const { server, baseUrl } = await openServer();
    const oversized = await fetch(`${baseUrl}/Users/AuthenticateByName`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: `{"Username":"${'x'.repeat(1_048_577)}"}`
    });
    assert.equal(oversized.status, 413);

    await closeServer(server);
    assert.equal(server.listening, false);
    await assert.rejects(fetch(`${baseUrl}/__control/health`));
});
