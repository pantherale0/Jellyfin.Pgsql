using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Microsoft.EntityFrameworkCore;

namespace Jellyfin.Plugin.Pgsql.Taste;

/// <summary>
/// Loads per-item taste feature snapshots for scoring.
/// </summary>
public static class TasteCandidateFeatureLoader
{
    private static readonly string[] ScoredPersonTypes =
    [
        nameof(PersonKind.Director),
        nameof(PersonKind.Actor),
        nameof(PersonKind.GuestStar)
    ];

    /// <summary>
    /// Loads genre/tag/studio/people/rating features for the given items.
    /// </summary>
    /// <param name="context">Database context.</param>
    /// <param name="itemIds">Item ids.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Features keyed by item id.</returns>
    public static async Task<Dictionary<Guid, TasteCandidateFeatures>> LoadAsync(
        JellyfinDbContext context,
        IReadOnlyList<Guid> itemIds,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(context);
        if (itemIds.Count == 0)
        {
            return [];
        }

        var idList = itemIds as List<Guid> ?? itemIds.ToList();
        var valueRows = await context.ItemValuesMap.AsNoTracking()
            .Where(m => idList.Contains(m.ItemId)
                && (m.ItemValue.Type == ItemValueType.Genre
                    || m.ItemValue.Type == ItemValueType.Tags
                    || m.ItemValue.Type == ItemValueType.Studios))
            .Select(m => new { m.ItemId, m.ItemValue.Type, m.ItemValue.CleanValue })
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        var peopleRows = await context.PeopleBaseItemMap.AsNoTracking()
            .Where(m => idList.Contains(m.ItemId) && ScoredPersonTypes.Contains(m.People.PersonType))
            .Select(m => new { m.ItemId, m.PeopleId, m.People.PersonType })
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        var ratings = await context.BaseItems.AsNoTracking()
            .Where(i => idList.Contains(i.Id))
            .Select(i => new { i.Id, i.CommunityRating })
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        var result = new Dictionary<Guid, TasteCandidateFeatures>();
        foreach (var id in idList)
        {
            var genres = valueRows
                .Where(r => r.ItemId == id && r.Type == ItemValueType.Genre)
                .Select(r => r.CleanValue)
                .Where(v => !string.IsNullOrWhiteSpace(v))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();
            var tags = valueRows
                .Where(r => r.ItemId == id && r.Type == ItemValueType.Tags)
                .Select(r => r.CleanValue)
                .Where(v => !string.IsNullOrWhiteSpace(v))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();
            var studios = valueRows
                .Where(r => r.ItemId == id && r.Type == ItemValueType.Studios)
                .Select(r => r.CleanValue)
                .Where(v => !string.IsNullOrWhiteSpace(v))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();
            var directors = peopleRows
                .Where(r => r.ItemId == id && r.PersonType == nameof(PersonKind.Director))
                .Select(r => r.PeopleId)
                .Distinct()
                .ToList();
            var actors = peopleRows
                .Where(r => r.ItemId == id && r.PersonType != nameof(PersonKind.Director))
                .Select(r => r.PeopleId)
                .Distinct()
                .ToList();
            var rating = ratings.FirstOrDefault(r => r.Id == id)?.CommunityRating;
            result[id] = new TasteCandidateFeatures(genres, tags, studios, directors, actors, rating);
        }

        return result;
    }
}
