using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.Seerr.Models;
using MediaBrowser.Model.Globalization;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Seerr.Services;

/// <summary>
/// Applies Jellyfin parental-control policy to Seerr search and request flows.
/// </summary>
public sealed class SeerrParentalFilter
{
    private const int MaxBackfillPages = 3;

    private readonly SeerrClient _client;
    private readonly ILocalizationManager _localization;
    private readonly ILogger<SeerrParentalFilter> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="SeerrParentalFilter"/> class.
    /// </summary>
    /// <param name="client">Seerr HTTP client.</param>
    /// <param name="localization">Localization manager for rating scores.</param>
    /// <param name="logger">Logger.</param>
    public SeerrParentalFilter(
        SeerrClient client,
        ILocalizationManager localization,
        ILogger<SeerrParentalFilter> logger)
    {
        _client = client;
        _localization = localization;
        _logger = logger;
    }

    /// <summary>
    /// Returns whether the user has a max parental rating configured.
    /// </summary>
    /// <param name="user">Jellyfin user.</param>
    /// <returns><c>true</c> when rating filtering must run.</returns>
    public static bool NeedsFiltering(User user)
        => user.MaxParentalRatingScore.HasValue;

    /// <summary>
    /// Evaluates whether a title is allowed for the user given resolved rating metadata.
    /// </summary>
    /// <param name="user">Jellyfin user.</param>
    /// <param name="mediaType"><c>movie</c> or <c>tv</c>.</param>
    /// <param name="rating">Resolved rating metadata.</param>
    /// <param name="localization">Localization manager.</param>
    /// <returns><c>true</c> when the title may be shown/requested.</returns>
    public static bool IsContentAllowed(
        User user,
        string mediaType,
        SeerrMediaRating rating,
        ILocalizationManager localization)
    {
        ArgumentNullException.ThrowIfNull(user);
        ArgumentNullException.ThrowIfNull(rating);
        ArgumentNullException.ThrowIfNull(localization);

        if (!NeedsFiltering(user))
        {
            return true;
        }

        if (rating.LookupFailed)
        {
            return false;
        }

        if (rating.Adult)
        {
            return false;
        }

        var ratingScore = string.IsNullOrWhiteSpace(rating.Certification)
            ? null
            : localization.GetRatingScore(rating.Certification);

        if (ratingScore is null)
        {
            return !BlocksUnrated(user, mediaType);
        }

        var maxAllowed = user.MaxParentalRatingScore!.Value;
        var maxSub = user.MaxParentalRatingSubScore;

        if (ratingScore.Score != maxAllowed)
        {
            return ratingScore.Score < maxAllowed;
        }

        return !maxSub.HasValue || (ratingScore.SubScore ?? 0) <= maxSub.Value;
    }

    /// <summary>
    /// Searches Seerr and applies parental filtering for restricted users.
    /// </summary>
    /// <param name="user">Authenticated Jellyfin user.</param>
    /// <param name="query">Search query.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Filtered search items.</returns>
    public async Task<IReadOnlyList<SeerrSearchItem>> SearchForUserAsync(
        User user,
        string query,
        CancellationToken cancellationToken)
    {
        if (!NeedsFiltering(user))
        {
            return await _client.SearchAsync(query, cancellationToken).ConfigureAwait(false);
        }

        var config = Plugin.Instance!.Configuration;
        var limit = Math.Clamp(config.SearchLimit, 1, 50);
        var allowed = new List<SeerrSearchItem>(limit);

        for (var page = 1; page <= MaxBackfillPages && allowed.Count < limit; page++)
        {
            var candidates = await _client
                .SearchPageAsync(query, page, cancellationToken)
                .ConfigureAwait(false);
            if (candidates.Count == 0)
            {
                break;
            }

            var needsDetail = candidates.Where(c => !c.Adult).ToList();
            if (needsDetail.Count == 0)
            {
                continue;
            }

            var ratingTasks = needsDetail
                .Select(c => _client.GetMediaRatingAsync(c.Item.MediaType, c.Item.MediaId, cancellationToken))
                .ToArray();
            var ratings = await Task.WhenAll(ratingTasks).ConfigureAwait(false);

            for (var i = 0; i < needsDetail.Count && allowed.Count < limit; i++)
            {
                var candidate = needsDetail[i];
                var rating = ratings[i];
                if (IsContentAllowed(user, candidate.Item.MediaType, rating, _localization))
                {
                    allowed.Add(candidate.Item);
                }
                else if (_logger.IsEnabled(LogLevel.Debug))
                {
                    _logger.LogDebug(
                        "Filtered Seerr result {MediaType}/{MediaId} for user {UserId} (cert={Certification}, adult={Adult}, failed={Failed})",
                        candidate.Item.MediaType,
                        candidate.Item.MediaId,
                        user.Id,
                        rating.Certification ?? "(none)",
                        rating.Adult,
                        rating.LookupFailed);
                }
            }
        }

        return allowed;
    }

    /// <summary>
    /// Returns whether the user may request the given title.
    /// </summary>
    /// <param name="user">Authenticated Jellyfin user.</param>
    /// <param name="mediaType"><c>movie</c> or <c>tv</c>.</param>
    /// <param name="mediaId">TMDB id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns><c>true</c> when the request is allowed.</returns>
    public async Task<bool> IsRequestAllowedAsync(
        User user,
        string mediaType,
        int mediaId,
        CancellationToken cancellationToken)
    {
        if (!NeedsFiltering(user))
        {
            return true;
        }

        var rating = await _client
            .GetMediaRatingAsync(mediaType, mediaId, cancellationToken)
            .ConfigureAwait(false);
        return IsContentAllowed(user, mediaType, rating, _localization);
    }

    private static bool BlocksUnrated(User user, string mediaType)
    {
        var blocked = user.GetPreferenceValues<UnratedItem>(PreferenceKind.BlockUnratedItems);
        if (blocked.Length == 0)
        {
            return false;
        }

        if (string.Equals(mediaType, "movie", StringComparison.OrdinalIgnoreCase))
        {
            return blocked.Contains(UnratedItem.Movie);
        }

        if (string.Equals(mediaType, "tv", StringComparison.OrdinalIgnoreCase))
        {
            return blocked.Contains(UnratedItem.Series);
        }

        return false;
    }
}
