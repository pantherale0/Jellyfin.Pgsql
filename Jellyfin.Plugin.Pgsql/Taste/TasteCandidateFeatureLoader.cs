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
        nameof(PersonKind.GuestStar),
        nameof(PersonKind.Writer)
    ];

    /// <summary>
    /// Splits a pipe-delimited metadata field into distinct tokens.
    /// </summary>
    /// <param name="raw">Raw stored value.</param>
    /// <returns>Distinct trimmed tokens.</returns>
    public static IReadOnlyList<string> SplitPipeValues(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return [];
        }

        return raw.Split('|', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(v => v.Length > 0)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    /// <summary>
    /// Loads genre/tag/studio/people/rating/year/runtime/parental/language/box-set features for the given items.
    /// </summary>
    /// <param name="context">Database context.</param>
    /// <param name="itemIds">Item ids.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <param name="seriesType">Optional BaseItem type name for series; when null, <see cref="TasteCandidateFeatures.IsSeries"/> is false.</param>
    /// <param name="boxSetType">Optional BoxSet BaseItem type name for collection membership.</param>
    /// <returns>Features keyed by item id.</returns>
    public static async Task<Dictionary<Guid, TasteCandidateFeatures>> LoadAsync(
        JellyfinDbContext context,
        IReadOnlyList<Guid> itemIds,
        CancellationToken cancellationToken,
        string? seriesType = null,
        string? boxSetType = null)
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

        var baseRows = await context.BaseItems.AsNoTracking()
            .Where(i => idList.Contains(i.Id))
            .Select(i => new
            {
                i.Id,
                i.CommunityRating,
                i.ProductionYear,
                i.RunTimeTicks,
                i.InheritedParentalRatingValue,
                i.Type,
                i.OriginalLanguage,
                i.ProductionLocations
            })
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        List<(Guid ItemId, Guid BoxSetId)> boxSetRows = [];
        if (!string.IsNullOrWhiteSpace(boxSetType))
        {
            var loaded = await context.LinkedChildren.AsNoTracking()
                .Where(lc => idList.Contains(lc.ChildId) && lc.ChildType == LinkedChildType.Manual)
                .Join(
                    context.BaseItems.AsNoTracking().Where(bs => bs.Type == boxSetType),
                    lc => lc.ParentId,
                    bs => bs.Id,
                    (lc, bs) => new { ItemId = lc.ChildId, BoxSetId = lc.ParentId })
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);
            boxSetRows = loaded.Select(r => (r.ItemId, r.BoxSetId)).ToList();
        }

        var result = new Dictionary<Guid, TasteCandidateFeatures>();
        var valuesByItem = valueRows.ToLookup(r => r.ItemId);
        var peopleByItem = peopleRows.ToLookup(r => r.ItemId);
        var boxSetsByItem = boxSetRows.ToLookup(r => r.ItemId);
        var baseById = baseRows.ToDictionary(r => r.Id);
        foreach (var id in idList)
        {
            var itemValues = valuesByItem[id];
            var itemPeople = peopleByItem[id];
            var genres = itemValues
                .Where(r => r.Type == ItemValueType.Genre)
                .Select(r => r.CleanValue)
                .Where(v => !string.IsNullOrWhiteSpace(v))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();
            var tags = itemValues
                .Where(r => r.Type == ItemValueType.Tags)
                .Select(r => r.CleanValue)
                .Where(v => !string.IsNullOrWhiteSpace(v))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();
            var studios = itemValues
                .Where(r => r.Type == ItemValueType.Studios)
                .Select(r => r.CleanValue)
                .Where(v => !string.IsNullOrWhiteSpace(v))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();
            var directors = itemPeople
                .Where(r => r.PersonType == nameof(PersonKind.Director))
                .Select(r => r.PeopleId)
                .Distinct()
                .ToList();
            var actors = itemPeople
                .Where(r => r.PersonType == nameof(PersonKind.Actor) || r.PersonType == nameof(PersonKind.GuestStar))
                .Select(r => r.PeopleId)
                .Distinct()
                .ToList();
            var writers = itemPeople
                .Where(r => r.PersonType == nameof(PersonKind.Writer))
                .Select(r => r.PeopleId)
                .Distinct()
                .ToList();
            var boxSets = boxSetsByItem[id].Select(r => r.BoxSetId).Distinct().ToList();
            baseById.TryGetValue(id, out var baseRow);
            var isSeries = seriesType is not null
                && baseRow?.Type is string itemType
                && string.Equals(itemType, seriesType, StringComparison.Ordinal);
            result[id] = new TasteCandidateFeatures(
                genres,
                tags,
                studios,
                directors,
                actors,
                baseRow?.CommunityRating,
                baseRow?.ProductionYear,
                baseRow?.RunTimeTicks,
                baseRow?.InheritedParentalRatingValue,
                isSeries,
                writers,
                boxSets,
                baseRow?.OriginalLanguage,
                SplitPipeValues(baseRow?.ProductionLocations));
        }

        return result;
    }
}
