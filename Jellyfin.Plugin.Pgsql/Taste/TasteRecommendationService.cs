using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.Pgsql.Query;
using MediaBrowser.Controller.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Pgsql.Taste;

/// <summary>
/// Materializes and serves taste-ranked recommendation feeds for the home screen.
/// </summary>
public sealed class TasteRecommendationService
{
    /// <summary>Default number of items stored/returned per feed.</summary>
    public const int DefaultLimit = 24;

    /// <summary>Hard cap on returned items after played filtering.</summary>
    public const int MaxLimit = 48;

    /// <summary>Maximum candidates scored during materialization.</summary>
    public const int CandidateCap = 2000;

    /// <summary>Top scored pool size used for weighted sampling.</summary>
    public const int PoolSize = 200;

    /// <summary>Number of top profile genres used to prefilter candidates.</summary>
    public const int TopGenreCount = 5;

    private static readonly TimeSpan CacheTtl = TimeSpan.FromHours(6);

    private static readonly BaseItemKind[] FeedItemTypes = [BaseItemKind.Movie, BaseItemKind.Series];

    private readonly IDbContextFactory<JellyfinDbContext> _dbProvider;
    private readonly UserTasteProfileStore _profileStore;
    private readonly IItemTypeLookup _itemTypeLookup;
    private readonly IQueryResultCache _cache;
    private readonly TasteNeuralModelStore _modelStore;
    private readonly ILogger<TasteRecommendationService> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="TasteRecommendationService"/> class.
    /// </summary>
    /// <param name="dbProvider">Database context factory.</param>
    /// <param name="profileStore">Taste profile store.</param>
    /// <param name="itemTypeLookup">Item type name lookup.</param>
    /// <param name="cache">Query result cache (Redis/memory).</param>
    /// <param name="modelStore">Loaded shadow model store.</param>
    /// <param name="logger">Logger.</param>
    public TasteRecommendationService(
        IDbContextFactory<JellyfinDbContext> dbProvider,
        UserTasteProfileStore profileStore,
        IItemTypeLookup itemTypeLookup,
        IQueryResultCache cache,
        TasteNeuralModelStore modelStore,
        ILogger<TasteRecommendationService> logger)
    {
        _dbProvider = dbProvider;
        _profileStore = profileStore;
        _itemTypeLookup = itemTypeLookup;
        _cache = cache;
        _modelStore = modelStore;
        _logger = logger;
    }

    /// <summary>
    /// Builds the cache key for a user's typed feed.
    /// </summary>
    /// <param name="userId">User id.</param>
    /// <param name="includeItemType">Movie or Series.</param>
    /// <returns>Cache key.</returns>
    public static string CacheKey(Guid userId, BaseItemKind includeItemType)
        => string.Create(
            CultureInfo.InvariantCulture,
            $"taste-rec:{userId:N}:{includeItemType}");

    /// <summary>
    /// Returns precomputed recommendations, cache-backed, with played items filtered out.
    /// </summary>
    /// <param name="userId">User id.</param>
    /// <param name="includeItemType">Movie or Series.</param>
    /// <param name="limit">Max items to return.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Ranked recommendations with sparse badge tiers.</returns>
    public async Task<IReadOnlyList<TasteMatchItem>> GetRecommendationsAsync(
        Guid userId,
        BaseItemKind includeItemType,
        int limit,
        CancellationToken cancellationToken)
    {
        if (includeItemType is not (BaseItemKind.Movie or BaseItemKind.Series))
        {
            return [];
        }

        limit = Math.Clamp(limit <= 0 ? DefaultLimit : limit, 1, MaxLimit);
        var itemTypeKey = includeItemType.ToString();
        var cacheKey = CacheKey(userId, includeItemType);

        IReadOnlyList<TasteMatchItem> stored;
        if (_cache.TryGetPayload(cacheKey, out var payload)
            && TasteRecommendationPayload.TryDeserialize(payload, out var cached))
        {
            stored = cached;
        }
        else
        {
            stored = await LoadFromDatabaseAsync(userId, itemTypeKey, cancellationToken).ConfigureAwait(false);
            if (stored.Count > 0)
            {
                _cache.SetPayload(cacheKey, TasteRecommendationPayload.Serialize(stored), CacheTtl);
            }
        }

        if (stored.Count == 0)
        {
            return [];
        }

        var itemIds = stored.Select(s => s.ItemId).ToList();
        var context = await _dbProvider.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
        await using (context.ConfigureAwait(false))
        {
            var playedIds = await context.UserData.AsNoTracking()
                .Where(ud => ud.UserId == userId && ud.Played && itemIds.Contains(ud.ItemId))
                .Select(ud => ud.ItemId)
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);

            IReadOnlyList<TasteMatchItem> result = playedIds.Count == 0
                ? stored.Take(limit).ToList()
                : stored.Where(s => !playedIds.Contains(s.ItemId)).Take(limit).ToList();

            await TryRecordImpressionsAsync(context, userId, itemTypeKey, result, cancellationToken)
                .ConfigureAwait(false);
            return result;
        }
    }

    private async Task TryRecordImpressionsAsync(
        JellyfinDbContext context,
        Guid userId,
        string itemTypeKey,
        IReadOnlyList<TasteMatchItem> items,
        CancellationToken cancellationToken)
    {
        if (items.Count == 0)
        {
            return;
        }

        try
        {
            var now = DateTime.UtcNow;
            var dedupeSince = now.AddHours(-TasteEngagementWeights.ImpressionDedupeHours);
            var candidateIds = items.Select(i => i.ItemId).ToList();
            var recent = await context.UserTasteRecommendationImpressions.AsNoTracking()
                .Where(i => i.UserId == userId
                    && i.ServedAt >= dedupeSince
                    && candidateIds.Contains(i.ItemId))
                .Select(i => i.ItemId)
                .Distinct()
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);
            var recentSet = recent.ToHashSet();

            var added = false;
            for (var rank = 0; rank < items.Count; rank++)
            {
                var item = items[rank];
                if (recentSet.Contains(item.ItemId))
                {
                    continue;
                }

                context.UserTasteRecommendationImpressions.Add(new UserTasteRecommendationImpression
                {
                    Id = Guid.NewGuid(),
                    UserId = userId,
                    ItemId = item.ItemId,
                    ItemType = itemTypeKey,
                    Rank = rank,
                    ServedAt = now
                });
                added = true;
            }

            if (added)
            {
                await context.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
            }
        }
        catch (Exception ex) when (ex is DbUpdateException or InvalidOperationException or OperationCanceledException)
        {
            if (ex is OperationCanceledException && cancellationToken.IsCancellationRequested)
            {
                throw;
            }

            _logger.LogWarning(ex, "Failed to record For You impressions for user {UserId}", userId);
        }
    }

    /// <summary>
    /// Rebuilds Movie and Series feeds for all users with valid taste profiles.
    /// </summary>
    /// <param name="progress">Progress reporter.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Number of users materialized.</returns>
    public async Task<int> RebuildAllFeedsAsync(IProgress<double>? progress, CancellationToken cancellationToken)
    {
        var options = TasteOptions.Current;
        if (!options.EnableTasteProfiles)
        {
            return 0;
        }

        var context = await _dbProvider.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
        await using (context.ConfigureAwait(false))
        {
            var userIds = await context.UserTasteProfiles.AsNoTracking()
                .Where(p => p.SampleCount >= options.MinSamples)
                .Select(p => p.UserId)
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);

            if (userIds.Count == 0)
            {
                progress?.Report(100);
                return 0;
            }

            var completed = 0;
            foreach (var userId in userIds)
            {
                cancellationToken.ThrowIfCancellationRequested();
                await RebuildUserFeedsAsync(context, userId, cancellationToken).ConfigureAwait(false);
                context.ChangeTracker.Clear();
                completed++;
                progress?.Report(100.0 * completed / userIds.Count);
            }

            return completed;
        }
    }

    /// <summary>
    /// Rebuilds feeds for a single user and invalidates cache keys.
    /// </summary>
    /// <param name="userId">User id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task representing the async operation.</returns>
    public async Task RebuildUserFeedsAsync(Guid userId, CancellationToken cancellationToken)
    {
        var context = await _dbProvider.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
        await using (context.ConfigureAwait(false))
        {
            await RebuildUserFeedsAsync(context, userId, cancellationToken).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// Weighted sample without replacement from a scored pool. Exposed for tests.
    /// </summary>
    /// <param name="scored">Positive scores.</param>
    /// <param name="limit">Items to keep.</param>
    /// <param name="poolSize">Max pool before sampling.</param>
    /// <param name="rng">Random source.</param>
    /// <returns>Sampled items with tiers.</returns>
    public static IReadOnlyList<TasteMatchItem> SampleFeed(
        IReadOnlyList<(Guid Id, int Score)> scored,
        int limit,
        int poolSize,
        Random rng)
    {
        ArgumentNullException.ThrowIfNull(scored);
        ArgumentNullException.ThrowIfNull(rng);
        limit = Math.Clamp(limit, 1, MaxLimit);
        poolSize = Math.Max(limit, poolSize);

        if (scored.Count == 0)
        {
            return [];
        }

        var pool = scored
            .OrderByDescending(s => s.Score)
            .ThenBy(s => s.Id)
            .Take(poolSize)
            .ToList();

        var selected = pool.Count <= limit
            ? pool
            : WeightedSampleWithoutReplacement(pool, limit, rng);

        var ordered = selected
            .OrderByDescending(s => s.Score)
            .ThenBy(s => s.Id)
            .ToList();
        var tierMap = TasteMatchService.AssignTiers(ordered)
            .ToDictionary(m => m.ItemId, m => m.Tier);
        return ordered
            .Select(s => new TasteMatchItem(
                s.Id,
                tierMap.TryGetValue(s.Id, out var tier) ? tier : string.Empty,
                s.Score))
            .ToList();
    }

    /// <summary>
    /// Builds a deterministic RNG seed for a user/type/day.
    /// </summary>
    /// <param name="userId">User id.</param>
    /// <param name="includeItemType">Item type.</param>
    /// <param name="utcDate">UTC calendar date.</param>
    /// <returns>Seed.</returns>
    public static int CreateSeed(Guid userId, BaseItemKind includeItemType, DateOnly utcDate)
        => HashCode.Combine(userId, includeItemType, utcDate);

    private async Task RebuildUserFeedsAsync(
        JellyfinDbContext context,
        Guid userId,
        CancellationToken cancellationToken)
    {
        var profile = await _profileStore.TryGetAsync(userId, cancellationToken).ConfigureAwait(false);
        if (profile is null)
        {
            await context.UserTasteRecommendations
                .Where(r => r.UserId == userId)
                .ExecuteDeleteAsync(cancellationToken)
                .ConfigureAwait(false);
            InvalidateUserCache(userId);
            return;
        }

        var now = DateTime.UtcNow;
        var utcDate = DateOnly.FromDateTime(now);
        foreach (var itemType in FeedItemTypes)
        {
            var feed = await BuildFeedAsync(
                    context,
                    userId,
                    profile.Value.Payload,
                    itemType,
                    DefaultLimit,
                    new Random(CreateSeed(userId, itemType, utcDate)),
                    cancellationToken)
                .ConfigureAwait(false);

            var typeKey = itemType.ToString();
            await context.UserTasteRecommendations
                .Where(r => r.UserId == userId && r.ItemType == typeKey)
                .ExecuteDeleteAsync(cancellationToken)
                .ConfigureAwait(false);

            for (var rank = 0; rank < feed.Count; rank++)
            {
                var item = feed[rank];
                context.UserTasteRecommendations.Add(new UserTasteRecommendation
                {
                    UserId = userId,
                    ItemType = typeKey,
                    Rank = rank,
                    ItemId = item.ItemId,
                    Score = item.Score,
                    Tier = item.Tier ?? string.Empty,
                    UpdatedAt = now
                });
            }
        }

        await context.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        InvalidateUserCache(userId);
    }

    private async Task<IReadOnlyList<TasteMatchItem>> BuildFeedAsync(
        JellyfinDbContext context,
        Guid userId,
        UserTasteFeaturePayload profile,
        BaseItemKind includeItemType,
        int limit,
        Random rng,
        CancellationToken cancellationToken)
    {
        if (!_itemTypeLookup.BaseItemKindNames.TryGetValue(includeItemType, out var itemTypeName)
            || string.IsNullOrWhiteSpace(itemTypeName))
        {
            return [];
        }

        var topGenres = profile.Genres
            .OrderByDescending(kvp => kvp.Value)
            .ThenBy(kvp => kvp.Key, StringComparer.OrdinalIgnoreCase)
            .Take(TopGenreCount)
            .Select(kvp => kvp.Key)
            .Where(g => !string.IsNullOrWhiteSpace(g))
            .ToList();
        if (topGenres.Count == 0)
        {
            return [];
        }

        var candidateIds = await context.ItemValuesMap.AsNoTracking()
            .Where(m => m.ItemValue.Type == ItemValueType.Genre
                && topGenres.Contains(m.ItemValue.CleanValue)
                && m.Item.Type == itemTypeName
                && !m.Item.IsVirtualItem)
            .Select(m => m.ItemId)
            .Distinct()
            .Take(CandidateCap)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        if (candidateIds.Count == 0)
        {
            return [];
        }

        var playedIds = await context.UserData.AsNoTracking()
            .Where(ud => ud.UserId == userId && ud.Played && candidateIds.Contains(ud.ItemId))
            .Select(ud => ud.ItemId)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        var unplayedIds = candidateIds.Except(playedIds).ToList();
        if (unplayedIds.Count == 0)
        {
            return [];
        }

        _itemTypeLookup.BaseItemKindNames.TryGetValue(BaseItemKind.Series, out var seriesTypeName);
        _itemTypeLookup.BaseItemKindNames.TryGetValue(BaseItemKind.BoxSet, out var boxSetTypeName);
        var features = await TasteCandidateFeatureLoader
            .LoadAsync(context, unplayedIds, cancellationToken, seriesTypeName, boxSetTypeName)
            .ConfigureAwait(false);
        var skipIds = await LoadConfirmedImpressionSkipIdsAsync(
                context,
                userId,
                unplayedIds,
                cancellationToken)
            .ConfigureAwait(false);
        var options = TasteOptions.Current;
        var neural = TasteNeuralScoring.TryPredict(
            _modelStore,
            profile,
            features,
            unplayedIds,
            options.UseNeuralForServing);
        var scored = new List<(Guid Id, int Score)>(unplayedIds.Count);
        foreach (var itemId in unplayedIds)
        {
            if (!features.TryGetValue(itemId, out var candidate))
            {
                continue;
            }

            var linear = LinearTasteScorer.ComputeBonus(profile, candidate, options.MaxTasteBonus);
            var score = TasteScoreCombiner.Blend(
                linear,
                TasteNeuralScoring.Probability(neural, itemId),
                options.UseNeuralForServing,
                options.MaxTasteBonus);
            if (skipIds.Contains(itemId))
            {
                score = Math.Max(0, score - LinearTasteScorer.ImpressionSkipPenalty);
            }

            if (score > 0)
            {
                scored.Add((itemId, score));
            }
        }

        return SampleFeed(scored, limit, PoolSize, rng);
    }

    private static async Task<HashSet<Guid>> LoadConfirmedImpressionSkipIdsAsync(
        JellyfinDbContext context,
        Guid userId,
        List<Guid> candidateIds,
        CancellationToken cancellationToken)
    {
        if (candidateIds.Count == 0)
        {
            return [];
        }

        var now = DateTime.UtcNow;
        var confirmBefore = now.AddDays(-TasteEngagementWeights.ImpressionSkipConfirmDays);
        var impressed = await context.UserTasteRecommendationImpressions.AsNoTracking()
            .Where(i => i.UserId == userId
                && i.ServedAt <= confirmBefore
                && candidateIds.Contains(i.ItemId))
            .Select(i => i.ItemId)
            .Distinct()
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        if (impressed.Count == 0)
        {
            return [];
        }

        var engaged = await context.UserData.AsNoTracking()
            .Where(ud => ud.UserId == userId
                && impressed.Contains(ud.ItemId)
                && (ud.IsFavorite
                    || ud.Likes == true
                    || ud.Played
                    || ud.PlayCount > 0
                    || ud.PlaybackPositionTicks > 0))
            .Select(ud => ud.ItemId)
            .Distinct()
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        var engagedSet = engaged.ToHashSet();
        return impressed.Where(id => !engagedSet.Contains(id)).ToHashSet();
    }

    private async Task<IReadOnlyList<TasteMatchItem>> LoadFromDatabaseAsync(
        Guid userId,
        string itemTypeKey,
        CancellationToken cancellationToken)
    {
        var context = await _dbProvider.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
        await using (context.ConfigureAwait(false))
        {
            var rows = await context.UserTasteRecommendations.AsNoTracking()
                .Where(r => r.UserId == userId && r.ItemType == itemTypeKey)
                .OrderBy(r => r.Rank)
                .Select(r => new { r.ItemId, r.Score, r.Tier })
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);

            return rows
                .Select(r => new TasteMatchItem(r.ItemId, r.Tier ?? string.Empty, r.Score))
                .ToList();
        }
    }

    private void InvalidateUserCache(Guid userId)
    {
        _cache.Remove(CacheKey(userId, BaseItemKind.Movie));
        _cache.Remove(CacheKey(userId, BaseItemKind.Series));
    }

    private static List<(Guid Id, int Score)> WeightedSampleWithoutReplacement(
        List<(Guid Id, int Score)> pool,
        int limit,
        Random rng)
    {
        var remaining = pool.ToList();
        var selected = new List<(Guid Id, int Score)>(limit);
        while (selected.Count < limit && remaining.Count > 0)
        {
            var totalWeight = remaining.Sum(r => Math.Max(1, r.Score));
            var pick = rng.Next(totalWeight);
            var cumulative = 0;
            var index = remaining.Count - 1;
            for (var i = 0; i < remaining.Count; i++)
            {
                cumulative += Math.Max(1, remaining[i].Score);
                if (pick < cumulative)
                {
                    index = i;
                    break;
                }
            }

            selected.Add(remaining[index]);
            remaining.RemoveAt(index);
        }

        return selected;
    }
}
