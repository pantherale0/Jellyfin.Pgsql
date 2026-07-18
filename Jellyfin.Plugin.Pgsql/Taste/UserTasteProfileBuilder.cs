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
/// Movies and series share one profile; episode plays roll up to SeriesId with binge caps.
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
        var seriesType = itemTypeLookup.BaseItemKindNames[BaseItemKind.Series];
        var episodeType = itemTypeLookup.BaseItemKindNames[BaseItemKind.Episode];
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

        var userIds = userDataUserIds.Union(playbackUserIds).ToList();

        var upserted = 0;
        var skippedNoSignals = 0;
        var skippedBelowMinSamples = 0;
        var maxMediaSignalsSeen = 0;
        var maxMovieSignalsSeen = 0;
        var maxSeriesSignalsSeen = 0;
        foreach (var userId in userIds)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var outcome = await RebuildUserAsync(
                    context,
                    userId,
                    movieType,
                    seriesType,
                    episodeType,
                    cutoff,
                    minSamples,
                    cancellationToken)
                .ConfigureAwait(false);
            maxMediaSignalsSeen = Math.Max(maxMediaSignalsSeen, outcome.MediaSignalCount);
            maxMovieSignalsSeen = Math.Max(maxMovieSignalsSeen, outcome.MovieSignalCount);
            maxSeriesSignalsSeen = Math.Max(maxSeriesSignalsSeen, outcome.SeriesSignalCount);
            if (outcome.Upserted)
            {
                upserted++;
                continue;
            }

            if (outcome.MediaSignalCount == 0)
            {
                skippedNoSignals++;
            }
            else
            {
                skippedBelowMinSamples++;
            }
        }

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "Taste rebuild finished: upserted={Upserted}, candidates={Candidates} (userData={UserDataCandidates}, playbackActivity={PlaybackCandidates}), skippedNoMediaSignals={SkippedNoMedia}, skippedBelowMinSamples={SkippedBelowMin} (minSamples={MinSamples}), maxMediaSignalsSeen={MaxMedia}, maxMovieSignalsSeen={MaxMovies}, maxSeriesSignalsSeen={MaxSeries}, lookbackDays={LookbackDays}",
                upserted,
                userIds.Count,
                userDataUserIds.Count,
                playbackUserIds.Count,
                skippedNoSignals,
                skippedBelowMinSamples,
                minSamples,
                maxMediaSignalsSeen,
                maxMovieSignalsSeen,
                maxSeriesSignalsSeen,
                lookbackDays);
        }

        if (upserted == 0)
        {
            await LogZeroUpsertDiagnosticsAsync(
                    context,
                    movieType,
                    seriesType,
                    episodeType,
                    cutoff,
                    minSamples,
                    cancellationToken)
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
    /// <param name="seriesType">Series BaseItem type name.</param>
    /// <param name="episodeType">Episode BaseItem type name.</param>
    /// <param name="cutoff">Earliest history date (UTC).</param>
    /// <param name="minSamples">Minimum samples to persist.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Whether a profile was written and signal counts.</returns>
    public async Task<RebuildUserOutcome> RebuildUserAsync(
        JellyfinDbContext context,
        Guid userId,
        string movieType,
        string seriesType,
        string episodeType,
        DateTime cutoff,
        int minSamples,
        CancellationToken cancellationToken)
    {
        var (signals, movieCount, seriesCount) = await LoadPositiveSignalsAsync(
                context,
                userId,
                movieType,
                seriesType,
                episodeType,
                cutoff,
                cancellationToken)
            .ConfigureAwait(false);
        if (signals.Count < minSamples)
        {
            return new RebuildUserOutcome(false, signals.Count, movieCount, seriesCount);
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
        return new RebuildUserOutcome(true, signals.Count, movieCount, seriesCount);
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
        string seriesType,
        string episodeType,
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

        var seriesLinkedUserDataRows = await context.UserData.AsNoTracking()
            .Where(ud => ud.IsFavorite
                || ud.Likes == true
                || ud.Played
                || ud.PlayCount > 0
                || (ud.LastPlayedDate != null && ud.LastPlayedDate >= cutoff))
            .Join(
                context.BaseItems.AsNoTracking().Where(i => i.Type == seriesType),
                ud => ud.ItemId,
                i => i.Id,
                (ud, i) => ud)
            .CountAsync(cancellationToken)
            .ConfigureAwait(false);

        var episodeLinkedUserDataRows = await context.UserData.AsNoTracking()
            .Where(ud => ud.IsFavorite
                || ud.Likes == true
                || ud.Played
                || ud.PlayCount > 0
                || (ud.LastPlayedDate != null && ud.LastPlayedDate >= cutoff))
            .Join(
                context.BaseItems.AsNoTracking().Where(i => i.Type == episodeType),
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

        var seriesCount = await context.BaseItems.AsNoTracking()
            .CountAsync(i => i.Type == seriesType, cancellationToken)
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
            "No taste profiles written. Likely causes: no favorite/play history, history not linked to movie/series BaseItems, or fewer than {MinSamples} media signals per user. Diagnostics: signalUserDataRows={SignalUserDataRows}, movieLinkedUserDataRows={MovieLinked}, seriesLinkedUserDataRows={SeriesLinked}, episodeLinkedUserDataRows={EpisodeLinked}, playbackActivityRowsInLookback={PlaybackRows}, movies={MovieCount}, series={SeriesCount}, userDataLinkedItemTypes=[{LinkedTypes}]",
            minSamples,
            signalUserDataRows,
            movieLinkedUserDataRows,
            seriesLinkedUserDataRows,
            episodeLinkedUserDataRows,
            playbackRows,
            movieCount,
            seriesCount,
            linkedTypesSummary);
    }

    private static async Task<(Dictionary<Guid, float> Signals, int MovieCount, int SeriesCount)> LoadPositiveSignalsAsync(
        JellyfinDbContext context,
        Guid userId,
        string movieType,
        string seriesType,
        string episodeType,
        DateTime cutoff,
        CancellationToken cancellationToken)
    {
        var signals = new Dictionary<Guid, float>();
        var now = DateTime.UtcNow;

        await AccumulateTypedUserDataSignalsAsync(context, userId, movieType, cutoff, now, signals, cancellationToken)
            .ConfigureAwait(false);
        await AccumulateTypedPlaybackSignalsAsync(context, userId, movieType, cutoff, now, signals, cancellationToken)
            .ConfigureAwait(false);
        var movieIds = signals.Keys.ToHashSet();

        await AccumulateTypedUserDataSignalsAsync(context, userId, seriesType, cutoff, now, signals, cancellationToken)
            .ConfigureAwait(false);

        await AccumulateEpisodePlayRollupAsync(
                context,
                userId,
                episodeType,
                cutoff,
                now,
                signals,
                cancellationToken)
            .ConfigureAwait(false);

        var movieCount = signals.Keys.Count(id => movieIds.Contains(id));
        var seriesCount = signals.Count - movieCount;
        return (signals, movieCount, seriesCount);
    }

    private static async Task AccumulateTypedUserDataSignalsAsync(
        JellyfinDbContext context,
        Guid userId,
        string itemType,
        DateTime cutoff,
        DateTime now,
        Dictionary<Guid, float> signals,
        CancellationToken cancellationToken)
    {
        var userDataRows = await context.UserData.AsNoTracking()
            .Where(ud => ud.UserId == userId
                && (ud.IsFavorite
                    || ud.Likes == true
                    || ud.Played
                    || ud.PlayCount > 0
                    || (ud.LastPlayedDate != null && ud.LastPlayedDate >= cutoff)))
            .Join(
                context.BaseItems.AsNoTracking().Where(i => i.Type == itemType),
                ud => ud.ItemId,
                i => i.Id,
                (ud, i) => ud)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        foreach (var row in userDataRows)
        {
            var weight = ComputeUserDataWeight(row, now);
            if (weight <= 0f)
            {
                continue;
            }

            signals[row.ItemId] = signals.GetValueOrDefault(row.ItemId) + weight;
        }
    }

    private static async Task AccumulateTypedPlaybackSignalsAsync(
        JellyfinDbContext context,
        Guid userId,
        string itemType,
        DateTime cutoff,
        DateTime now,
        Dictionary<Guid, float> signals,
        CancellationToken cancellationToken)
    {
        var playbackRows = await context.PlaybackActivity.AsNoTracking()
            .Where(p => p.UserId == userId && p.DatePlayed >= cutoff && p.PlayedTicks > 0)
            .Join(
                context.BaseItems.AsNoTracking().Where(i => i.Type == itemType),
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
    }

    private static async Task AccumulateEpisodePlayRollupAsync(
        JellyfinDbContext context,
        Guid userId,
        string episodeType,
        DateTime cutoff,
        DateTime now,
        Dictionary<Guid, float> signals,
        CancellationToken cancellationToken)
    {
        var episodeUserData = await context.UserData.AsNoTracking()
            .Where(ud => ud.UserId == userId
                && (ud.Played || ud.PlayCount > 0 || (ud.LastPlayedDate != null && ud.LastPlayedDate >= cutoff)))
            .Join(
                context.BaseItems.AsNoTracking()
                    .Where(i => i.Type == episodeType && i.SeriesId != null),
                ud => ud.ItemId,
                i => i.Id,
                (ud, i) => new { EpisodeId = i.Id, SeriesId = i.SeriesId!.Value, ud.LastPlayedDate })
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        var episodePlayback = await context.PlaybackActivity.AsNoTracking()
            .Where(p => p.UserId == userId && p.DatePlayed >= cutoff && p.PlayedTicks > 0)
            .Join(
                context.BaseItems.AsNoTracking()
                    .Where(i => i.Type == episodeType && i.SeriesId != null),
                p => p.ItemId,
                i => i.Id,
                (p, i) => new { EpisodeId = i.Id, SeriesId = i.SeriesId!.Value, p.DatePlayed })
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        var episodesBySeries = new Dictionary<Guid, HashSet<Guid>>();
        var latestPlayBySeries = new Dictionary<Guid, DateTime>();

        void Track(Guid seriesId, Guid episodeId, DateTime? playedAt)
        {
            if (!episodesBySeries.TryGetValue(seriesId, out var set))
            {
                set = [];
                episodesBySeries[seriesId] = set;
            }

            set.Add(episodeId);
            if (playedAt is DateTime at)
            {
                var utc = at.ToUniversalTime();
                if (!latestPlayBySeries.TryGetValue(seriesId, out var existing) || utc > existing)
                {
                    latestPlayBySeries[seriesId] = utc;
                }
            }
        }

        foreach (var row in episodeUserData)
        {
            Track(row.SeriesId, row.EpisodeId, row.LastPlayedDate);
        }

        foreach (var row in episodePlayback)
        {
            Track(row.SeriesId, row.EpisodeId, row.DatePlayed);
        }

        foreach (var (seriesId, episodes) in episodesBySeries)
        {
            var weight = TasteSeriesSignalWeights.BingeCappedPlayWeight(episodes.Count);
            if (latestPlayBySeries.TryGetValue(seriesId, out var lastPlayed))
            {
                var ageDays = Math.Max(0, (now - lastPlayed).TotalDays);
                weight *= (float)Math.Exp(-ageDays / 180.0);
            }

            if (weight <= 0f)
            {
                continue;
            }

            signals[seriesId] = signals.GetValueOrDefault(seriesId) + weight;
        }
    }

    private static float ComputeUserDataWeight(UserData row, DateTime now)
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

        return weight;
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
