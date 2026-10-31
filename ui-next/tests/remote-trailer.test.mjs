import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { extname } from 'node:path';
import { test } from 'node:test';

registerHooks({
    resolve(specifier, context, nextResolve) {
        return nextResolve(specifier.startsWith('.') && !extname(specifier) ? `${specifier}.ts` : specifier, context);
    }
});

const { youtubeVideoId, firstYouTubeTrailer } = await import('../src/remote-trailer.ts');
const videoId = 'dQw4w9WgXcQ';

test('YouTube trailer URLs support provider and sharing formats', () => {
    for (const url of [
        `https://www.youtube.com/watch?v=${videoId}&feature=share`,
        `https://youtube.com/watch?v=${videoId}`,
        `https://m.youtube.com/watch?v=${videoId}`,
        `https://youtu.be/${videoId}?t=12`,
        `https://www.youtube.com/embed/${videoId}`,
        `https://www.youtube.com/shorts/${videoId}`,
        `https://www.youtube-nocookie.com/embed/${videoId}`
    ]) assert.equal(youtubeVideoId(url), videoId, url);
});

test('trailer parsing rejects lookalike hosts, non-web URLs and invalid video IDs', () => {
    for (const url of [
        undefined, null, 123, {}, '', videoId,
        `https://youtube.com.evil.test/watch?v=${videoId}`,
        `https://notyoutube.com/watch?v=${videoId}`,
        `https://youtube.com@evil.test/watch?v=${videoId}`,
        `https://user@youtube.com/watch?v=${videoId}`,
        `ftp://youtube.com/watch?v=${videoId}`,
        `javascript:alert('${videoId}')`,
        `https://youtu.be/${videoId}/other`,
        'https://youtube.com/watch?v=too-short',
        'https://youtube.com/watch?v=abcdefghijkl',
        'https://youtube.com/watch?v=abc!efghijk',
        'https://youtube.com/playlist?list=123'
    ]) assert.equal(youtubeVideoId(url), null, String(url));
});

test('first supported metadata trailer wins without a chooser', () => {
    assert.deepEqual(firstYouTubeTrailer([
        null, { Url: 'https://vimeo.com/123' }, { Url: `https://youtu.be/${videoId}` },
        { Url: 'https://youtube.com/watch?v=abcdefghijk' }
    ]), { videoId });
    for (const value of [ undefined, null, {}, [], [ { Url: 123 }, { Name: 'No URL' } ] ]) {
        assert.equal(firstYouTubeTrailer(value), null);
    }
});
