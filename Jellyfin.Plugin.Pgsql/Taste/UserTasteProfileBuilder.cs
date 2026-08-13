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
    private const string WriterType = nameof(PersonKind.Writer);

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
        itemTypeLookup.BaseItemKindNames.TryGetValue(BaseItemKind.BoxSet, out var boxSetType);
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

        var pruneCutoff = DateTime.UtcNow.AddDays(-lookbackDays);
        await context.UserTasteRecommendationImpressions
            .Where(i => i.ServedAt < pruneCutoff)
            .ExecuteDeleteAsync(cancellationToken)
            .ConfigureAwait(false);

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
                    cancellationToken,
                    boxSetType)
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
    /// <param name="boxSetType">Optional BoxSet BaseItem type name for collection rollup.</param>
    /// <returns>Whether a profile was written and signal counts.</returns>
    public async Task<RebuildUserOutcome> RebuildUserAsync(
        JellyfinDbContext context,
        Guid userId,
        string movieType,
        string seriesType,
        string episodeType,
        DateTime cutoff,
        int minSamples,
        CancellationToken cancellationToken,
        string? boxSetType = null)
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
                    || m.People.PersonType == GuestStarType
                    || m.People.PersonType == WriterType))
            .Select(m => new { m.ItemId, m.PeopleId, m.People.PersonType })
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        var itemMeta = await context.BaseItems.AsNoTracking()
            .Where(i => itemIds.Contains(i.Id))
            .Select(i => new
            {
                i.Id,
                Rating = i.CommunityRating,
                i.ProductionYear,
                i.RunTimeTicks,
                i.InheritedParentalRatingValue,
                i.OriginalLanguage,
                i.ProductionLocations
            })
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        var metaById = itemMeta.ToDictionary(r => r.Id);

        var boxSetRows = Array.Empty<(Guid ItemId, Guid BoxSetId)>();
        if (!string.IsNullOrWhiteSpace(boxSetType))
        {
            var loaded = await context.LinkedChildren.AsNoTracking()
                .Where(lc => itemIds.Contains(lc.ChildId) && lc.ChildType == LinkedChildType.Manual)
                .Join(
                    context.BaseItems.AsNoTracking().Where(bs => bs.Type == boxSetType),
                    lc => lc.ParentId,
                    bs => bs.Id,
                    (lc, bs) => new { ItemId = lc.ChildId, BoxSetId = lc.ParentId })
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);
            boxSetRows = loaded.Select(r => (r.ItemId, r.BoxSetId)).ToArray();
        }

        var payload = new UserTasteFeaturePayload();
        var genreRaw = new Dictionary<string, float>(StringComparer.OrdinalIgnoreCase);
        var tagRaw = new Dictionary<string, float>(StringComparer.OrdinalIgnoreCase);
        var studioRaw = new Dictionary<string, float>(StringComparer.OrdinalIgnoreCase);
        var directorRaw = new Dictionary<string, float>(StringComparer.Ordinal);
        var actorRaw = new Dictionary<string, float>(StringComparer.Ordinal);
        var writerRaw = new Dictionary<string, float>(StringComparer.Ordinal);
        var boxSetRaw = new Dictionary<string, float>(StringComparer.Ordinal);
        var languageRaw = new Dictionary<string, float>(StringComparer.OrdinalIgnoreCase);
        var countryRaw = new Dictionary<string, float>(StringComparer.OrdinalIgnoreCase);
        var ratingSamples = new List<float>();
        var yearSamples = new List<float>();
        var runtimeSamples = new List<float>();
        var parentalSamples = new List<float>();

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
                else if (row.PersonType == WriterType)
                {
                    writerRaw[key] = writerRaw.GetValueOrDefault(key) + weight;
                }
                else
                {
                    actorRaw[key] = actorRaw.GetValueOrDefault(key) + weight;
                }
            }

            foreach (var (_, boxSetId) in boxSetRows.Where(r => r.ItemId == itemId))
            {
                var key = boxSetId.ToString("N", CultureInfo.InvariantCulture);
                boxSetRaw[key] = boxSetRaw.GetValueOrDefault(key) + weight;
            }

            if (!metaById.TryGetValue(itemId, out var meta))
            {
                continue;
            }

            if (!string.IsNullOrWhiteSpace(meta.OriginalLanguage))
            {
                languageRaw[meta.OriginalLanguage] = languageRaw.GetValueOrDefault(meta.OriginalLanguage) + weight;
            }

            foreach (var country in TasteCandidateFeatureLoader.SplitPipeValues(meta.ProductionLocations))
            {
                countryRaw[country] = countryRaw.GetValueOrDefault(country) + weight;
            }

            if (meta.Rating is float rating)
            {
                ratingSamples.Add(rating);
            }

            if (meta.ProductionYear is int year)
            {
                yearSamples.Add(year);
            }

            if (meta.RunTimeTicks is long runtime and > 0)
            {
                runtimeSamples.Add(runtime);
            }

            if (meta.InheritedParentalRatingValue is int parental)
            {
                parentalSamples.Add(parental);
            }
        }

        payload.Genres = Normalize(genreRaw);
        payload.Tags = Normalize(tagRaw);
        payload.Studios = Normalize(studioRaw);
        payload.Directors = Normalize(directorRaw);
        payload.Actors = Normalize(actorRaw);
        payload.Writers = Normalize(writerRaw);
        payload.BoxSets = Normalize(boxSetRaw);
        payload.Languages = Normalize(languageRaw);
        payload.Countries = Normalize(countryRaw);

        AssignBandStats(ratingSamples, (mean, p25, p75) =>
        {
            payload.RatingMean = mean;
            payload.RatingP25 = p25;
            payload.RatingP75 = p75;
        });
        AssignBandStats(yearSamples, (mean, p25, p75) =>
        {
            payload.YearMean = mean;
            payload.YearP25 = p25;
            payload.YearP75 = p75;
        });
        AssignBandStats(runtimeSamples, (mean, p25, p75) =>
        {
            payload.RuntimeMeanTicks = mean;
            payload.RuntimeP25Ticks = p25;
            payload.RuntimeP75Ticks = p75;
        });
        AssignBandStats(parentalSamples, (mean, p25, p75) =>
        {
            payload.ParentalMean = mean;
            payload.ParentalP25 = p25;
            payload.ParentalP75 = p75;
        });

        var typedTotal = movieCount + seriesCount;
        if (typedTotal > 0)
        {
            payload.SeriesShare = seriesCount / (float)typedTotal;
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

        var recommendedIds = await context.UserTasteRecommendationImpressions.AsNoTracking()
            .Where(i => i.UserId == userId && i.ServedAt >= cutoff)
            .Select(i => i.ItemId)
            .Distinct()
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        var recommended = recommendedIds.ToHashSet();

        await AccumulateTypedMediaSignalsAsync(
                context,
                userId,
                movieType,
                cutoff,
                now,
                recommended,
                signals,
                cancellationToken)
            .ConfigureAwait(false);
        var movieIds = signals.Keys.ToHashSet();

        await AccumulateTypedMediaSignalsAsync(
                context,
                userId,
                seriesType,
                cutoff,
                now,
                recommended,
                signals,
                cancellationToken)
            .ConfigureAwait(false);

        await AccumulateEpisodePlayRollupAsync(
                context,
                userId,
                episodeType,
                cutoff,
                now,
                recommended,
                signals,
                cancellationToken)
            .ConfigureAwait(false);

        var movieCount = signals.Keys.Count(id => movieIds.Contains(id));
        var seriesCount = signals.Count - movieCount;
        return (signals, movieCount, seriesCount);
    }

    private static async Task AccumulateTypedMediaSignalsAsync(
        JellyfinDbContext context,
        Guid userId,
        string itemType,
        DateTime cutoff,
        DateTime now,
        HashSet<Guid> recommended,
        Dictionary<Guid, float> signals,
        CancellationToken cancellationToken)
    {
        // UserData PK includes CustomDataKey — alternate versions yield multiple rows per ItemId.
        var userDataRaw = await context.UserData.AsNoTracking()
            .Where(ud => ud.UserId == userId
                && (ud.IsFavorite
                    || ud.Likes == true
                    || ud.Likes == false
                    || ud.Played
                    || ud.PlayCount > 0
                    || ud.PlaybackPositionTicks > 0
                    || (ud.LastPlayedDate != null && ud.LastPlayedDate >= cutoff)))
            .Join(
                context.BaseItems.AsNoTracking().Where(i => i.Type == itemType),
                ud => ud.ItemId,
                i => i.Id,
                (ud, i) => new
                {
                    ud.ItemId,
                    ud.IsFavorite,
                    ud.Likes,
                    ud.Played,
                    ud.PlayCount,
                    ud.Rating,
                    ud.PlaybackPositionTicks,
                    ud.LastPlayedDate,
                    i.RunTimeTicks
                })
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        var userDataRows = userDataRaw.Select(r => new UserDataEngagementRow(
            r.ItemId,
            r.IsFavorite,
            r.Likes,
            r.Played,
            r.PlayCount,
            r.Rating,
            r.PlaybackPositionTicks,
            r.LastPlayedDate,
            r.RunTimeTicks));

        var playbackAgg = await context.PlaybackActivity.AsNoTracking()
            .Where(p => p.UserId == userId && p.DatePlayed >= cutoff && p.PlayedTicks > 0)
            .Join(
                context.BaseItems.AsNoTracking().Where(i => i.Type == itemType),
                p => p.ItemId,
                i => i.Id,
                (p, i) => new { p.ItemId, p.PlayedTicks, p.DatePlayed, i.RunTimeTicks })
            .GroupBy(p => p.ItemId)
            .Select(g => new
            {
                ItemId = g.Key,
                MaxPlayedTicks = g.Max(x => x.PlayedTicks),
                LastPlayed = g.Max(x => x.DatePlayed),
                RunTimeTicks = g.Max(x => x.RunTimeTicks)
            })
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        var playbackByItem = playbackAgg.ToDictionary(p => p.ItemId);
        var userDataByItem = UserDataEngagementAggregation.ToDictionaryByItemId(userDataRows);
        var itemIds = userDataByItem.Keys.Union(playbackByItem.Keys).ToList();
        foreach (var itemId in itemIds)
        {
            var hasUd = userDataByItem.TryGetValue(itemId, out var ud);
            playbackByItem.TryGetValue(itemId, out var pb);

            var maxTicks = Math.Max(hasUd ? ud.PlaybackPositionTicks : 0L, pb?.MaxPlayedTicks ?? 0L);
            var runTime = hasUd ? ud.RunTimeTicks : null;
            runTime ??= pb?.RunTimeTicks;
            DateTime? lastPlayed = null;
            if (hasUd && ud.LastPlayedDate is DateTime udPlayed)
            {
                lastPlayed = udPlayed.ToUniversalTime();
            }

            if (pb?.LastPlayed is DateTime pbPlayed)
            {
                var pbUtc = pbPlayed.ToUniversalTime();
                if (lastPlayed is null || pbUtc > lastPlayed)
                {
                    lastPlayed = pbUtc;
                }
            }

            var input = new TasteEngagementInput(
                IsFavorite: hasUd && ud.IsFavorite,
                Likes: hasUd ? ud.Likes : null,
                Played: hasUd && ud.Played,
                PlayCount: hasUd ? ud.PlayCount : 0,
                UserRating: hasUd ? ud.Rating : null,
                MaxPlayedTicks: maxTicks,
                RunTimeTicks: runTime,
                LastPlayedUtc: lastPlayed,
                HasLaterPlayWithinNoReturnWindow: false,
                WasRecommended: recommended.Contains(itemId));

            var weight = TasteEngagementWeights.ComputeLinearWeight(input, now);
            if (weight == 0f)
            {
                continue;
            }

            signals[itemId] = signals.GetValueOrDefault(itemId) + weight;
        }
    }

    private static async Task AccumulateEpisodePlayRollupAsync(
        JellyfinDbContext context,
        Guid userId,
        string episodeType,
        DateTime cutoff,
        DateTime now,
        HashSet<Guid> recommended,
        Dictionary<Guid, float> signals,
        CancellationToken cancellationToken)
    {
        var episodeUserData = await context.UserData.AsNoTracking()
            .Where(ud => ud.UserId == userId
                && (ud.Played
                    || ud.PlayCount > 0
                    || ud.PlaybackPositionTicks > 0
                    || (ud.LastPlayedDate != null && ud.LastPlayedDate >= cutoff)))
            .Join(
                context.BaseItems.AsNoTracking()
                    .Where(i => i.Type == episodeType && i.SeriesId != null),
                ud => ud.ItemId,
                i => i.Id,
                (ud, i) => new
                {
                    EpisodeId = i.Id,
                    SeriesId = i.SeriesId!.Value,
                    ud.Played,
                    ud.PlayCount,
                    ud.PlaybackPositionTicks,
                    ud.LastPlayedDate,
                    i.RunTimeTicks
                })
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        var episodePlayback = await context.PlaybackActivity.AsNoTracking()
            .Where(p => p.UserId == userId && p.DatePlayed >= cutoff && p.PlayedTicks > 0)
            .Join(
                context.BaseItems.AsNoTracking()
                    .Where(i => i.Type == episodeType && i.SeriesId != null),
                p => p.ItemId,
                i => i.Id,
                (p, i) => new
                {
                    EpisodeId = i.Id,
                    SeriesId = i.SeriesId!.Value,
                    p.PlayedTicks,
                    p.DatePlayed,
                    i.RunTimeTicks
                })
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        var seriesIds = episodeUserData.Select(e => e.SeriesId)
            .Concat(episodePlayback.Select(e => e.SeriesId))
            .Distinct()
            .ToHashSet();

        var seriesRecommended = await context.UserTasteRecommendationImpressions.AsNoTracking()
            .Where(i => i.UserId == userId && i.ServedAt >= cutoff && seriesIds.Contains(i.ItemId))
            .Select(i => i.ItemId)
            .Distinct()
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        foreach (var id in seriesRecommended)
        {
            recommended.Add(id);
        }

        var episodesBySeries = new Dictionary<Guid, HashSet<Guid>>();
        var abandonedBySeries = new Dictionary<Guid, HashSet<Guid>>();
        var latestPlayBySeries = new Dictionary<Guid, DateTime>();
        var deepOrMidBySeries = new Dictionary<Guid, bool>();

        void EnsureSeries(Guid seriesId)
        {
            if (!episodesBySeries.ContainsKey(seriesId))
            {
                episodesBySeries[seriesId] = [];
                abandonedBySeries[seriesId] = [];
            }
        }

        var episodeState = new Dictionary<Guid, (Guid SeriesId, long MaxTicks, long? RunTime, DateTime? LastPlayed, bool Played, int PlayCount)>();

        foreach (var row in episodeUserData)
        {
            var lastPlayed = row.LastPlayedDate?.ToUniversalTime();
            if (episodeState.TryGetValue(row.EpisodeId, out var existing))
            {
                DateTime? mergedLast = existing.LastPlayed;
                if (lastPlayed is not null && (mergedLast is null || lastPlayed > mergedLast))
                {
                    mergedLast = lastPlayed;
                }

                episodeState[row.EpisodeId] = (
                    row.SeriesId,
                    Math.Max(existing.MaxTicks, row.PlaybackPositionTicks),
                    existing.RunTime ?? row.RunTimeTicks,
                    mergedLast,
                    existing.Played || row.Played,
                    Math.Max(existing.PlayCount, row.PlayCount));
            }
            else
            {
                episodeState[row.EpisodeId] = (
                    row.SeriesId,
                    row.PlaybackPositionTicks,
                    row.RunTimeTicks,
                    lastPlayed,
                    row.Played,
                    row.PlayCount);
            }
        }

        foreach (var row in episodePlayback)
        {
            var pbUtc = row.DatePlayed.ToUniversalTime();
            if (episodeState.TryGetValue(row.EpisodeId, out var existing))
            {
                episodeState[row.EpisodeId] = (
                    existing.SeriesId,
                    Math.Max(existing.MaxTicks, row.PlayedTicks),
                    existing.RunTime ?? row.RunTimeTicks,
                    existing.LastPlayed is DateTime lp && lp > pbUtc ? lp : pbUtc,
                    existing.Played,
                    existing.PlayCount);
            }
            else
            {
                episodeState[row.EpisodeId] = (
                    row.SeriesId,
                    row.PlayedTicks,
                    row.RunTimeTicks,
                    pbUtc,
                    false,
                    0);
            }
        }

        foreach (var (episodeId, state) in episodeState)
        {
            EnsureSeries(state.SeriesId);
            episodesBySeries[state.SeriesId].Add(episodeId);
            if (state.LastPlayed is DateTime at)
            {
                if (!latestPlayBySeries.TryGetValue(state.SeriesId, out var existing) || at > existing)
                {
                    latestPlayBySeries[state.SeriesId] = at;
                }
            }

            var input = new TasteEngagementInput(
                IsFavorite: false,
                Likes: null,
                Played: state.Played,
                PlayCount: state.PlayCount,
                UserRating: null,
                MaxPlayedTicks: state.MaxTicks,
                RunTimeTicks: state.RunTime,
                LastPlayedUtc: state.LastPlayed,
                HasLaterPlayWithinNoReturnWindow: false,
                WasRecommended: false);

            var kind = TasteEngagementWeights.Classify(input, now);
            if (kind == TasteEngagementKind.Abandon)
            {
                abandonedBySeries[state.SeriesId].Add(episodeId);
            }
            else if (kind is TasteEngagementKind.DeepPlay
                     or TasteEngagementKind.MidPlay
                     or TasteEngagementKind.FavoriteOrLike)
            {
                deepOrMidBySeries[state.SeriesId] = true;
            }
        }

        foreach (var (seriesId, episodes) in episodesBySeries)
        {
            var abandonedCount = abandonedBySeries.GetValueOrDefault(seriesId)?.Count ?? 0;
            if (TasteEngagementWeights.IsSeriesAbandon(episodes.Count, abandonedCount)
                && !deepOrMidBySeries.GetValueOrDefault(seriesId))
            {
                var weight = recommended.Contains(seriesId)
                    ? TasteEngagementWeights.RecAbandonLinearWeight
                    : TasteEngagementWeights.AbandonLinearWeight;
                if (latestPlayBySeries.TryGetValue(seriesId, out var lastPlayed))
                {
                    var ageDays = Math.Max(0, (now - lastPlayed).TotalDays);
                    weight *= (float)Math.Exp(-ageDays / 180.0);
                }

                if (weight != 0f)
                {
                    signals[seriesId] = signals.GetValueOrDefault(seriesId) + weight;
                }

                continue;
            }

            var bingeWeight = TasteSeriesSignalWeights.BingeCappedPlayWeight(episodes.Count);
            if (latestPlayBySeries.TryGetValue(seriesId, out var last))
            {
                var ageDays = Math.Max(0, (now - last).TotalDays);
                bingeWeight *= (float)Math.Exp(-ageDays / 180.0);
            }

            if (bingeWeight <= 0f)
            {
                continue;
            }

            if (recommended.Contains(seriesId) && bingeWeight > 0f)
            {
                bingeWeight *= TasteEngagementWeights.RecPositiveEngageMultiplier;
            }

            signals[seriesId] = signals.GetValueOrDefault(seriesId) + bingeWeight;
        }
    }

    private static Dictionary<string, float> Normalize(Dictionary<string, float> raw)
    {
        if (raw.Count == 0)
        {
            return new Dictionary<string, float>(raw.Comparer);
        }

        var positive = raw.Where(kvp => kvp.Value > 0f)
            .ToDictionary(kvp => kvp.Key, kvp => kvp.Value, raw.Comparer);
        if (positive.Count == 0)
        {
            return new Dictionary<string, float>(raw.Comparer);
        }

        var sum = positive.Values.Sum();
        if (sum <= 0f)
        {
            return new Dictionary<string, float>(raw.Comparer);
        }

        return positive.ToDictionary(kvp => kvp.Key, kvp => kvp.Value / sum, raw.Comparer);
    }

    private static void AssignBandStats(List<float> samples, Action<float, float, float> assign)
    {
        if (samples.Count == 0)
        {
            return;
        }

        samples.Sort();
        assign(samples.Average(), Percentile(samples, 0.25f), Percentile(samples, 0.75f));
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
