#pragma warning disable RS0030 // Do not use banned APIs
#pragma warning disable CA1862 // Prefer StringComparison overloads — EF cannot translate them to SQL
#pragma warning disable CA1304 // string.ToLower() — EF translates to SQL lower()
#pragma warning disable CA1307 // string.Contains without StringComparison — required for EF translation
#pragma warning disable CA1310 // string.StartsWith without StringComparison — required for EF translation
#pragma warning disable CA1311 // culture-dependent ToLower — EF translates to SQL lower()

using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Extensions;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Model.Configuration;
using Microsoft.EntityFrameworkCore;

namespace Jellyfin.Plugin.Pgsql.Search;

/// <summary>
/// PostgreSQL-backed internal search provider using <c>pg_trgm</c> for typo-tolerant
/// title matching and <see cref="ItemValue"/> genre/tag lookups on the same search term.
/// </summary>
public sealed class PostgresFuzzySearchProvider : IInternalSearchProvider
{
    /// <summary>
    /// Minimum cleaned search-term length. Shorter queries return no results to protect
    /// the DB and UI from genre-expanded floods on 1–2 character input.
    /// </summary>
    public const int MinSearchTermLength = 3;

    private const int DefaultSearchLimit = 100;
    private const int MaxSearchLimit = 300;

    private const float ExactMatchScore = 100f;
    private const float PrefixMatchScore = 80f;
    private const float WordPrefixMatchScore = 75f;
    private const float TitleHighTrigramScore = 65f;
    private const float TitleTrigramScore = 55f;
    private const float ContainsMatchScore = 50f;
    private const float GenreExactScore = 45f;
    private const float GenrePrefixScore = 38f;
    private const float GenreContainsScore = 35f;

    private const float HighTrigramSimilarity = 0.5f;

    private static readonly Guid PlaceholderId = Guid.Parse("00000000-0000-0000-0000-000000000001");

    private readonly IDbContextFactory<JellyfinDbContext> _dbProvider;
    private readonly IItemTypeLookup _itemTypeLookup;
    private readonly ILibraryManager _libraryManager;
    private readonly IUserManager _userManager;
    private readonly IItemQueryHelpers _queryHelpers;

    /// <summary>
    /// Initializes a new instance of the <see cref="PostgresFuzzySearchProvider"/> class.
    /// </summary>
    /// <param name="dbProvider">The database context factory.</param>
    /// <param name="itemTypeLookup">The item type lookup.</param>
    /// <param name="libraryManager">The library manager.</param>
    /// <param name="userManager">The user manager.</param>
    /// <param name="queryHelpers">The shared item query helpers.</param>
    public PostgresFuzzySearchProvider(
        IDbContextFactory<JellyfinDbContext> dbProvider,
        IItemTypeLookup itemTypeLookup,
        ILibraryManager libraryManager,
        IUserManager userManager,
        IItemQueryHelpers queryHelpers)
    {
        _dbProvider = dbProvider;
        _itemTypeLookup = itemTypeLookup;
        _libraryManager = libraryManager;
        _userManager = userManager;
        _queryHelpers = queryHelpers;
    }

    /// <inheritdoc/>
    public string Name => "PostgreSQL Fuzzy";

    /// <inheritdoc/>
    public MetadataPluginType Type => MetadataPluginType.SearchProvider;

    /// <inheritdoc/>
    public int Priority => 10;

    /// <inheritdoc/>
    public bool CanSearch(SearchProviderQuery query)
    {
        ArgumentNullException.ThrowIfNull(query);
        if (string.IsNullOrWhiteSpace(query.SearchTerm))
        {
            return false;
        }

        var cleaned = NormalizeSearchTerm(query.SearchTerm);
        return cleaned.Length >= MinSearchTermLength;
    }

    /// <inheritdoc/>
    public async Task<IReadOnlyList<SearchResult>> SearchAsync(
        SearchProviderQuery query,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        ArgumentException.ThrowIfNullOrWhiteSpace(query.SearchTerm);

        var rawSearchTerm = query.SearchTerm.Trim().RemoveDiacritics();
        if (string.IsNullOrEmpty(rawSearchTerm))
        {
            return [];
        }

        var cleanSearchTerm = rawSearchTerm.GetCleanValue();
        if (string.IsNullOrEmpty(cleanSearchTerm) || cleanSearchTerm.Length < MinSearchTermLength)
        {
            return [];
        }

        var cleanPrefix = cleanSearchTerm + " ";
        var likeOriginal = $"%{rawSearchTerm}%";
        var allowMetadataTrigram = cleanSearchTerm.Length >= 4;
        var limit = Math.Clamp(query.Limit ?? DefaultSearchLimit, 1, MaxSearchLimit);

        var dbContext = await _dbProvider.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
        await using (dbContext.ConfigureAwait(false))
        {
            var dbQuery = dbContext.BaseItems
                .AsNoTracking()
                .Where(e => e.Id != PlaceholderId)
                .Where(e => !e.IsVirtualItem)
                .Where(e =>
                    e.CleanName!.Contains(cleanSearchTerm)
                    || (e.OriginalTitle != null && EF.Functions.ILike(e.OriginalTitle, likeOriginal))
                    || EF.Functions.TrigramsAreSimilar(e.CleanName!, cleanSearchTerm)
                    || EF.Functions.TrigramsAreWordSimilar(cleanSearchTerm, e.CleanName!)
                    || (e.OriginalTitle != null && (
                        EF.Functions.TrigramsAreSimilar(e.OriginalTitle.ToLower(), cleanSearchTerm)
                        || EF.Functions.TrigramsAreWordSimilar(cleanSearchTerm, e.OriginalTitle.ToLower())))
                    || e.ItemValues!.Any(ivm =>
                        (ivm.ItemValue.Type == ItemValueType.Genre || ivm.ItemValue.Type == ItemValueType.Tags)
                        && (ivm.ItemValue.CleanValue == cleanSearchTerm
                            || ivm.ItemValue.CleanValue.StartsWith(cleanSearchTerm)
                            || ivm.ItemValue.CleanValue.Contains(cleanSearchTerm)
                            || (allowMetadataTrigram && EF.Functions.TrigramsAreSimilar(ivm.ItemValue.CleanValue, cleanSearchTerm)))));

            dbQuery = ApplyTypeFilter(dbQuery, query.IncludeItemTypes, query.ExcludeItemTypes);
            dbQuery = ApplyMediaTypeFilter(dbQuery, query.MediaTypes);
            dbQuery = ApplyParentFilter(dbQuery, query.ParentId);
            dbQuery = ApplyUserAccessFilter(dbContext, dbQuery, query.UserId);

            // Score bands: title exact/prefix/trigram always beat genre/tag-only matches.
            var scored = dbQuery.Select(e => new
            {
                e.Id,
                Score =
                    e.CleanName == cleanSearchTerm ? ExactMatchScore
                    : e.CleanName!.StartsWith(cleanSearchTerm) ? PrefixMatchScore
                    : e.CleanName!.Contains(cleanPrefix) ? WordPrefixMatchScore
                    : EF.Functions.TrigramsSimilarity(e.CleanName!, cleanSearchTerm) >= HighTrigramSimilarity
                        ? TitleHighTrigramScore
                    : e.CleanName!.Contains(cleanSearchTerm)
                        || (e.OriginalTitle != null && EF.Functions.ILike(e.OriginalTitle, likeOriginal))
                            ? ContainsMatchScore
                    : EF.Functions.TrigramsAreSimilar(e.CleanName!, cleanSearchTerm)
                        || EF.Functions.TrigramsAreWordSimilar(cleanSearchTerm, e.CleanName!)
                        || (e.OriginalTitle != null && (
                            EF.Functions.TrigramsAreSimilar(e.OriginalTitle.ToLower(), cleanSearchTerm)
                            || EF.Functions.TrigramsAreWordSimilar(cleanSearchTerm, e.OriginalTitle.ToLower())))
                            ? TitleTrigramScore
                    : e.ItemValues!.Any(ivm =>
                        (ivm.ItemValue.Type == ItemValueType.Genre || ivm.ItemValue.Type == ItemValueType.Tags)
                        && ivm.ItemValue.CleanValue == cleanSearchTerm)
                            ? GenreExactScore
                    : e.ItemValues!.Any(ivm =>
                        (ivm.ItemValue.Type == ItemValueType.Genre || ivm.ItemValue.Type == ItemValueType.Tags)
                        && ivm.ItemValue.CleanValue.StartsWith(cleanSearchTerm))
                            ? GenrePrefixScore
                    : GenreContainsScore
            });

            return await scored
                .OrderByDescending(x => x.Score)
                .ThenBy(x => x.Id)
                .Take(limit)
                .Select(x => new SearchResult(x.Id, x.Score))
                .ToArrayAsync(cancellationToken)
                .ConfigureAwait(false);
        }
    }

    /// <summary>
    /// Normalizes a raw search term the same way search matching does.
    /// </summary>
    /// <param name="searchTerm">The raw search term.</param>
    /// <returns>The cleaned term, or an empty string when blank.</returns>
    public static string NormalizeSearchTerm(string searchTerm)
    {
        if (string.IsNullOrWhiteSpace(searchTerm))
        {
            return string.Empty;
        }

        var cleaned = searchTerm.Trim().RemoveDiacritics().GetCleanValue();
        return string.IsNullOrEmpty(cleaned) ? string.Empty : cleaned;
    }

    private IQueryable<BaseItemEntity> ApplyTypeFilter(
        IQueryable<BaseItemEntity> query,
        BaseItemKind[] includeItemTypes,
        BaseItemKind[] excludeItemTypes)
    {
        if (includeItemTypes.Length > 0)
        {
            var includeTypeNames = MapKindsToTypeNames(includeItemTypes);
            if (includeTypeNames.Count > 0)
            {
                query = query.Where(e => includeTypeNames.Contains(e.Type));
            }
        }
        else if (excludeItemTypes.Length > 0)
        {
            var excludeTypeNames = MapKindsToTypeNames(excludeItemTypes);
            if (excludeTypeNames.Count > 0)
            {
                query = query.Where(e => !excludeTypeNames.Contains(e.Type));
            }
        }

        return query;
    }

    private static IQueryable<BaseItemEntity> ApplyMediaTypeFilter(
        IQueryable<BaseItemEntity> query,
        MediaType[] mediaTypes)
    {
        if (mediaTypes.Length == 0)
        {
            return query;
        }

        var mediaTypeNames = mediaTypes.Select(m => m.ToString()).ToArray();
        return query.Where(e => e.MediaType != null && mediaTypeNames.Contains(e.MediaType));
    }

    private static IQueryable<BaseItemEntity> ApplyParentFilter(
        IQueryable<BaseItemEntity> query,
        Guid? parentId)
    {
        if (!parentId.HasValue || parentId.Value.IsEmpty())
        {
            return query;
        }

        var pid = parentId.Value;
        return query.Where(e => e.ParentId == pid || e.Parents!.Any(p => p.ParentItemId == pid));
    }

    private IQueryable<BaseItemEntity> ApplyUserAccessFilter(
        JellyfinDbContext dbContext,
        IQueryable<BaseItemEntity> query,
        Guid? userId)
    {
        if (!userId.HasValue || userId.Value.IsEmpty())
        {
            return query;
        }

        var user = _userManager.GetUserById(userId.Value);
        if (user is null)
        {
            return query;
        }

        var accessFilter = new InternalItemsQuery(user);
        _libraryManager.ConfigureUserAccess(accessFilter, user);
        return _queryHelpers.ApplyAccessFiltering(dbContext, query, accessFilter);
    }

    private List<string> MapKindsToTypeNames(BaseItemKind[] kinds)
    {
        var list = new List<string>(kinds.Length);
        foreach (var kind in kinds)
        {
            if (_itemTypeLookup.BaseItemKindNames.TryGetValue(kind, out var name) && name is not null)
            {
                list.Add(name);
            }
        }

        return list;
    }
}
