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
        var path = string.Format(
            CultureInfo.InvariantCulture,
            "search?query={0}&page={1}",
            Uri.EscapeDataString(query),
            page);

        using var response = await SendAsync(HttpMethod.Get, path, null, cancellationToken).ConfigureAwait(false);
        var payload = await response.Content.ReadFromJsonAsync<SeerrSearchDto>(JsonOptions, cancellationToken).ConfigureAwait(false);
        return MapSearchResults(payload?.Results, fallbackMediaType: null);
    }

    /// <summary>
    /// Discovers requestable titles from Seerr (unrestricted path).
    /// </summary>
    /// <param name="mediaType"><c>movie</c> or <c>tv</c>.</param>
    /// <param name="genreIds">TMDB genre ids (max 5).</param>
    /// <param name="voteAverageGte">Optional vote-average floor.</param>
    /// <param name="limit">Max requestable items to return.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Requestable discover items.</returns>
    public async Task<IReadOnlyList<SeerrSearchItem>> DiscoverAsync(
        string mediaType,
        IReadOnlyList<int> genreIds,
        float? voteAverageGte,
        int limit,
        CancellationToken cancellationToken)
    {
        limit = Math.Clamp(limit <= 0 ? 16 : limit, 1, 24);
        var items = new List<SeerrSearchItem>(limit);

        for (var page = 1; page <= 2 && items.Count < limit; page++)
        {
            var candidates = await DiscoverPageAsync(
                    mediaType,
                    genreIds,
                    voteAverageGte,
                    page,
                    cancellationToken)
                .ConfigureAwait(false);
            if (candidates.Count == 0)
            {
                break;
            }

            foreach (var candidate in candidates)
            {
                if (!candidate.Item.CanRequest)
                {
                    continue;
                }

                items.Add(candidate.Item);
                if (items.Count >= limit)
                {
                    break;
                }
            }
        }

        return items;
    }

    /// <summary>
    /// Discovers a single Seerr results page without applying the response limit.
    /// </summary>
    /// <param name="mediaType"><c>movie</c> or <c>tv</c>.</param>
    /// <param name="genreIds">TMDB genre ids (max 5).</param>
    /// <param name="voteAverageGte">Optional vote-average floor.</param>
    /// <param name="page">1-based page number.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Discover candidates including adult flags.</returns>
    public async Task<IReadOnlyList<SeerrSearchCandidate>> DiscoverPageAsync(
        string mediaType,
        IReadOnlyList<int> genreIds,
        float? voteAverageGte,
        int page,
        CancellationToken cancellationToken)
    {
        var normalizedType = NormalizeDiscoverMediaType(mediaType)
            ?? throw new ArgumentException("mediaType must be 'movie' or 'tv'.", nameof(mediaType));

        var path = BuildDiscoverPath(normalizedType, genreIds, voteAverageGte, page);
        using var response = await SendAsync(HttpMethod.Get, path, null, cancellationToken).ConfigureAwait(false);
        var payload = await response.Content.ReadFromJsonAsync<SeerrSearchDto>(JsonOptions, cancellationToken).ConfigureAwait(false);
        return MapSearchResults(payload?.Results, fallbackMediaType: normalizedType);
    }

    /// <summary>
    /// Builds the relative Seerr discover path (for unit tests).
    /// </summary>
    /// <param name="mediaType"><c>movie</c> or <c>tv</c>.</param>
    /// <param name="genreIds">TMDB genre ids.</param>
    /// <param name="voteAverageGte">Optional vote-average floor.</param>
    /// <param name="page">1-based page.</param>
    /// <returns>Relative API path.</returns>
    internal static string BuildDiscoverPath(
        string mediaType,
        IReadOnlyList<int>? genreIds,
        float? voteAverageGte,
        int page)
    {
        var segment = string.Equals(mediaType, "tv", StringComparison.OrdinalIgnoreCase)
            ? "tv"
            : "movies";
        page = Math.Max(1, page);

        var path = string.Create(
            CultureInfo.InvariantCulture,
            $"discover/{segment}?page={page}&sortBy=popularity.desc");

        var genres = NormalizeGenreIds(genreIds);
        if (genres.Count > 0)
        {
            var genreValue = string.Join(',', genres.Select(id => id.ToString(CultureInfo.InvariantCulture)));
            path += "&genre=" + Uri.EscapeDataString(genreValue);
        }

        if (voteAverageGte is > 0 and <= 10)
        {
            path += string.Create(
                CultureInfo.InvariantCulture,
                $"&voteAverageGte={voteAverageGte.Value}");
        }

        return path;
    }

    /// <summary>
    /// Parses and clamps comma-separated TMDB genre ids.
    /// </summary>
    /// <param name="genreIds">Raw query value.</param>
    /// <returns>Up to 5 positive genre ids.</returns>
    internal static IReadOnlyList<int> ParseGenreIds(string? genreIds)
    {
        if (string.IsNullOrWhiteSpace(genreIds))
        {
            return [];
        }

        var parsed = new List<int>(5);
        foreach (var part in genreIds.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (!int.TryParse(part, NumberStyles.Integer, CultureInfo.InvariantCulture, out var id) || id <= 0)
            {
                continue;
            }

            if (!parsed.Contains(id))
            {
                parsed.Add(id);
            }

            if (parsed.Count >= 5)
            {
                break;
            }
        }

        return parsed;
    }

    /// <summary>
    /// Normalizes discover media type to <c>movie</c> or <c>tv</c>.
    /// </summary>
    /// <param name="mediaType">Caller media type.</param>
    /// <returns>Normalized type, or null when invalid.</returns>
    internal static string? NormalizeDiscoverMediaType(string? mediaType)
    {
        if (string.Equals(mediaType, "movie", StringComparison.OrdinalIgnoreCase))
        {
            return "movie";
        }

        if (string.Equals(mediaType, "tv", StringComparison.OrdinalIgnoreCase))
        {
            return "tv";
        }

        return null;
    }

    private static List<int> NormalizeGenreIds(IReadOnlyList<int>? genreIds)
    {
        if (genreIds is null || genreIds.Count == 0)
        {
            return [];
        }

        var normalized = new List<int>(Math.Min(5, genreIds.Count));
        foreach (var id in genreIds)
        {
            if (id <= 0 || normalized.Contains(id))
            {
                continue;
            }

            normalized.Add(id);
            if (normalized.Count >= 5)
            {
                break;
            }
        }

        return normalized;
    }

    private static List<SeerrSearchCandidate> MapSearchResults(
        List<SeerrSearchResultDto>? results,
        string? fallbackMediaType)
    {
        if (results is null || results.Count == 0)
        {
            return [];
        }

        var config = Plugin.Instance!.Configuration;
        var items = new List<SeerrSearchCandidate>(results.Count);
        foreach (var result in results)
        {
            var mediaType = IsMovieOrTv(result.MediaType)
                ? result.MediaType!
                : fallbackMediaType;
            if (!IsMovieOrTv(mediaType))
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
                    MediaType = mediaType!,
                    MediaId = result.Id,
                    Title = title,
                    Year = year,
                    Overview = result.Overview,
                    PosterUrl = BuildPosterUrl(result.PosterPath),
                    Status = status,
                    CanRequest = IsRequestable(status)
                }
            });
        }

        return items;
    }

    /// <summary>
    /// Returns whether a media status is requestable.
    /// </summary>
    /// <param name="status">Normalized Seerr status.</param>
    /// <returns><c>true</c> when the title can be requested.</returns>
    internal static bool IsRequestable(SeerrMediaStatus status)
        => status is not SeerrMediaStatus.Available
            and not SeerrMediaStatus.Pending
            and not SeerrMediaStatus.Processing
            and not SeerrMediaStatus.Blocklisted
            and not SeerrMediaStatus.Deleted;

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
                var certification = country.ReleaseDates
                    .Select(e => e.Certification?.Trim())
                    .FirstOrDefault(c => !string.IsNullOrWhiteSpace(c));
                if (certification is not null)
                {
                    return certification;
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

        return OrderCountries(results, c => c.Iso31661)
            .Select(e => e.Rating?.Trim())
            .FirstOrDefault(r => !string.IsNullOrWhiteSpace(r));
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
