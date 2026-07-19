using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.Seerr.Models;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Seerr.Services;

/// <summary>
/// HTTP client for the Seerr REST API.
/// </summary>
public sealed class SeerrClient
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private static readonly TimeSpan RatingCacheDuration = TimeSpan.FromMinutes(30);
    private static readonly TimeSpan RatingFailureCacheDuration = TimeSpan.FromMinutes(1);

    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IMemoryCache _cache;
    private readonly ILogger<SeerrClient> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="SeerrClient"/> class.
    /// </summary>
    /// <param name="httpClientFactory">HTTP client factory.</param>
    /// <param name="cache">Memory cache for rating lookups.</param>
    /// <param name="logger">Logger.</param>
    public SeerrClient(IHttpClientFactory httpClientFactory, IMemoryCache cache, ILogger<SeerrClient> logger)
    {
        _httpClientFactory = httpClientFactory;
        _cache = cache;
        _logger = logger;
    }

    /// <summary>
    /// Returns whether the plugin is enabled and has URL + API key configured.
    /// </summary>
    /// <returns>True when the gateway can be used.</returns>
    public static bool IsConfigured()
    {
        var config = Plugin.Instance?.Configuration;
        return config is { Enabled: true }
            && !string.IsNullOrWhiteSpace(config.SeerrUrl)
            && !string.IsNullOrWhiteSpace(config.ApiKey);
    }

    /// <summary>
    /// Calls <c>GET /api/v1/status</c>.
    /// </summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Status payload including version.</returns>
    public async Task<SeerrStatusDto> GetStatusAsync(CancellationToken cancellationToken)
    {
        using var response = await SendAsync(HttpMethod.Get, "status", null, cancellationToken).ConfigureAwait(false);
        var payload = await response.Content.ReadFromJsonAsync<SeerrStatusDto>(JsonOptions, cancellationToken).ConfigureAwait(false);
        return payload ?? new SeerrStatusDto();
    }

    /// <summary>
    /// Searches Seerr and maps results to gateway DTOs (unrestricted path).
    /// </summary>
    /// <param name="query">Search term.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Requestable search items.</returns>
    public async Task<IReadOnlyList<SeerrSearchItem>> SearchAsync(string query, CancellationToken cancellationToken)
    {
        var config = Plugin.Instance!.Configuration;
        var limit = Math.Clamp(config.SearchLimit, 1, 50);
        var candidates = await SearchPageAsync(query, page: 1, cancellationToken).ConfigureAwait(false);
        return candidates.Take(limit).Select(c => c.Item).ToList();
    }

    /// <summary>
    /// Searches a single Seerr results page without applying <c>SearchLimit</c>.
    /// </summary>
    /// <param name="query">Search term.</param>
    /// <param name="page">1-based page number.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Search candidates including adult flags.</returns>
    public async Task<IReadOnlyList<SeerrSearchCandidate>> SearchPageAsync(
        string query,
        int page,
        CancellationToken cancellationToken)
    {
        var config = Plugin.Instance!.Configuration;
        var path = string.Format(
            CultureInfo.InvariantCulture,
            "search?query={0}&page={1}",
            Uri.EscapeDataString(query),
            page);

        using var response = await SendAsync(HttpMethod.Get, path, null, cancellationToken).ConfigureAwait(false);
        var payload = await response.Content.ReadFromJsonAsync<SeerrSearchDto>(JsonOptions, cancellationToken).ConfigureAwait(false);
        if (payload?.Results is null || payload.Results.Count == 0)
        {
            return [];
        }

        var items = new List<SeerrSearchCandidate>(payload.Results.Count);
        foreach (var result in payload.Results)
        {
            if (!IsMovieOrTv(result.MediaType))
            {
                continue;
            }

            var status = MapMediaStatus(result.MediaInfo?.Status);
            if (config.HideAvailable && status == SeerrMediaStatus.Available)
            {
                continue;
            }

            var title = !string.IsNullOrWhiteSpace(result.Title)
                ? result.Title!
                : result.Name ?? "Untitled";
            var date = result.ReleaseDate ?? result.FirstAirDate;
            int? year = null;
            if (!string.IsNullOrWhiteSpace(date) && date.Length >= 4 && int.TryParse(date.AsSpan(0, 4), out var parsedYear))
            {
                year = parsedYear;
            }

            items.Add(new SeerrSearchCandidate
            {
                Adult = result.Adult,
                Item = new SeerrSearchItem
                {
                    MediaType = result.MediaType!,
                    MediaId = result.Id,
                    Title = title,
                    Year = year,
                    Overview = result.Overview,
                    PosterUrl = BuildPosterUrl(result.PosterPath),
                    Status = status,
                    CanRequest = status is not SeerrMediaStatus.Available
                        and not SeerrMediaStatus.Pending
                        and not SeerrMediaStatus.Processing
                        and not SeerrMediaStatus.Blocklisted
                        and not SeerrMediaStatus.Deleted
                }
            });
        }

        return items;
    }

    /// <summary>
    /// Loads adult/certification metadata for a title (cached).
    /// </summary>
    /// <param name="mediaType"><c>movie</c> or <c>tv</c>.</param>
    /// <param name="mediaId">TMDB id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Resolved rating metadata.</returns>
    public async Task<SeerrMediaRating> GetMediaRatingAsync(
        string mediaType,
        int mediaId,
        CancellationToken cancellationToken)
    {
        var cacheKey = string.Create(
            CultureInfo.InvariantCulture,
            $"seerr-rating:{mediaType}:{mediaId}");

        if (_cache.TryGetValue(cacheKey, out SeerrMediaRating? cached) && cached is not null)
        {
            return cached;
        }

        try
        {
            SeerrMediaRating rating;
            if (string.Equals(mediaType, "movie", StringComparison.OrdinalIgnoreCase))
            {
                rating = await FetchMovieRatingAsync(mediaId, cancellationToken).ConfigureAwait(false);
            }
            else if (string.Equals(mediaType, "tv", StringComparison.OrdinalIgnoreCase))
            {
                rating = await FetchTvRatingAsync(mediaId, cancellationToken).ConfigureAwait(false);
            }
            else
            {
                rating = SeerrMediaRating.Failed;
            }

            _cache.Set(
                cacheKey,
                rating,
                rating.LookupFailed ? RatingFailureCacheDuration : RatingCacheDuration);
            return rating;
        }
        catch (SeerrApiException ex)
        {
            _logger.LogWarning(
                ex,
                "Failed to load Seerr rating for {MediaType}/{MediaId}",
                SanitizeForLog(mediaType),
                mediaId);
            var failed = SeerrMediaRating.Failed;
            _cache.Set(cacheKey, failed, RatingFailureCacheDuration);
            return failed;
        }
    }

    /// <summary>
    /// Creates a media request on behalf of a Seerr user.
    /// </summary>
    /// <param name="mediaType">movie or tv.</param>
    /// <param name="mediaId">TMDB id.</param>
    /// <param name="seerrUserId">Seerr user id to attribute the request to.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Created request id when present.</returns>
    public async Task<int?> CreateRequestAsync(
        string mediaType,
        int mediaId,
        int seerrUserId,
        CancellationToken cancellationToken)
    {
        var body = new Dictionary<string, object?>
        {
            ["mediaType"] = mediaType,
            ["mediaId"] = mediaId,
            ["userId"] = seerrUserId
        };

        if (string.Equals(mediaType, "tv", StringComparison.OrdinalIgnoreCase))
        {
            body["seasons"] = "all";
        }

        using var response = await SendAsync(HttpMethod.Post, "request", body, cancellationToken).ConfigureAwait(false);
        var payload = await response.Content.ReadFromJsonAsync<SeerrMediaRequestDto>(JsonOptions, cancellationToken).ConfigureAwait(false);
        return payload?.Id;
    }

    /// <summary>
    /// Lists Seerr users matching a query string.
    /// </summary>
    /// <param name="query">Username search term.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Matching users.</returns>
    public async Task<IReadOnlyList<SeerrUserDto>> FindUsersAsync(string query, CancellationToken cancellationToken)
    {
        // Seerr rejects an empty q= value; omit the parameter when listing without a filter.
        var path = string.IsNullOrWhiteSpace(query)
            ? "user?take=20&skip=0"
            : string.Format(
                CultureInfo.InvariantCulture,
                "user?take=20&skip=0&q={0}",
                Uri.EscapeDataString(query));

        using var response = await SendAsync(HttpMethod.Get, path, null, cancellationToken).ConfigureAwait(false);
        var payload = await response.Content.ReadFromJsonAsync<SeerrUserResultsDto>(JsonOptions, cancellationToken).ConfigureAwait(false);
        return payload?.Results ?? [];
    }

    private async Task<SeerrMediaRating> FetchMovieRatingAsync(int mediaId, CancellationToken cancellationToken)
    {
        var path = string.Create(CultureInfo.InvariantCulture, $"movie/{mediaId}");
        using var response = await SendAsync(HttpMethod.Get, path, null, cancellationToken).ConfigureAwait(false);
        var details = await response.Content
            .ReadFromJsonAsync<SeerrMovieDetailsDto>(JsonOptions, cancellationToken)
            .ConfigureAwait(false);
        if (details is null)
        {
            return SeerrMediaRating.Failed;
        }

        return new SeerrMediaRating
        {
            Adult = details.Adult,
            Certification = ExtractMovieCertification(details)
        };
    }

    private async Task<SeerrMediaRating> FetchTvRatingAsync(int mediaId, CancellationToken cancellationToken)
    {
        var path = string.Create(CultureInfo.InvariantCulture, $"tv/{mediaId}");
        using var response = await SendAsync(HttpMethod.Get, path, null, cancellationToken).ConfigureAwait(false);
        var details = await response.Content
            .ReadFromJsonAsync<SeerrTvDetailsDto>(JsonOptions, cancellationToken)
            .ConfigureAwait(false);
        if (details is null)
        {
            return SeerrMediaRating.Failed;
        }

        return new SeerrMediaRating
        {
            Adult = details.Adult,
            Certification = ExtractTvCertification(details)
        };
    }

    /// <summary>
    /// Picks a preferred movie certification (US first) from Seerr movie details.
    /// </summary>
    /// <param name="details">Deserialized movie details.</param>
    /// <returns>Certification string or null.</returns>
    internal static string? ExtractMovieCertification(SeerrMovieDetailsDto details)
    {
        var results = details.Releases?.Results;
        if (results is null || results.Count == 0)
        {
            return null;
        }

        foreach (var country in OrderCountries(results, c => c.Iso31661))
        {
            if (country.ReleaseDates is not null)
            {
                foreach (var entry in country.ReleaseDates)
                {
                    if (!string.IsNullOrWhiteSpace(entry.Certification))
                    {
                        return entry.Certification.Trim();
                    }
                }
            }

            if (!string.IsNullOrWhiteSpace(country.Rating))
            {
                return country.Rating.Trim();
            }
        }

        return null;
    }

    /// <summary>
    /// Picks a preferred TV content rating (US first) from Seerr TV details.
    /// </summary>
    /// <param name="details">Deserialized TV details.</param>
    /// <returns>Rating string or null.</returns>
    internal static string? ExtractTvCertification(SeerrTvDetailsDto details)
    {
        var results = details.ContentRatings?.Results;
        if (results is null || results.Count == 0)
        {
            return null;
        }

        foreach (var entry in OrderCountries(results, c => c.Iso31661))
        {
            if (!string.IsNullOrWhiteSpace(entry.Rating))
            {
                return entry.Rating.Trim();
            }
        }

        return null;
    }

    private static IEnumerable<T> OrderCountries<T>(IEnumerable<T> countries, Func<T, string?> isoSelector)
        => countries.OrderBy(c =>
            string.Equals(isoSelector(c), "US", StringComparison.OrdinalIgnoreCase) ? 0 : 1);

    private async Task<HttpResponseMessage> SendAsync(
        HttpMethod method,
        string relativePath,
        object? body,
        CancellationToken cancellationToken)
    {
        var config = Plugin.Instance?.Configuration
            ?? throw new InvalidOperationException("Seerr plugin is not loaded.");

        if (string.IsNullOrWhiteSpace(config.SeerrUrl) || string.IsNullOrWhiteSpace(config.ApiKey))
        {
            throw new SeerrApiException(400, "Seerr URL and API key must be configured.");
        }

        var baseUri = config.SeerrUrl.TrimEnd('/') + "/api/v1/";
        var requestUri = new Uri(new Uri(baseUri, UriKind.Absolute), relativePath);

        using var request = new HttpRequestMessage(method, requestUri);
        request.Headers.TryAddWithoutValidation("X-Api-Key", config.ApiKey);
        if (body is not null)
        {
            request.Content = JsonContent.Create(body, options: JsonOptions);
        }

        var client = _httpClientFactory.CreateClient(nameof(SeerrClient));
        HttpResponseMessage response;
        try
        {
            response = await client.SendAsync(request, cancellationToken).ConfigureAwait(false);
        }
        catch (HttpRequestException ex)
        {
            _logger.LogWarning(ex, "Failed to reach Seerr at {SeerrUrl}", config.SeerrUrl);
            throw new SeerrApiException(502, "Unable to reach Seerr. Check the configured URL.");
        }
        catch (TaskCanceledException ex) when (!cancellationToken.IsCancellationRequested)
        {
            _logger.LogWarning(ex, "Seerr request timed out for {SeerrUrl}", config.SeerrUrl);
            throw new SeerrApiException(504, "Seerr request timed out.");
        }

        if (response.IsSuccessStatusCode)
        {
            return response;
        }

        var errorBody = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
        var message = ExtractErrorMessage(errorBody) ?? $"Seerr returned {(int)response.StatusCode}.";
        _logger.LogWarning(
            "Seerr API error {StatusCode} for {Path}: {Message}",
            (int)response.StatusCode,
            SanitizeForLog(relativePath),
            SanitizeForLog(message));
        response.Dispose();
        throw new SeerrApiException((int)response.StatusCode, message);
    }

    /// <summary>
    /// Strips CR/LF and other control characters so log sinks cannot be forged.
    /// </summary>
    private static string SanitizeForLog(string value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return value;
        }

        var chars = value.ToCharArray();
        for (var i = 0; i < chars.Length; i++)
        {
            if (char.IsControl(chars[i]))
            {
                chars[i] = ' ';
            }
        }

        return new string(chars).Trim();
    }

    private static string? ExtractErrorMessage(string errorBody)
    {
        if (string.IsNullOrWhiteSpace(errorBody))
        {
            return null;
        }

        try
        {
            using var doc = JsonDocument.Parse(errorBody);
            if (doc.RootElement.TryGetProperty("message", out var messageProp)
                && messageProp.ValueKind == JsonValueKind.String)
            {
                return messageProp.GetString();
            }

            if (doc.RootElement.TryGetProperty("error", out var errorProp)
                && errorProp.ValueKind == JsonValueKind.String)
            {
                return errorProp.GetString();
            }
        }
        catch (JsonException)
        {
            // Fall through to raw body truncation.
        }

        return errorBody.Length > 300 ? errorBody[..300] : errorBody;
    }

    private static bool IsMovieOrTv(string? mediaType)
        => string.Equals(mediaType, "movie", StringComparison.OrdinalIgnoreCase)
           || string.Equals(mediaType, "tv", StringComparison.OrdinalIgnoreCase);

    private static SeerrMediaStatus MapMediaStatus(int? status) => status switch
    {
        // Seerr MediaStatus: 1 UNKNOWN, 2 PENDING, 3 PROCESSING, 4 PARTIALLY_AVAILABLE,
        // 5 AVAILABLE, 6 BLOCKLISTED, 7 DELETED
        2 => SeerrMediaStatus.Pending,
        3 => SeerrMediaStatus.Processing,
        4 => SeerrMediaStatus.PartiallyAvailable,
        5 => SeerrMediaStatus.Available,
        6 => SeerrMediaStatus.Blocklisted,
        7 => SeerrMediaStatus.Deleted,
        _ => SeerrMediaStatus.Unknown
    };

    private static string? BuildPosterUrl(string? posterPath)
    {
        if (string.IsNullOrWhiteSpace(posterPath))
        {
            return null;
        }

        if (posterPath.StartsWith("http", StringComparison.OrdinalIgnoreCase))
        {
            return posterPath;
        }

        return "https://image.tmdb.org/t/p/w185" + posterPath;
    }
}
