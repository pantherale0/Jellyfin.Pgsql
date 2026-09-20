using System;
using System.Collections.Concurrent;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Microsoft.Net.Http.Headers;

namespace Jellyfin.Plugin.Pgsql.Trailers;

/// <summary>
/// Resolves and relays YouTube trailer media without buffering complete files.
/// </summary>
public sealed class YtDlpTrailerService
{
    private const int MaxCacheEntries = 512;
    private static readonly TimeSpan CacheTtl = TimeSpan.FromMinutes(5);
    private static readonly SemaphoreSlim ResolutionSlots = new(4, 4);
    private readonly ConcurrentDictionary<string, CacheEntry> _cache = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, Lazy<Task<YtDlpResolution>>> _pending = new(StringComparer.Ordinal);
    private readonly IYtDlpProcessRunner _runner;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ITrailerRemuxer _remuxer;
    private readonly ILogger<YtDlpTrailerService> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="YtDlpTrailerService"/> class.
    /// </summary>
    /// <param name="runner">The yt-dlp process runner.</param>
    /// <param name="httpClientFactory">HTTP client factory.</param>
    /// <param name="remuxer">Adaptive-track remuxer.</param>
    /// <param name="logger">Logger.</param>
    public YtDlpTrailerService(
        IYtDlpProcessRunner runner,
        IHttpClientFactory httpClientFactory,
        ITrailerRemuxer remuxer,
        ILogger<YtDlpTrailerService> logger)
    {
        _runner = runner;
        _httpClientFactory = httpClientFactory;
        _remuxer = remuxer;
        _logger = logger;
    }

    /// <summary>
    /// Relays a resolved trailer into the current HTTP response.
    /// </summary>
    /// <param name="videoId">The validated YouTube video identifier.</param>
    /// <param name="context">Current HTTP context.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task representing the relay operation.</returns>
    public async Task RelayAsync(string videoId, HttpContext context, CancellationToken cancellationToken)
    {
        var resolution = await ResolveAsync(videoId, cancellationToken).ConfigureAwait(false);
        if (resolution.RequiresRemux)
        {
            await _remuxer.RelayAsync(resolution, context, cancellationToken).ConfigureAwait(false);
            return;
        }

        var response = await SendAsync(resolution, context, cancellationToken).ConfigureAwait(false);
        if (response.StatusCode is HttpStatusCode.Forbidden or HttpStatusCode.Gone)
        {
            response.Dispose();
            _cache.TryRemove(videoId, out _);
            resolution = await ResolveAsync(videoId, cancellationToken).ConfigureAwait(false);
            response = await SendAsync(resolution, context, cancellationToken).ConfigureAwait(false);
        }

        using (response)
        {
            if (!response.IsSuccessStatusCode && response.StatusCode != HttpStatusCode.RequestedRangeNotSatisfiable)
            {
                _logger.LogWarning("Trailer upstream returned HTTP {StatusCode} for video {VideoId}", (int)response.StatusCode, videoId);
                context.Response.StatusCode = StatusCodes.Status502BadGateway;
                return;
            }

            context.Response.StatusCode = (int)response.StatusCode;
            CopyHeader(response, context, HeaderNames.AcceptRanges);
            CopyHeader(response, context, HeaderNames.ContentRange);
            CopyHeader(response, context, HeaderNames.CacheControl);
            CopyHeader(response, context, HeaderNames.ETag);
            CopyHeader(response, context, HeaderNames.LastModified);
            if (response.Content.Headers.ContentLength is long contentLength)
            {
                context.Response.ContentLength = contentLength;
            }

            context.Response.ContentType = response.Content.Headers.ContentType?.ToString() ?? "video/mp4";
            await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
            await stream.CopyToAsync(context.Response.Body, cancellationToken).ConfigureAwait(false);
        }
    }

    private async Task<YtDlpResolution> ResolveAsync(string videoId, CancellationToken cancellationToken)
    {
        if (_cache.TryGetValue(videoId, out var cached) && cached.ExpiresAt > DateTimeOffset.UtcNow)
        {
            return cached.Resolution;
        }

        var lazy = _pending.GetOrAdd(videoId, id => new Lazy<Task<YtDlpResolution>>(
            () => ResolveUncachedAsync(id, CancellationToken.None),
            LazyThreadSafetyMode.ExecutionAndPublication));
        var task = lazy.Value;
        try
        {
            return await task.WaitAsync(cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            if (task.IsCompleted)
            {
                _pending.TryRemove(videoId, out _);
            }
        }
    }

    private async Task<YtDlpResolution> ResolveUncachedAsync(string videoId, CancellationToken cancellationToken)
    {
        await ResolutionSlots.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var resolution = await _runner.ResolveAsync(YtDlpOptions.Current.ExecutablePath, videoId, cancellationToken).ConfigureAwait(false);
            _cache[videoId] = new CacheEntry(resolution, DateTimeOffset.UtcNow.Add(CacheTtl));
            TrimCache();
            return resolution;
        }
        finally
        {
            ResolutionSlots.Release();
        }
    }

    private void TrimCache()
    {
        if (_cache.Count <= MaxCacheEntries)
        {
            return;
        }

        var now = DateTimeOffset.UtcNow;
        foreach (var entry in _cache)
        {
            if (entry.Value.ExpiresAt <= now)
            {
                _cache.TryRemove(entry.Key, out _);
            }
        }

        foreach (var entry in _cache.OrderBy(pair => pair.Value.ExpiresAt).Take(Math.Max(0, _cache.Count - MaxCacheEntries)))
        {
            _cache.TryRemove(entry.Key, out _);
        }
    }

    private async Task<HttpResponseMessage> SendAsync(YtDlpResolution resolution, HttpContext context, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, resolution.Url);
        foreach (var header in resolution.Headers)
        {
            request.Headers.TryAddWithoutValidation(header.Key, header.Value);
        }

        if (context.Request.Headers.TryGetValue(HeaderNames.Range, out var range))
        {
            request.Headers.TryAddWithoutValidation(HeaderNames.Range, range.ToArray());
        }

        if (context.Request.Headers.TryGetValue(HeaderNames.IfRange, out var ifRange))
        {
            request.Headers.TryAddWithoutValidation(HeaderNames.IfRange, ifRange.ToArray());
        }

        return await _httpClientFactory.CreateClient().SendAsync(
            request,
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken).ConfigureAwait(false);
    }

    private static void CopyHeader(HttpResponseMessage source, HttpContext destination, string name)
    {
        if (source.Headers.TryGetValues(name, out var values)
            || source.Content.Headers.TryGetValues(name, out values))
        {
            destination.Response.Headers[name] = new Microsoft.Extensions.Primitives.StringValues(values.ToArray());
        }
    }

    private sealed record CacheEntry(YtDlpResolution Resolution, DateTimeOffset ExpiresAt);
}
