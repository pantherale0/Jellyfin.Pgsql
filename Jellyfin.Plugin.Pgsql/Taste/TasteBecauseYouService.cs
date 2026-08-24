using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.Pgsql.Similar;
using MediaBrowser.Controller.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using DbLinkedChildType = Jellyfin.Database.Implementations.Entities.LinkedChildType;

namespace Jellyfin.Plugin.Pgsql.Taste;

/// <summary>
/// Materializes precomputed Because you watched/liked similar lists.
/// </summary>
public sealed class TasteBecauseYouService
{
    private readonly IDbContextFactory<JellyfinDbContext> _dbProvider;
    private readonly PostgresMovieSimilarItemsProvider _movieSimilar;
    private readonly IItemTypeLookup _itemTypeLookup;
    private readonly ILogger<TasteBecauseYouService> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="TasteBecauseYouService"/> class.
    /// </summary>
    /// <param name="dbProvider">Database context factory.</param>
    /// <param name="movieSimilar">Movie similar-items scorer.</param>
    /// <param name="itemTypeLookup">Item type name lookup.</param>
    /// <param name="logger">Logger.</param>
    public TasteBecauseYouService(
        IDbContextFactory<JellyfinDbContext> dbProvider,
        PostgresMovieSimilarItemsProvider movieSimilar,
        IItemTypeLookup itemTypeLookup,
        ILogger<TasteBecauseYouService> logger)
    {
        _dbProvider = dbProvider;
        _movieSimilar = movieSimilar;
        _itemTypeLookup = itemTypeLookup;
        _logger = logger;
    }

    /// <summary>
    /// Rebuilds Because you X feeds for every user with a taste profile.
    /// </summary>
    /// <param name="progress">Progress reporter.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Number of users materialized.</returns>
    public async Task<int> RebuildAllAsync(IProgress<double>? progress, CancellationToken cancellationToken)
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
                await RebuildUserAsync(userId, cancellationToken).ConfigureAwait(false);
                completed++;
                progress?.Report(100.0 * completed / userIds.Count);
            }

            return completed;
        }
    }

    /// <summary>
    /// Rebuilds Because you X lists for a single user.
    /// </summary>
    /// <param name="userId">User id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task representing the async operation.</returns>
    public async Task RebuildUserAsync(Guid userId, CancellationToken cancellationToken)
    {
        if (!_itemTypeLookup.BaseItemKindNames.TryGetValue(BaseItemKind.Movie, out var movieType)
            || string.IsNullOrWhiteSpace(movieType))
        {
            return;
        }

        _itemTypeLookup.BaseItemKindNames.TryGetValue(BaseItemKind.BoxSet, out var boxSetType);

        var context = await _dbProvider.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
        await using (context.ConfigureAwait(false))
        {
            var sources = await LoadSourcesAsync(context, userId, movieType, boxSetType, cancellationToken)
                .ConfigureAwait(false);
            await context.UserTasteBecauseYouRecommendations
                .Where(r => r.UserId == userId)
                .ExecuteDeleteAsync(cancellationToken)
                .ConfigureAwait(false);

            if (sources.Count == 0)
            {
                await context.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
                return;
            }

            var options = TasteOptions.Current;
            var sourceIds = sources.Select(s => s.ItemId).ToList();
            var scores = await _movieSimilar
                .ComputeBatchScoresAsync(
                    sourceIds,
                    cancellationToken,
                    userId,
                    useNeural: options.UseNeuralForServing)
                .ConfigureAwait(false);

            var allCandidateIds = scores.Values.SelectMany(m => m.Keys).Distinct().ToList();
            var playedIds = allCandidateIds.Count == 0
                ? []
                : (await context.UserData.AsNoTracking()
                    .Where(ud => ud.UserId == userId && ud.Played && allCandidateIds.Contains(ud.ItemId))
                    .Select(ud => ud.ItemId)
                    .ToListAsync(cancellationToken)
                    .ConfigureAwait(false)).ToHashSet();

            var now = DateTime.UtcNow;
            foreach (var source in sources)
            {
                if (!scores.TryGetValue(source.ItemId, out var map) || map.Count == 0)
                {
                    continue;
                }

                var ranked = map
                    .Where(kvp => !playedIds.Contains(kvp.Key))
                    .OrderByDescending(kvp => kvp.Value)
                    .ThenBy(kvp => kvp.Key)
                    .Take(PostgresMovieSimilarItemsProvider.BecauseYouPerSourceLimit)
                    .ToList();

                for (var rank = 0; rank < ranked.Count; rank++)
                {
                    context.UserTasteBecauseYouRecommendations.Add(new UserTasteBecauseYouRecommendation
                    {
                        UserId = userId,
                        SourceItemId = source.ItemId,
                        Rank = rank,
                        SourceKind = source.Kind,
                        ItemId = ranked[rank].Key,
                        Score = ranked[rank].Value,
                        UpdatedAt = now
                    });
                }
            }

            await context.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
            if (_logger.IsEnabled(LogLevel.Debug))
            {
                _logger.LogDebug(
                    "Materialized Because you X for user {UserId} (sources={SourceCount})",
                    userId,
                    sources.Count);
            }
        }
    }

    private static async Task<IReadOnlyList<BecauseYouSource>> LoadSourcesAsync(
        JellyfinDbContext context,
        Guid userId,
        string movieType,
        string? boxSetType,
        CancellationToken cancellationToken)
    {
        var playedIds = await context.UserData.AsNoTracking()
            .Where(ud => ud.UserId == userId && ud.Played)
            .Join(
                context.BaseItems.AsNoTracking().Where(i => i.Type == movieType && !i.IsVirtualItem),
                ud => ud.ItemId,
                i => i.Id,
                (ud, _) => new { ud.ItemId, ud.LastPlayedDate })
            .OrderByDescending(x => x.LastPlayedDate)
            .Select(x => x.ItemId)
            .Take(40)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        var likedIds = await context.UserData.AsNoTracking()
            .Where(ud => ud.UserId == userId && (ud.IsFavorite || ud.Likes == true))
            .Join(
                context.BaseItems.AsNoTracking().Where(i => i.Type == movieType && !i.IsVirtualItem),
                ud => ud.ItemId,
                i => i.Id,
                (ud, _) => ud.ItemId)
            .Distinct()
            .Take(40)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        var candidateIds = playedIds.Concat(likedIds).Distinct().ToList();
        var boxSetsByItem = await LoadBoxSetsAsync(context, candidateIds, boxSetType, cancellationToken)
            .ConfigureAwait(false);

        static BecauseYouSourceCandidate ToCandidate(Guid id, Dictionary<Guid, List<Guid>> map)
            => new(id, map.TryGetValue(id, out var boxSets) ? boxSets : []);

        var played = playedIds.Select(id => ToCandidate(id, boxSetsByItem)).ToList();
        var liked = likedIds.Select(id => ToCandidate(id, boxSetsByItem)).ToList();
        return BecauseYouSourcePicker.Pick(played, liked);
    }

    private static async Task<Dictionary<Guid, List<Guid>>> LoadBoxSetsAsync(
        JellyfinDbContext context,
        List<Guid> itemIds,
        string? boxSetType,
        CancellationToken cancellationToken)
    {
        if (itemIds.Count == 0 || string.IsNullOrWhiteSpace(boxSetType))
        {
            return [];
        }

        var rows = await context.LinkedChildren.AsNoTracking()
            .Where(lc => itemIds.Contains(lc.ChildId) && lc.ChildType == DbLinkedChildType.Manual)
            .Join(
                context.BaseItems.AsNoTracking().Where(bs => bs.Type == boxSetType),
                lc => lc.ParentId,
                bs => bs.Id,
                (lc, bs) => new { ItemId = lc.ChildId, BoxSetId = lc.ParentId })
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        return rows
            .GroupBy(r => r.ItemId)
            .ToDictionary(g => g.Key, g => g.Select(x => x.BoxSetId).Distinct().ToList());
    }
}
