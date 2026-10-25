import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeBackend } from './backend.mjs';
import { FIXTURE_CREDENTIALS } from './fixtures.mjs';

const MAX_BODY_BYTES = 1_048_576;
const assetDirectory = fileURLToPath(new URL('./media/', import.meta.url));
let samplePromise;
let placeholderPromise;

function send(response, status, headers, body = Buffer.alloc(0)) {
    response.writeHead(status, headers);
    response.end(body);
}

function json(response, value, status = 200) {
    send(response, status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(JSON.stringify(value))
    }, Buffer.from(JSON.stringify(value)));
}

function readIncomingBody(request) {
    const contentLength = Number(request.headers['content-length']);
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
        request.resume();
        return Promise.resolve({ tooLarge: true, bytes: contentLength, body: Buffer.alloc(0) });
    }

    return new Promise((resolveBody, reject) => {
        let byteLength = 0;
        let tooLarge = false;
        const chunks = [];

        request.on('data', chunk => {
            byteLength += chunk.length;
            if (byteLength > MAX_BODY_BYTES) {
                tooLarge = true;
                chunks.length = 0;
            } else if (!tooLarge) {
                chunks.push(chunk);
            }
        });
        request.on('end', () => resolveBody({
            tooLarge,
            bytes: byteLength,
            body: tooLarge ? Buffer.alloc(0) : Buffer.concat(chunks)
        }));
        request.on('error', reject);
    });
}

function byteRange(header, size) {
    if (!header) return { kind: 'full', start: 0, end: size - 1 };
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!match || (!match[1] && !match[2])) return { kind: 'invalid' };

    let start;
    let end;
    if (!match[1]) {
        const suffixLength = Number(match[2]);
        if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { kind: 'invalid' };
        start = Math.max(0, size - suffixLength);
        end = size - 1;
    } else {
        start = Number(match[1]);
        end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    }

    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) return { kind: 'invalid' };
    return { kind: 'partial', start, end };
}

async function sampleMedia() {
    samplePromise ??= readFile(resolve(assetDirectory, 'sample.webm'));
    return samplePromise;
}

async function placeholderImage() {
    placeholderPromise ??= readFile(resolve(assetDirectory, 'placeholder.png'));
    return placeholderPromise;
}

function sendMedia(response, bytes, rangeHeader, headOnly = false) {
    const range = byteRange(rangeHeader, bytes.length);
    const commonHeaders = {
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'Content-Type': 'video/webm'
    };
    if (range.kind === 'invalid') {
        send(response, 416, { ...commonHeaders, 'Content-Range': `bytes */${bytes.length}`, 'Content-Length': '0' });
        return;
    }

    const body = bytes.subarray(range.start, range.end + 1);
    if (range.kind === 'partial') {
        send(response, 206, {
            ...commonHeaders,
            'Content-Range': `bytes ${range.start}-${range.end}/${bytes.length}`,
            'Content-Length': String(body.length)
        }, headOnly ? Buffer.alloc(0) : body);
        return;
    }

    send(response, 200, { ...commonHeaders, 'Content-Length': String(bytes.length) }, headOnly ? Buffer.alloc(0) : bytes);
}

async function handleControl(request, response, url, backend) {
    if (url.pathname === '/__control/health' && request.method === 'GET') {
        json(response, { ready: true });
        return true;
    }
    if (url.pathname === '/__control/reset' && request.method === 'POST') {
        backend.reset();
        send(response, 204, { 'Cache-Control': 'no-store', 'Content-Length': '0' });
        return true;
    }
    if (url.pathname === '/__control/requests' && request.method === 'GET') {
        json(response, backend.getRequests());
        return true;
    }
    if (url.pathname.startsWith('/__control/')) {
        json(response, { Message: 'Control endpoint not found.' }, 404);
        return true;
    }
    return false;
}

async function handleIncoming(request, response, backend) {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (url.pathname.startsWith('/__control/')) {
        const controlBody = await readIncomingBody(request);
        if (controlBody.tooLarge) {
            json(response, { Message: 'Request body is too large.' }, 413);
            return;
        }
        if (controlBody.bytes > 0) {
            json(response, { Message: 'Control endpoints do not accept a request body.' }, 400);
            return;
        }
        if (await handleControl(request, response, url, backend)) return;
    }

    const mediaMatch = /^\/Videos\/([^/]+)\/stream$/.exec(url.pathname);
    if (mediaMatch) {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            send(response, 405, { 'Allow': 'GET, HEAD', 'Content-Length': '0' });
            return;
        }
        let itemId;
        try {
            itemId = decodeURIComponent(mediaMatch[1]);
        } catch (_error) {
            send(response, 400, { 'Content-Length': '0' });
            return;
        }
        if (!/^e2e-movie-[1-6]$/.test(itemId) && itemId !== 'e2e-live-channel') {
            json(response, { Message: 'Media not found.' }, 404);
            return;
        }
        if (url.searchParams.get('ApiKey') !== FIXTURE_CREDENTIALS.accessToken) {
            json(response, { Message: 'Unauthorized.' }, 401);
            return;
        }
        sendMedia(response, await sampleMedia(), request.headers.range || '', request.method === 'HEAD');
        return;
    }

    const imageMatch = /^\/(?:Items\/[^/]+\/Images\/|Users\/[^/]+\/Images\/)/.test(url.pathname);
    if (imageMatch) {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            send(response, 405, { 'Allow': 'GET, HEAD', 'Content-Length': '0' });
            return;
        }
        const image = await placeholderImage();
        send(response, 200, {
            'Cache-Control': 'no-store',
            'Content-Type': 'image/png',
            'Content-Length': String(image.length)
        }, request.method === 'HEAD' ? Buffer.alloc(0) : image);
        return;
    }

    const bodyResult = await readIncomingBody(request);
    if (bodyResult.tooLarge) {
        json(response, { Message: 'Request body is too large.' }, 413);
        return;
    }

    const method = request.method || 'GET';
    const headers = new Headers();
    for (const [ name, value ] of Object.entries(request.headers)) {
        if (Array.isArray(value)) value.forEach(entry => headers.append(name, entry));
        else if (value !== undefined) headers.set(name, value);
    }
    const init = { method, headers };
    if (method !== 'GET' && method !== 'HEAD' && bodyResult.body.length > 0) init.body = bodyResult.body;
    const backendResponse = await backend.handle(new Request(url, init));
    const responseHeaders = Object.fromEntries(backendResponse.headers.entries());
    const responseBody = backendResponse.body ? Buffer.from(await backendResponse.arrayBuffer()) : Buffer.alloc(0);
    if (!responseHeaders['content-length'] && backendResponse.status !== 204 && backendResponse.status !== 304) {
        responseHeaders['content-length'] = String(responseBody.length);
    }
    send(response, backendResponse.status, responseHeaders, responseBody);
}

function logRequestFailure(request, error) {
    let path = '/';
    try {
        path = new URL(request.url || '/', 'http://127.0.0.1').pathname;
    } catch (_error) {
        path = '/invalid-url';
    }
    const errorType = error instanceof Error ? error.name : 'UnknownError';
    process.stderr.write(`${JSON.stringify({ event: 'fake_server_request_error', method: request.method || 'GET', path, errorType })}\n`);
}

export function createFakeServer({ backend = createFakeBackend() } = {}) {
    return createServer((request, response) => {
        void handleIncoming(request, response, backend).catch(error => {
            logRequestFailure(request, error);
            if (!response.headersSent) json(response, { Message: 'Fake server request failed.' }, 500);
            else response.destroy();
        });
    });
}

function startFromCommandLine() {
    const port = Number(process.env.E2E_FAKE_SERVER_PORT || 8097);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error('E2E_FAKE_SERVER_PORT must be an integer between 1 and 65535.');
    }
    const server = createFakeServer();
    const shutdown = () => server.close(() => process.exit(0));
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    server.listen(port, '127.0.0.1', () => process.stdout.write(`Fake Jellyfin server listening on 127.0.0.1:${port}\n`));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) startFromCommandLine();
