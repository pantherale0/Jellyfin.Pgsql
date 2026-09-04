using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;

namespace Jellyfin.Plugin.Pgsql.Query;

/// <summary>
/// Builds stable, per-user cache keys from <see cref="InternalItemsQuery"/> instances.
/// Every field that changes the result set (or its order) must be part of the key;
/// fields that only affect how items are loaded (e.g. DtoOptions) are excluded because
/// cached entries store IDs and items are re-loaded with the live filter.
/// </summary>
internal static class QueryCacheKeyBuilder
{
    /// <summary>
    /// Builds a cache key for a Latest items query.
    /// </summary>
    /// <param name="filter">The query filter.</param>
    /// <param name="collectionType">The collection type.</param>
    /// <param name="libraryVersion">Library-wide cache generation.</param>
    /// <param name="userVersion">Per-user cache generation.</param>
    /// <returns>The cache key, or <c>null</c> when the query cannot be safely keyed.</returns>
    public static string? BuildLatestKey(
        InternalItemsQuery filter,
        CollectionType collectionType,
        long libraryVersion,
        long userVersion)
    {
        var canonical = BuildCanonical(filter);
        if (canonical is null)
        {
            return null;
        }

        return string.Create(
            CultureInfo.InvariantCulture,
            $"lv{libraryVersion}:uv{userVersion}:latest:{collectionType}:{Hash(canonical)}");
    }

    /// <summary>
    /// Builds a cache key for a Resume (IsResumable) item list query.
    /// </summary>
    /// <param name="filter">The query filter.</param>
    /// <param name="libraryVersion">Library-wide cache generation.</param>
    /// <param name="userVersion">Per-user cache generation.</param>
    /// <returns>The cache key, or <c>null</c> when the query cannot be safely keyed.</returns>
    public static string? BuildResumeKey(InternalItemsQuery filter, long libraryVersion, long userVersion)
    {
        var canonical = BuildCanonical(filter);
        if (canonical is null)
        {
            return null;
        }

        return string.Create(
            CultureInfo.InvariantCulture,
            $"lv{libraryVersion}:uv{userVersion}:resume:{Hash(canonical)}");
    }

    /// <summary>
    /// Builds a cache key for a NextUp series-key query.
    /// </summary>
    /// <param name="filter">The query filter.</param>
    /// <param name="dateCutoff">The next-up date cutoff.</param>
    /// <param name="libraryVersion">Library-wide cache generation.</param>
    /// <param name="userVersion">Per-user cache generation.</param>
    /// <returns>The cache key, or <c>null</c> when the query cannot be safely keyed.</returns>
    public static string? BuildNextUpSeriesKeysKey(
        InternalItemsQuery filter,
        DateTime dateCutoff,
        long libraryVersion,
        long userVersion)
    {
        var canonical = BuildCanonical(filter);
        if (canonical is null)
        {
            return null;
        }

        return string.Create(
            CultureInfo.InvariantCulture,
            $"lv{libraryVersion}:uv{userVersion}:nextup-keys:{dateCutoff.Ticks}:{Hash(canonical)}");
    }

    /// <summary>
    /// Builds a cache key for a NextUp batch query.
    /// </summary>
    /// <param name="filter">The query filter.</param>
    /// <param name="seriesKeys">The series keys.</param>
    /// <param name="includeSpecials">Whether specials are included.</param>
    /// <param name="includeWatchedForRewatching">Whether rewatching mode is enabled.</param>
    /// <param name="libraryVersion">Library-wide cache generation.</param>
    /// <param name="userVersion">Per-user cache generation.</param>
    /// <returns>The cache key, or <c>null</c> when the query cannot be safely keyed.</returns>
    public static string? BuildNextUpBatchKey(
        InternalItemsQuery filter,
        IReadOnlyList<string> seriesKeys,
        bool includeSpecials,
        bool includeWatchedForRewatching,
        long libraryVersion,
        long userVersion)
    {
        var canonical = BuildCanonical(filter);
        if (canonical is null)
        {
            return null;
        }

        var keys = string.Join(',', seriesKeys.OrderBy(k => k, StringComparer.Ordinal));
        return string.Create(
            CultureInfo.InvariantCulture,
            $"lv{libraryVersion}:uv{userVersion}:nextup-batch:{includeSpecials}:{includeWatchedForRewatching}:{Hash(canonical + '|' + keys)}");
    }

    /// <summary>
    /// Builds a cache key for a stable library browse <c>GetItems</c> page.
    /// </summary>
    /// <param name="filter">The query filter.</param>
    /// <param name="libraryVersion">Library-wide cache generation.</param>
    /// <param name="userVersion">Per-user cache generation.</param>
    /// <returns>The cache key, or <c>null</c> when the query cannot be safely keyed.</returns>
    public static string? BuildBrowseKey(InternalItemsQuery filter, long libraryVersion, long userVersion)
    {
        if (!IsBrowsableCacheable(filter))
        {
            return null;
        }

        var canonical = BuildCanonical(filter);
        if (canonical is null)
        {
            return null;
        }

        return string.Create(
            CultureInfo.InvariantCulture,
            $"lv{libraryVersion}:uv{userVersion}:browse:{Hash(canonical)}");
    }

    /// <summary>
    /// Returns whether a filter is a stable library browse page worth caching.
    /// </summary>
    private static bool IsBrowsableCacheable(InternalItemsQuery filter)
    {
        if (filter.User is null || !filter.Limit.HasValue)
        {
            return false;
        }

        if (filter.IsResumable == true)
        {
            return false;
        }

        if (filter.OrderBy.Any(o => o.OrderBy == ItemSortBy.Random))
        {
            return false;
        }

        // Need a library/folder scope (set after SetTopParentIdsOrAncestors, or a direct ParentId).
        if (filter.TopParentIds.Length == 0
            && filter.AncestorIds.Length == 0
            && filter.ParentId.Equals(default))
        {
            return false;
        }

        return true;
    }

    /// <summary>
    /// Resolves the user id used for version stamps from a filter, or <see cref="Guid.Empty"/> when anonymous.
    /// </summary>
    /// <param name="filter">The query filter.</param>
    /// <returns>The user id.</returns>
    public static Guid GetVersionUserId(InternalItemsQuery filter) => filter.User?.Id ?? Guid.Empty;

    private static string? BuildCanonical(InternalItemsQuery filter)
    {
        // Queries with a search term are too dynamic to be worth caching.
        if (!string.IsNullOrEmpty(filter.SearchTerm) || !string.IsNullOrEmpty(filter.NameContains))
        {
            return null;
        }

        var builder = new StringBuilder(256);
        builder.Append(filter.User?.Id.ToString() ?? "-")
            .Append('|').Append(filter.User?.HidePlayedInLatest == true ? '1' : '0')
            .Append('|').Append(filter.Limit?.ToString(CultureInfo.InvariantCulture) ?? "-")
            .Append('|').Append(filter.StartIndex?.ToString(CultureInfo.InvariantCulture) ?? "-")
            .Append('|').Append(filter.ParentId)
            .Append('|').Append(filter.Recursive ? '1' : '0')
            .Append('|').Append(Flag(filter.IsPlayed))
            .Append('|').Append(Flag(filter.IsResumable))
            .Append('|').Append(Flag(filter.IsFolder))
            .Append('|').Append(Flag(filter.IsVirtualItem))
            .Append('|').Append(filter.GroupByPresentationUniqueKey ? '1' : '0')
            .Append('|').Append(filter.GroupBySeriesPresentationUniqueKey ? '1' : '0')
            .Append('|').Append(filter.EnableGroupByMetadataKey ? '1' : '0')
            .Append('|').Append(Flag(filter.CollapseBoxSetItems));

        AppendGuids(builder, filter.TopParentIds);
        AppendGuids(builder, filter.AncestorIds);
        AppendGuids(builder, filter.ItemIds);
        AppendGuids(builder, filter.ExcludeItemIds);

        builder.Append('|');
        foreach (var kind in filter.IncludeItemTypes.OrderBy(k => k))
        {
            builder.Append((int)kind).Append(',');
        }

        builder.Append('|');
        foreach (var kind in filter.ExcludeItemTypes.OrderBy(k => k))
        {
            builder.Append((int)kind).Append(',');
        }

        builder.Append('|');
        foreach (var mediaType in filter.MediaTypes.OrderBy(m => m))
        {
            builder.Append((int)mediaType).Append(',');
        }

        builder.Append('|');
        foreach (var (orderBy, sortOrder) in filter.OrderBy)
        {
            builder.Append((int)orderBy).Append(':').Append((int)sortOrder).Append(',');
        }

        return builder.ToString();
    }

    private static char Flag(bool? value)
    {
        if (!value.HasValue)
        {
            return '-';
        }

        return value.Value ? '1' : '0';
    }

    private static void AppendGuids(StringBuilder builder, Guid[] ids)
    {
        builder.Append('|');
        if (ids.Length == 0)
        {
            return;
        }

        foreach (var id in ids.OrderBy(g => g))
        {
            builder.Append(id.ToString("N")).Append(',');
        }
    }

    private static string Hash(string canonical)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(canonical));
        return Convert.ToHexStringLower(hash.AsSpan(0, 16));
    }
}
