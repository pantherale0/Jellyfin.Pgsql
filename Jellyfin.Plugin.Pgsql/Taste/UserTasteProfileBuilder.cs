using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Pgsql.Taste;

/// <summary>
/// Aggregates UserData + PlaybackActivity into <see cref="UserTasteProfile"/> rows.
/// </summary>
public sealed class UserTasteProfileBuilder
{
    private const string DirectorType = nameof(PersonKind.Director);
    private const string ActorType = nameof(PersonKind.Actor);
    private const string GuestStarType = nameof(PersonKind.GuestStar);

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = false,
    };

    private readonly ILogger<UserTasteProfileBuilder> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="UserTasteProfileBuilder"/> class.
    /// </summary>
    /// <param name="logger">Logger.</param>
    public UserTasteProfileBuilder(ILogger<UserTasteProfileBuilder> logger)
    {
        _logger = logger;
    }

    /// <summary>
    /// Rebuilds taste profiles for all users with sufficient history.
    /// </summary>
    /// <param name="context">Database context.</param>
    /// <param name="itemTypeLookup">Item type name lookup.</param>
    /// <param name="lookbackDays">History lookback window.</param>
    /// <param name="minSamples">Minimum positive signals required to persist a profile.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Number of profiles upserted.</returns>
    public async Task<int> RebuildAllAsync(
        JellyfinDbContext context,
        IItemTypeLookup itemTypeLookup,
        int lookbackDays,
        int minSamples,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(itemTypeLookup);

        var movieType = itemTypeLookup.BaseItemKindNames[BaseItemKind.Movie];
        var cutoff = DateTime.UtcNow.AddDays(-lookbackDays);

        var userDataUserIds = await context.UserData.AsNoTracking()
            .Where(ud => ud.IsFavorite
                || ud.Likes == true
                || ud.Played
                || ud.PlayCount > 0
                || (ud.LastPlayedDate != null && ud.LastPlayedDate >= cutoff))
            .Select(ud => ud.UserId)
            .Distinct()
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        var playbackUserIds = await context.PlaybackActivity.AsNoTracking()
            .Where(p => p.DatePlayed >= cutoff)
            .Select(p => p.UserId)
            .Distinct()
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        var userIds = new List<Guid>(userDataUserIds);
        foreach (var id in playbackUserIds)
        {
            if (!userIds.Contains(id))
            {
                userIds.Add(id);
            }
        }

        var upserted = 0;
        var skippedNoMovieSignals = 0;
        var skippedBelowMinSamples = 0;
        var maxMovieSignalsSeen = 0;
        foreach (var userId in userIds)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var outcome = await RebuildUserAsync(context, userId, movieType, cutoff, minSamples, cancellationToken)
                .ConfigureAwait(false);
            maxMovieSignalsSeen = Math.Max(maxMovieSignalsSeen, outcome.MovieSignalCount);
            if (outcome.Upserted)
            {
                upserted++;
                continue;
            }

            if (outcome.MovieSignalCount == 0)
            {
                skippedNoMovieSignals++;
            }
            else
            {
                skippedBelowMinSamples++;
            }
        }

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "Taste rebuild finished: upserted={Upserted}, candidates={Candidates} (userData={UserDataCandidates}, playbackActivity={PlaybackCandidates}), skippedNoMovieSignals={SkippedNoMovie}, skippedBelowMinSamples={SkippedBelowMin} (minSamples={MinSamples}), maxMovieSignalsSeen={MaxSignals}, lookbackDays={LookbackDays}, movieType={MovieType}",
                upserted,
                userIds.Count,
                userDataUserIds.Count,
                playbackUserIds.Count,
                skippedNoMovieSignals,
                skippedBelowMinSamples,
                minSamples,
                maxMovieSignalsSeen,
                lookbackDays,
                movieType);
        }

        if (upserted == 0)
        {
            await LogZeroUpsertDiagnosticsAsync(context, movieType, cutoff, minSamples, cancellationToken)
                .ConfigureAwait(false);
        }

        return upserted;
    }

    /// <summary>
    /// Rebuilds a single user's taste profile.
    /// </summary>
    /// <param name="context">Database context.</param>
    /// <param name="userId">User id.</param>
    /// <param name="movieType">Movie BaseItem type name.</param>
    /// <param name="cutoff">Earliest history date (UTC).</param>
    /// <param name="minSamples">Minimum samples to persist.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Whether a profile was written and how many movie signals were found.</returns>
    public async Task<RebuildUserOutcome> RebuildUserAsync(
        JellyfinDbContext context,
        Guid userId,
        string movieType,
        DateTime cutoff,
        int minSamples,
        CancellationToken cancellationToken)
    {
        var signals = await LoadPositiveSignalsAsync(context, userId, movieType, cutoff, cancellationToken)
            .ConfigureAwait(false);
        if (signals.Count < minSamples)
        {
            return new RebuildUserOutcome(false, signals.Count);
        }

        var itemIds = signals.Keys.ToList();
        var valueRows = await context.ItemValuesMap.AsNoTracking()
            .Where(m => itemIds.Contains(m.ItemId)
                && (m.ItemValue.Type == ItemValueType.Genre
                    || m.ItemValue.Type == ItemValueType.Tags
                    || m.ItemValue.Type == ItemValueType.Studios))
            .Select(m => new { m.ItemId, m.ItemValue.Type, m.ItemValue.CleanValue })
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        var peopleRows = await context.PeopleBaseItemMap.AsNoTracking()
            .Where(m => itemIds.Contains(m.ItemId)
                && (m.People.PersonType == DirectorType
                    || m.People.PersonType == ActorType
                    || m.People.PersonType == GuestStarType))
            .Select(m => new { m.ItemId, m.PeopleId, m.People.PersonType })
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        var ratings = await context.BaseItems.AsNoTracking()
            .Where(i => itemIds.Contains(i.Id) && i.CommunityRating != null)
            .Select(i => new { i.Id, Rating = i.CommunityRating!.Value })
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        var payload = new UserTasteFeaturePayload();
        var genreRaw = new Dictionary<string, float>(StringComparer.OrdinalIgnoreCase);
        var tagRaw = new Dictionary<string, float>(StringComparer.OrdinalIgnoreCase);
        var studioRaw = new Dictionary<string, float>(StringComparer.OrdinalIgnoreCase);
        var directorRaw = new Dictionary<string, float>(StringComparer.Ordinal);
        var actorRaw = new Dictionary<string, float>(StringComparer.Ordinal);
        var ratingSamples = new List<float>();

        foreach (var (itemId, weight) in signals)
        {
            foreach (var row in valueRows.Where(r => r.ItemId == itemId))
            {
                var bucket = row.Type switch
                {
                    ItemValueType.Genre => genreRaw,
                    ItemValueType.Tags => tagRaw,
                    ItemValueType.Studios => studioRaw,
                    _ => null
                };
                if (bucket is null || string.IsNullOrWhiteSpace(row.CleanValue))
                {
                    continue;
                }

                bucket[row.CleanValue] = bucket.GetValueOrDefault(row.CleanValue) + weight;
            }

            foreach (var row in peopleRows.Where(r => r.ItemId == itemId))
            {
                var key = row.PeopleId.ToString("N", CultureInfo.InvariantCulture);
                if (row.PersonType == DirectorType)
                {
                    directorRaw[key] = directorRaw.GetValueOrDefault(key) + weight;
                }
                else
                {
                    actorRaw[key] = actorRaw.GetValueOrDefault(key) + weight;
                }
            }

            var rating = ratings.FirstOrDefault(r => r.Id == itemId);
            if (rating is not null)
            {
                ratingSamples.Add(rating.Rating);
            }
        }

        payload.Genres = Normalize(genreRaw);
        payload.Tags = Normalize(tagRaw);
        payload.Studios = Normalize(studioRaw);
        payload.Directors = Normalize(directorRaw);
        payload.Actors = Normalize(actorRaw);

        if (ratingSamples.Count > 0)
        {
            ratingSamples.Sort();
            payload.RatingMean = ratingSamples.Average();
            payload.RatingP25 = Percentile(ratingSamples, 0.25f);
            payload.RatingP75 = Percentile(ratingSamples, 0.75f);
        }

        var entity = await context.UserTasteProfiles
            .FirstOrDefaultAsync(p => p.UserId == userId, cancellationToken)
            .ConfigureAwait(false);
        if (entity is null)
        {
            entity = new UserTasteProfile { UserId = userId };
            context.UserTasteProfiles.Add(entity);
        }

        entity.FeaturesJson = JsonSerializer.Serialize(payload, JsonOptions);
        entity.SampleCount = signals.Count;
        entity.UpdatedAt = DateTime.UtcNow;
        await context.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return new RebuildUserOutcome(true, signals.Count);
    }

    /// <summary>
    /// Deserializes a stored feature payload.
    /// </summary>
    /// <param name="featuresJson">JSON payload.</param>
    /// <returns>Feature payload.</returns>
    public static UserTasteFeaturePayload DeserializeFeatures(string featuresJson)
    {
        if (string.IsNullOrWhiteSpace(featuresJson))
        {
            return new UserTasteFeaturePayload();
        }

        try
        {
            return JsonSerializer.Deserialize<UserTasteFeaturePayload>(featuresJson, JsonOptions)
                ?? new UserTasteFeaturePayload();
        }
        catch (JsonException)
        {
            return new UserTasteFeaturePayload();
        }
    }

    private async Task LogZeroUpsertDiagnosticsAsync(
        JellyfinDbContext context,
        string movieType,
        DateTime cutoff,
        int minSamples,
        CancellationToken cancellationToken)
    {
        var signalUserDataRows = await context.UserData.AsNoTracking()
            .CountAsync(
                ud => ud.IsFavorite
                    || ud.Likes == true
                    || ud.Played
                    || ud.PlayCount > 0
                    || (ud.LastPlayedDate != null && ud.LastPlayedDate >= cutoff),
                cancellationToken)
            .ConfigureAwait(false);

        var movieLinkedUserDataRows = await context.UserData.AsNoTracking()
            .Where(ud => ud.IsFavorite
                || ud.Likes == true
                || ud.Played
                || ud.PlayCount > 0
                || (ud.LastPlayedDate != null && ud.LastPlayedDate >= cutoff))
            .Join(
                context.BaseItems.AsNoTracking().Where(i => i.Type == movieType),
                ud => ud.ItemId,
                i => i.Id,
                (ud, i) => ud)
            .CountAsync(cancellationToken)
            .ConfigureAwait(false);

        var playbackRows = await context.PlaybackActivity.AsNoTracking()
            .CountAsync(p => p.DatePlayed >= cutoff, cancellationToken)
            .ConfigureAwait(false);

        var movieCount = await context.BaseItems.AsNoTracking()
            .CountAsync(i => i.Type == movieType, cancellationToken)
            .ConfigureAwait(false);

        var linkedItemTypes = await context.UserData.AsNoTracking()
            .Where(ud => ud.IsFavorite
                || ud.Likes == true
                || ud.Played
                || ud.PlayCount > 0
                || (ud.LastPlayedDate != null && ud.LastPlayedDate >= cutoff))
            .Join(
                context.BaseItems.AsNoTracking(),
                ud => ud.ItemId,
                i => i.Id,
                (ud, i) => i.Type)
            .Distinct()
            .Take(10)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        var linkedTypesSummary = string.Join(", ", linkedItemTypes);
        _logger.LogWarning(
            "No taste profiles written. Likely causes: no favorite/play history, history not linked to movie BaseItems, or fewer than {MinSamples} movie signals per user. Diagnostics: signalUserDataRows={SignalUserDataRows}, movieLinkedUserDataRows={MovieLinkedUserDataRows}, playbackActivityRowsInLookback={PlaybackRows}, moviesWithExpectedType={MovieCount}, expectedMovieType={MovieType}, userDataLinkedItemTypes=[{LinkedTypes}]",
            minSamples,
            signalUserDataRows,
            movieLinkedUserDataRows,
            playbackRows,
            movieCount,
            movieType,
            linkedTypesSummary);
    }

    private static async Task<Dictionary<Guid, float>> LoadPositiveSignalsAsync(
        JellyfinDbContext context,
        Guid userId,
        string movieType,
        DateTime cutoff,
        CancellationToken cancellationToken)
    {
        var signals = new Dictionary<Guid, float>();

        var userDataRows = await context.UserData.AsNoTracking()
            .Where(ud => ud.UserId == userId
                && (ud.IsFavorite
                    || ud.Likes == true
                    || ud.Played
                    || ud.PlayCount > 0
                    || (ud.LastPlayedDate != null && ud.LastPlayedDate >= cutoff)))
            .Join(
                context.BaseItems.AsNoTracking().Where(i => i.Type == movieType),
                ud => ud.ItemId,
                i => i.Id,
                (ud, i) => ud)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        var now = DateTime.UtcNow;
        foreach (var row in userDataRows)
        {
            float weight = 0f;
            if (row.IsFavorite)
            {
                weight += 3f;
            }

            if (row.Likes == true)
            {
                weight += 2f;
            }
            else if (row.Likes == false)
            {
                weight -= 2f;
            }

            if (row.Played || row.PlayCount > 0)
            {
                weight += 1f + (Math.Min(row.PlayCount, 5) * 0.15f);
            }

            if (row.Rating is double userRating)
            {
                weight += (float)(userRating / 10.0);
            }

            if (row.LastPlayedDate is DateTime lastPlayed)
            {
                var ageDays = Math.Max(0, (now - lastPlayed.ToUniversalTime()).TotalDays);
                weight *= (float)Math.Exp(-ageDays / 180.0);
            }

            if (weight <= 0f)
            {
                continue;
            }

            signals[row.ItemId] = signals.GetValueOrDefault(row.ItemId) + weight;
        }

        var playbackRows = await context.PlaybackActivity.AsNoTracking()
            .Where(p => p.UserId == userId && p.DatePlayed >= cutoff && p.PlayedTicks > 0)
            .Join(
                context.BaseItems.AsNoTracking().Where(i => i.Type == movieType),
                p => p.ItemId,
                i => i.Id,
                (p, i) => p)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        foreach (var row in playbackRows)
        {
            var ageDays = Math.Max(0, (now - row.DatePlayed.ToUniversalTime()).TotalDays);
            var weight = 0.5f * (float)Math.Exp(-ageDays / 180.0);
            signals[row.ItemId] = signals.GetValueOrDefault(row.ItemId) + weight;
        }

        return signals;
    }

    private static Dictionary<string, float> Normalize(Dictionary<string, float> raw)
    {
        if (raw.Count == 0)
        {
            return new Dictionary<string, float>(raw.Comparer);
        }

        var sum = raw.Values.Sum();
        if (sum <= 0f)
        {
            return new Dictionary<string, float>(raw.Comparer);
        }

        return raw.ToDictionary(kvp => kvp.Key, kvp => kvp.Value / sum, raw.Comparer);
    }

    private static float Percentile(List<float> sorted, float percentile)
    {
        if (sorted.Count == 1)
        {
            return sorted[0];
        }

        var index = (sorted.Count - 1) * percentile;
        var lower = (int)Math.Floor(index);
        var upper = (int)Math.Ceiling(index);
        if (lower == upper)
        {
            return sorted[lower];
        }

        var frac = index - lower;
        return sorted[lower] + ((sorted[upper] - sorted[lower]) * frac);
    }
}
