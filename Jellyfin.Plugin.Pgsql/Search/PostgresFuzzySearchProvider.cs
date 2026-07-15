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
using Microsoft.Extensions.Logging;

#pragma warning disable RS0030 // Do not use banned APIs
#pragma warning disable CA1862 // Prefer StringComparison overloads — EF cannot translate them to SQL
#pragma warning disable CA1304 // string.ToLower() — EF translates to SQL lower()
#pragma warning disable CA1307 // string.Contains without StringComparison — required for EF translation
#pragma warning disable CA1310 // string.StartsWith without StringComparison — required for EF translation
#pragma warning disable CA1311 // culture-dependent ToLower — EF translates to SQL lower()

namespace Jellyfin.Plugin.Pgsql.Search;

/// <summary>
/// PostgreSQL-backed internal search provider using token Levenshtein + word trigrams for
/// typo-tolerant titles, and genre/tag lookups on both <see cref="ItemValue"/> rows and
/// the denormalized Genres/Tags columns.
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

    // Title literal matches stay on top. Genre/tag exact must beat fuzzy title noise so
    // "Action" returns Action films instead of losing to weak trigram title hits.
    private const float ExactMatchScore = 100f;
    private const float PrefixMatchScore = 80f;
    private const float WordPrefixMatchScore = 75f;
    private const float GenreExactScore = 72f;
    private const float ContainsMatchScore = 68f;
    private const float GenreContainsScore = 64f;
    private const float TitleFuzzyScore = 55f;

    /// <summary>
    /// Whole-string trigram floor. Multi-word titles score poorly against a single typed word,
    /// so this alone is not enough — prefer <see cref="WordTrigramSimilarity"/>.
    /// </summary>
    private const float StrongTrigramSimilarity = 0.5f;

    /// <summary>
    /// Word-trigram floor (pg_trgm word_similarity). Needle "dispicable" vs haystack
    /// "despicable me" is ~0.64; keep this below that while rejecting near-miss noise
    /// like "backrooms" vs "bathrooms" (~0.50 against the full episode title).
    /// </summary>
    private const float WordTrigramSimilarity = 0.55f;

    private static readonly Guid PlaceholderId = Guid.Parse("00000000-0000-0000-0000-000000000001");

    private readonly IDbContextFactory<JellyfinDbContext> _dbProvider;
    private readonly IItemTypeLookup _itemTypeLookup;
    private readonly ILibraryManager _libraryManager;
    private readonly IUserManager _userManager;
    private readonly IItemQueryHelpers _queryHelpers;
    private readonly ILogger<PostgresFuzzySearchProvider> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="PostgresFuzzySearchProvider"/> class.
    /// </summary>
    /// <param name="dbProvider">The database context factory.</param>
    /// <param name="itemTypeLookup">The item type lookup.</param>
    /// <param name="libraryManager">The library manager.</param>
    /// <param name="userManager">The user manager.</param>
    /// <param name="queryHelpers">The shared item query helpers.</param>
    /// <param name="logger">The logger.</param>
    public PostgresFuzzySearchProvider(
        IDbContextFactory<JellyfinDbContext> dbProvider,
        IItemTypeLookup itemTypeLookup,
        ILibraryManager libraryManager,
        IUserManager userManager,
        IItemQueryHelpers queryHelpers,
        ILogger<PostgresFuzzySearchProvider> logger)
    {
        _dbProvider = dbProvider;
        _itemTypeLookup = itemTypeLookup;
        _libraryManager = libraryManager;
        _userManager = userManager;
        _queryHelpers = queryHelpers;
        _logger = logger;
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
    public async Task<SearchQueryResult> SearchAsync(
        SearchProviderQuery query,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(query);
        ArgumentException.ThrowIfNullOrWhiteSpace(query.SearchTerm);

        var rawSearchTerm = query.SearchTerm.Trim().RemoveDiacritics();
        if (string.IsNullOrEmpty(rawSearchTerm))
        {
            return SearchQueryResult.Empty;
        }

        var cleanSearchTerm = rawSearchTerm.GetCleanValue();
        if (string.IsNullOrEmpty(cleanSearchTerm) || cleanSearchTerm.Length < MinSearchTermLength)
        {
            return SearchQueryResult.Empty;
        }

        try
        {
            return await SearchCoreAsync(query, cleanSearchTerm, includeFuzzy: true, cancellationToken)
                .ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // Title-Contains path on ItemsController only helps literal title hits. If fuzzy
            // SQL fails to translate/execute we must still return genre/tag literal matches.
            _logger.LogWarning(
                ex,
                "Fuzzy operators failed for '{SearchTerm}'; retrying literal title/genre match only",
                cleanSearchTerm);

            return await SearchCoreAsync(query, cleanSearchTerm, includeFuzzy: false, cancellationToken)
                .ConfigureAwait(false);
        }
    }

    private async Task<SearchQueryResult> SearchCoreAsync(
        SearchProviderQuery query,
        string cleanSearchTerm,
        bool includeFuzzy,
        CancellationToken cancellationToken)
    {
        var cleanPrefix = cleanSearchTerm + " ";
        var likeClean = "%" + EscapeLikeLiteral(cleanSearchTerm) + "%";
        var maxEditDistance = GetMaxEditDistance(cleanSearchTerm.Length);
        var limit = Math.Clamp(query.Limit ?? DefaultSearchLimit, 1, MaxSearchLimit);
        var startIndex = Math.Max(query.StartIndex ?? 0, 0);

        var dbContext = await _dbProvider.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
        await using (dbContext.ConfigureAwait(false))
        {
            var dbQuery = dbContext.BaseItems
                .AsNoTracking()
                .Where(e => e.Id != PlaceholderId)
                .Where(e => !e.IsVirtualItem);

            // Build the match filter without embedding a CLR bool into the expression tree —
            // `includeFuzzy && sqlExpr` can still force EF to translate the fuzzy operators.
            if (includeFuzzy)
            {
                dbQuery = dbQuery.Where(e =>
                    e.CleanName!.Contains(cleanSearchTerm)
                    || (e.OriginalTitle != null && PgSearchDbFunctions.ILike(e.OriginalTitle, likeClean))
                    || e.ItemValues!.Any(ivm =>
                        (ivm.ItemValue.Type == ItemValueType.Genre || ivm.ItemValue.Type == ItemValueType.Tags)
                        && (ivm.ItemValue.CleanValue == cleanSearchTerm
                            || ivm.ItemValue.CleanValue.StartsWith(cleanSearchTerm)
                            || ivm.ItemValue.CleanValue.Contains(cleanSearchTerm)))
                    || (e.Genres != null && PgSearchDbFunctions.ILike(e.Genres, likeClean))
                    || (e.Tags != null && PgSearchDbFunctions.ILike(e.Tags, likeClean))
                    || PgSearchDbFunctions.TokenLevenshteinMatch(e.CleanName, cleanSearchTerm, maxEditDistance)
                    || (e.OriginalTitle != null
                        && PgSearchDbFunctions.TokenLevenshteinMatch(e.OriginalTitle, cleanSearchTerm, maxEditDistance))
                    || PgSearchDbFunctions.WordSimilarity(cleanSearchTerm, e.CleanName!) >= WordTrigramSimilarity
                    || (e.OriginalTitle != null
                        && PgSearchDbFunctions.WordSimilarity(cleanSearchTerm, e.OriginalTitle) >= WordTrigramSimilarity)
                    || PgSearchDbFunctions.TrigramSimilarity(e.CleanName!, cleanSearchTerm) >= StrongTrigramSimilarity
                    || e.ItemValues!.Any(ivm =>
                        (ivm.ItemValue.Type == ItemValueType.Genre || ivm.ItemValue.Type == ItemValueType.Tags)
                        && (PgSearchDbFunctions.TokenLevenshteinMatch(ivm.ItemValue.CleanValue, cleanSearchTerm, maxEditDistance)
                            || PgSearchDbFunctions.WordSimilarity(cleanSearchTerm, ivm.ItemValue.CleanValue) >= WordTrigramSimilarity)));
            }
            else
            {
                dbQuery = dbQuery.Where(e =>
                    e.CleanName!.Contains(cleanSearchTerm)
                    || (e.OriginalTitle != null && PgSearchDbFunctions.ILike(e.OriginalTitle, likeClean))
                    || e.ItemValues!.Any(ivm =>
                        (ivm.ItemValue.Type == ItemValueType.Genre || ivm.ItemValue.Type == ItemValueType.Tags)
                        && (ivm.ItemValue.CleanValue == cleanSearchTerm
                            || ivm.ItemValue.CleanValue.StartsWith(cleanSearchTerm)
                            || ivm.ItemValue.CleanValue.Contains(cleanSearchTerm)))
                    || (e.Genres != null && PgSearchDbFunctions.ILike(e.Genres, likeClean))
                    || (e.Tags != null && PgSearchDbFunctions.ILike(e.Tags, likeClean)));
            }

            dbQuery = ApplyTypeFilter(dbQuery, query.IncludeItemTypes, query.ExcludeItemTypes);
            dbQuery = ApplyMediaTypeFilter(dbQuery, query.MediaTypes);
            dbQuery = ApplyParentFilter(dbQuery, query.ParentId);
            dbQuery = ApplyUserAccessFilter(dbContext, dbQuery, query.UserId);

            var totalRecordCount = 0;
            if (query.EnableTotalRecordCount)
            {
                totalRecordCount = await dbQuery.CountAsync(cancellationToken).ConfigureAwait(false);
                if (totalRecordCount == 0)
                {
                    return SearchQueryResult.Empty;
                }
            }

            var scored = dbQuery.Select(e => new
            {
                e.Id,
                Score =
                    e.CleanName == cleanSearchTerm ? ExactMatchScore
                    : e.CleanName!.StartsWith(cleanSearchTerm) ? PrefixMatchScore
                    : e.CleanName!.Contains(cleanPrefix) ? WordPrefixMatchScore
                    : e.ItemValues!.Any(ivm =>
                        (ivm.ItemValue.Type == ItemValueType.Genre || ivm.ItemValue.Type == ItemValueType.Tags)
                        && ivm.ItemValue.CleanValue == cleanSearchTerm)
                      || (e.Genres != null && (
                          PgSearchDbFunctions.ILike(e.Genres, cleanSearchTerm)
                          || PgSearchDbFunctions.ILike(e.Genres, cleanSearchTerm + "|%")
                          || PgSearchDbFunctions.ILike(e.Genres, "%|" + cleanSearchTerm)
                          || PgSearchDbFunctions.ILike(e.Genres, "%|" + cleanSearchTerm + "|%")))
                      || (e.Tags != null && (
                          PgSearchDbFunctions.ILike(e.Tags, cleanSearchTerm)
                          || PgSearchDbFunctions.ILike(e.Tags, cleanSearchTerm + "|%")
                          || PgSearchDbFunctions.ILike(e.Tags, "%|" + cleanSearchTerm)
                          || PgSearchDbFunctions.ILike(e.Tags, "%|" + cleanSearchTerm + "|%")))
                            ? GenreExactScore
                    : e.CleanName!.Contains(cleanSearchTerm)
                        || (e.OriginalTitle != null && PgSearchDbFunctions.ILike(e.OriginalTitle, likeClean))
                            ? ContainsMatchScore
                    : e.ItemValues!.Any(ivm =>
                        (ivm.ItemValue.Type == ItemValueType.Genre || ivm.ItemValue.Type == ItemValueType.Tags)
                        && (ivm.ItemValue.CleanValue.StartsWith(cleanSearchTerm)
                            || ivm.ItemValue.CleanValue.Contains(cleanSearchTerm)))
                      || (e.Genres != null && PgSearchDbFunctions.ILike(e.Genres, likeClean))
                      || (e.Tags != null && PgSearchDbFunctions.ILike(e.Tags, likeClean))
                            ? GenreContainsScore
                    : TitleFuzzyScore
            });

            var rows = await scored
                .OrderByDescending(x => x.Score)
                .ThenBy(x => x.Id)
                .Skip(startIndex)
                .Take(limit)
                .Select(x => new { x.Id, x.Score })
                .ToArrayAsync(cancellationToken)
                .ConfigureAwait(false);

            if (!query.EnableTotalRecordCount)
            {
                totalRecordCount = startIndex + rows.Length;
            }

            var items = rows.Select(x => new SearchResult(x.Id, x.Score)).ToArray();
            return new SearchQueryResult(items, totalRecordCount);
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

    /// <summary>
    /// Escapes <c>%</c>, <c>_</c>, and <c>\</c> for use with EF <c>Like</c>/<c>ILike</c> escape clauses.
    /// </summary>
    /// <param name="value">Unescaped literal.</param>
    /// <returns>Escaped literal.</returns>
    public static string EscapeLikeLiteral(string value)
    {
        return value
            .Replace("\\", "\\\\", StringComparison.Ordinal)
            .Replace("%", "\\%", StringComparison.Ordinal)
            .Replace("_", "\\_", StringComparison.Ordinal);
    }

    /// <summary>
    /// Maximum token Levenshtein distance allowed for a cleaned search-term length.
    /// Short and mid-length needles allow one edit; only longer needles allow two.
    /// </summary>
    /// <param name="cleanedTermLength">Length of the cleaned search term.</param>
    /// <returns>Max edit distance.</returns>
    public static int GetMaxEditDistance(int cleanedTermLength)
        => cleanedTermLength <= 10 ? 1 : 2;

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
