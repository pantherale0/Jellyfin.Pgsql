import { createFixtureState, FIXTURE_CREDENTIALS } from './fixtures.mjs';

const MAX_BODY_BYTES = 1_048_576;
const SECRET_KEY = /password|(^|[^a-z])pw([^a-z]|$)|token|secret|authorization|apikey/i;

function jsonResponse(value, status = 200) {
    return new Response(JSON.stringify(value), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store'
        }
    });
}

function emptyResponse(status = 204) {
    return new Response(null, { status });
}

function errorResponse(status, message) {
    return jsonResponse({ Message: message }, status);
}

function sanitize(value, key = '') {
    if (SECRET_KEY.test(key)) return '[redacted]';
    if (Array.isArray(value)) return value.map(entry => sanitize(entry));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([ name, entry ]) => [ name, sanitize(entry, name) ]));
    }
    return value;
}

function tokenFrom(request) {
    const authorization = request.headers.get('Authorization') || '';
    const match = /(?:^|\s|,)Token="([^"]*)"/i.exec(authorization);
    if (match) {
        try {
            return decodeURIComponent(match[1]);
        } catch (_error) {
            return null;
        }
    }
    return request.headers.get('X-Emby-Token') || null;
}

async function parseRequestBody(request) {
    const length = Number(request.headers.get('Content-Length'));
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
        return { kind: 'too-large', byteLength: length };
    }
    if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') {
        return { kind: 'empty' };
    }

    let text;
    try {
        text = await request.clone().text();
    } catch (_error) {
        return { kind: 'malformed', byteLength: 0 };
    }
    const byteLength = Buffer.byteLength(text);
    if (byteLength > MAX_BODY_BYTES) return { kind: 'too-large', byteLength };
    if (!text) return { kind: 'json', value: {} };

    try {
        return { kind: 'json', value: JSON.parse(text) };
    } catch (_error) {
        return { kind: 'malformed', byteLength };
    }
}

function safeRequestDetails(request, url, parsedBody) {
    const query = Object.fromEntries(Array.from(url.searchParams.entries(), ([ key, value ]) => [
        key,
        SECRET_KEY.test(key) ? '[redacted]' : value
    ]));
    const body = parsedBody.kind === 'json'
        ? sanitize(parsedBody.value)
        : parsedBody.kind === 'empty'
            ? null
            : { kind: parsedBody.kind, byteLength: parsedBody.byteLength };

    return {
        method: request.method,
        path: url.pathname,
        query,
        authorizationPresent: Boolean(request.headers.get('Authorization') || request.headers.get('X-Emby-Token')),
        body
    };
}

function paginate(all, url) {
    const start = Math.max(0, Number(url.searchParams.get('StartIndex')) || 0);
    const rawLimit = Number(url.searchParams.get('Limit'));
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : all.length;
    return { Items: all.slice(start, start + limit), TotalRecordCount: all.length };
}

function filteredItems(state, url) {
    const ids = url.searchParams.get('Ids')?.split(',').filter(Boolean);
    const parentId = url.searchParams.get('ParentId');
    const includeTypes = url.searchParams.get('IncludeItemTypes')?.split(',').filter(Boolean);
    const all = state.items.filter(item => {
        if (ids?.length && !ids.includes(item.Id)) return false;
        if (parentId && item.ParentId !== parentId) return false;
        if (includeTypes?.length && !includeTypes.includes(item.Type)) return false;
        return true;
    });
    return paginate(all, url);
}

function itemPath(pathname) {
    const match = /^\/Items\/([^/]+)$/.exec(pathname);
    return match ? decodePathSegment(match[1]) : null;
}

function playbackItemPath(pathname) {
    const match = /^\/Items\/([^/]+)\/PlaybackInfo$/.exec(pathname);
    return match ? decodePathSegment(match[1]) : null;
}

function userItemPath(pathname) {
    const match = /^\/Users\/([^/]+)\/Items\/([^/]+)$/.exec(pathname);
    if (!match) return null;
    const userId = decodePathSegment(match[1]);
    const itemId = decodePathSegment(match[2]);
    return userId && itemId ? { userId, itemId } : null;
}

function relatedItemsPath(pathname) {
    const match = /^\/Items\/([^/]+)\/(Similar|Collections)$/.exec(pathname);
    if (!match) return null;
    const itemId = decodePathSegment(match[1]);
    return itemId ? { itemId, relation: match[2] } : null;
}

function seriesSeasonsPath(pathname) {
    const match = /^\/Shows\/([^/]+)\/Seasons$/.exec(pathname);
    return match ? decodePathSegment(match[1]) : null;
}

function seriesEpisodesPath(pathname) {
    const match = /^\/Shows\/([^/]+)\/Episodes$/.exec(pathname);
    return match ? decodePathSegment(match[1]) : null;
}

function decodePathSegment(value) {
    try {
        return decodeURIComponent(value);
    } catch (_error) {
        return null;
    }
}

export function createFakeBackend() {
    let state = createFixtureState();
    let requests = [];
    let nextLiveStreamSequence = 1;
    const liveStreams = new Set();

    async function route(request, url, parsedBody) {
        const { pathname } = url;
        const isGet = request.method === 'GET';

        if (pathname === '/System/Info/Public' && isGet) return { response: jsonResponse(state.serverInfo) };
        if (pathname === '/Users/Public' && isGet) return { response: jsonResponse(state.publicUsers) };
        if (pathname === '/QuickConnect/Enabled' && isGet) return { response: jsonResponse(false) };
        if (pathname === '/sso/config' && isGet) return { response: jsonResponse({ Enabled: false, CodeExchange: false }) };

        if (pathname === '/Users/AuthenticateByName' && request.method === 'POST') {
            if (parsedBody.kind === 'malformed') return { response: errorResponse(400, 'Invalid JSON request body.') };
            if (parsedBody.kind === 'too-large') return { response: errorResponse(413, 'Request body is too large.') };
            const body = parsedBody.value;
            if (body?.Username !== FIXTURE_CREDENTIALS.username || body?.Pw !== FIXTURE_CREDENTIALS.password) {
                return { response: errorResponse(401, 'Invalid username or password.') };
            }
            return {
                response: jsonResponse({
                    AccessToken: FIXTURE_CREDENTIALS.accessToken,
                    User: state.user,
                    ServerId: FIXTURE_CREDENTIALS.serverId
                })
            };
        }

        const token = tokenFrom(request);
        if (token !== FIXTURE_CREDENTIALS.accessToken) return { response: errorResponse(401, 'Unauthorized.') };

        if (pathname === '/Users/Me' && isGet) return { response: jsonResponse(state.user) };
        if (pathname === '/UserViews' && isGet) {
            return { response: jsonResponse({ Items: state.views, TotalRecordCount: state.views.length }) };
        }
        if (pathname === '/UserItems/Resume' && isGet) {
            const mediaType = url.searchParams.get('MediaTypes') || 'Video';
            return { response: jsonResponse({ Items: mediaType === 'Video' ? state.resumeItems : [] }) };
        }
        if (pathname === '/Items/Latest' && isGet) {
            const parentId = url.searchParams.get('ParentId');
            const items = parentId ? state.latestItems.filter(item => item.ParentId === parentId) : state.latestItems;
            return { response: jsonResponse(items) };
        }
        if (pathname === '/Shows/NextUp' && isGet) return { response: jsonResponse({ Items: state.nextUpItems }) };
        const seasonsSeries = seriesSeasonsPath(pathname);
        if (seasonsSeries !== null && isGet) {
            return { response: jsonResponse(paginate(state.items.filter(item => item.Type === 'Season' && item.SeriesId === seasonsSeries), url)) };
        }
        const episodesSeries = seriesEpisodesPath(pathname);
        if (episodesSeries !== null && isGet) {
            const seasonId = url.searchParams.get('SeasonId');
            return { response: jsonResponse(paginate(state.items.filter(item => item.Type === 'Episode' && item.SeriesId === episodesSeries && (!seasonId || item.ParentId === seasonId)), url)) };
        }
        if (pathname === '/LiveTv/GuideInfo' && isGet) return { response: jsonResponse({}) };
        if (pathname === '/LiveTv/Channels' && isGet) {
            return { response: jsonResponse(paginate(state.items.filter(item => item.Type === 'TvChannel'), url)) };
        }
        if (pathname === '/LiveTv/Programs' && isGet) return { response: jsonResponse({ Items: [], TotalRecordCount: 0 }) };
        if (pathname === '/Items/Filters' && isGet) return { response: jsonResponse({ Tags: [], OfficialRatings: [] }) };
        if (pathname === '/Movies/Recommendations' && isGet) return { response: jsonResponse(state.recommendationGroups) };
        if (pathname === '/Pgsql/Taste/Users/e2e-user-id' && isGet) return { response: jsonResponse({ HasProfile: false, Genres: [], People: [] }) };
        if (pathname === '/Pgsql/Taste/Recommendations' && isGet) return { response: jsonResponse({ Items: [] }) };
        if (pathname === '/Localization/Cultures' && isGet) return { response: jsonResponse([]) };
        if (pathname === '/Sessions' && isGet) return { response: jsonResponse([]) };
        if (/^\/MediaSegments\/[^/]+$/.test(pathname) && isGet) return { response: jsonResponse({ Items: [] }) };
        if (pathname === '/Sessions/Playing' || pathname === '/Sessions/Playing/Progress' || pathname === '/Sessions/Playing/Stopped') {
            if (request.method !== 'POST') return { response: errorResponse(405, 'Method not allowed.') };
            if (parsedBody.kind === 'malformed') return { response: errorResponse(400, 'Invalid JSON request body.') };
            if (parsedBody.kind === 'too-large') return { response: errorResponse(413, 'Request body is too large.') };
            if (pathname === '/Sessions/Playing/Stopped' && typeof parsedBody.value?.LiveStreamId === 'string') {
                liveStreams.delete(parsedBody.value.LiveStreamId);
            }
            return { response: emptyResponse() };
        }
        if (pathname === '/Videos/ActiveEncodings' && request.method === 'DELETE') return { response: emptyResponse() };

        const playbackId = playbackItemPath(pathname);
        if (playbackId !== null) {
            if (request.method !== 'POST') return { response: errorResponse(405, 'Method not allowed.') };
            const item = state.items.find(entry => entry.Id === playbackId);
            if (!item) return { response: errorResponse(404, 'Item not found.') };
            if (parsedBody.kind === 'malformed') return { response: errorResponse(400, 'Invalid JSON request body.') };
            if (parsedBody.kind === 'too-large') return { response: errorResponse(413, 'Request body is too large.') };
            return { response: jsonResponse(item.Type === 'TvChannel' ? state.livePlaybackInfo : state.playbackInfo) };
        }

        if (pathname === '/LiveStreams/Open') {
            if (request.method !== 'POST') return { response: errorResponse(405, 'Method not allowed.') };
            if (parsedBody.kind === 'malformed') return { response: errorResponse(400, 'Invalid JSON request body.') };
            if (parsedBody.kind === 'too-large') return { response: errorResponse(413, 'Request body is too large.') };
            const sequence = nextLiveStreamSequence++;
            const liveStreamId = `e2e-live-stream-${sequence}`;
            liveStreams.add(liveStreamId);
            return {
                response: jsonResponse({
                    MediaSource: {
                        Id: `e2e-live-media-source-${sequence}`,
                        Name: 'E2E Live WebM',
                        Container: 'webm',
                        LiveStreamId: liveStreamId,
                        IsInfiniteStream: true,
                        SupportsDirectPlay: true,
                        SupportsDirectStream: true,
                        SupportsTranscoding: true,
                        Bitrate: 500_000,
                        MediaStreams: []
                    }
                })
            };
        }

        if (pathname === '/LiveStreams/Close') {
            if (request.method !== 'POST') return { response: errorResponse(405, 'Method not allowed.') };
            const liveStreamId = url.searchParams.get('liveStreamId');
            if (!liveStreamId || !liveStreams.delete(liveStreamId)) return { response: errorResponse(404, 'Live stream not found.') };
            return { response: emptyResponse() };
        }

        const userItem = userItemPath(pathname);
        if (userItem && isGet) {
            const item = userItem.userId === state.user.Id ? state.items.find(entry => entry.Id === userItem.itemId) : undefined;
            return { response: item ? jsonResponse(item) : errorResponse(404, 'Item not found.') };
        }

        const relatedItems = relatedItemsPath(pathname);
        if (relatedItems && isGet) {
            if (!state.items.some(item => item.Id === relatedItems.itemId)) return { response: errorResponse(404, 'Item not found.') };
            return { response: jsonResponse({ Items: [], TotalRecordCount: 0 }) };
        }

        if (pathname === '/Items' && isGet) return { response: jsonResponse(filteredItems(state, url)) };

        const id = itemPath(pathname);
        if (id !== null && isGet) {
            const item = state.items.find(entry => entry.Id === id);
            return { response: item ? jsonResponse(item) : errorResponse(404, 'Item not found.') };
        }

        return { response: errorResponse(404, 'Endpoint not found.'), unexpected: true };
    }

    return {
        async handle(request) {
            const url = new URL(request.url);
            const parsedBody = await parseRequestBody(request);
            const requestDetails = safeRequestDetails(request, url, parsedBody);
            let result;
            try {
                result = await route(request, url, parsedBody);
            } catch (error) {
                const errorType = error instanceof Error ? error.name : 'UnknownError';
                process.stderr.write(`${JSON.stringify({ event: 'fake_backend_route_error', method: request.method, path: url.pathname, errorType })}\n`);
                result = { response: errorResponse(500, 'Fake server request failed.') };
            }
            requests.push({ ...requestDetails, status: result.response.status, unexpected: result.unexpected === true });
            return result.response;
        },
        reset() {
            state = createFixtureState();
            requests = [];
            nextLiveStreamSequence = 1;
            liveStreams.clear();
        },
        getRequests() {
            return structuredClone(requests);
        }
    };
}
