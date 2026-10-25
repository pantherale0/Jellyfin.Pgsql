export interface RecordedRequest {
    method: string;
    path: string;
    query: Record<string, string>;
    authorizationPresent: boolean;
    body: unknown;
    status: number;
    unexpected: boolean;
}

const controlUrl = process.env.E2E_FAKE_SERVER_URL || 'http://127.0.0.1:8097';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRecordedRequests(value: unknown): RecordedRequest[] {
    if (!Array.isArray(value)) throw new Error('Fake server returned an invalid request log.');

    return value.map((entry, index) => {
        if (!isRecord(entry) || !isRecord(entry.query)
            || typeof entry.method !== 'string'
            || typeof entry.path !== 'string'
            || typeof entry.authorizationPresent !== 'boolean'
            || typeof entry.status !== 'number'
            || typeof entry.unexpected !== 'boolean') {
            throw new Error(`Fake server returned an invalid request entry at index ${index}.`);
        }
        const query: Record<string, string> = {};
        for (const [ key, queryValue ] of Object.entries(entry.query)) {
            if (typeof queryValue !== 'string') throw new Error(`Fake server returned an invalid query value for ${key}.`);
            query[key] = queryValue;
        }
        return {
            method: entry.method,
            path: entry.path,
            query,
            authorizationPresent: entry.authorizationPresent,
            body: entry.body,
            status: entry.status,
            unexpected: entry.unexpected
        };
    });
}

export async function resetFakeServer(): Promise<void> {
    const response = await fetch(`${controlUrl}/__control/reset`, { method: 'POST' });
    if (response.status !== 204) throw new Error(`Fake server reset failed with HTTP ${response.status}.`);
}

export async function fakeServerRequests(): Promise<RecordedRequest[]> {
    const response = await fetch(`${controlUrl}/__control/requests`);
    if (!response.ok) throw new Error(`Fake server request log failed with HTTP ${response.status}.`);
    const value: unknown = await response.json();
    return parseRecordedRequests(value);
}
