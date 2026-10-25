using System;
using System.Collections.Generic;
using System.Data.Common;
using System.Linq;
using Jellyfin.Database.Implementations;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Model.Querying;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Pgsql.Query;

/// <summary>
/// Selects Resume pages from a user's in-progress items rather than the video library.
/// </summary>
internal sealed class PgResumeQuery(
    IDbContextFactory<JellyfinDbContext> dbProvider,
    IItemQueryHelpers queryHelpers,
    CachedItemLoader loader,
    PgsqlQueryOptions options,
    ILogger<PgResumeQuery> logger)
{
    private const string SelectionSql = """
        WITH progress AS MATERIALIZED (
            SELECT ud."ItemId", MAX(ud."LastPlayedDate") AS "LastPlayedDate"
            FROM "UserData" ud
            WHERE ud."UserId" = @pgsql_resume_user AND ud."PlaybackPositionTicks" > 0
            GROUP BY ud."ItemId"
        ), candidates AS MATERIALIZED (
            SELECT b."Id", b."PrimaryVersionId", b."IsFolder", b."SortName", pr."LastPlayedDate"
            FROM progress pr
            -- Retain per-progress key lookups even when a small library makes a hash scan look cheaper.
            JOIN LATERAL (
                SELECT item."Id", item."PrimaryVersionId", item."IsFolder", item."SortName"
                FROM "BaseItems" item WHERE item."Id" = pr."ItemId" OFFSET 0
            ) b ON TRUE
        ), guard AS (
            SELECT EXISTS(
                SELECT 1
                FROM candidates folder
                JOIN LATERAL (
                    SELECT filtered."Id" FROM (/*INNER*/) filtered
                    WHERE filtered."Id" = folder."Id" OFFSET 0
                ) permitted ON TRUE
                WHERE folder."IsFolder"
            ) AS "RequiresCore"
        ), eligible AS MATERIALIZED (
            SELECT c."Id", c."SortName", c."LastPlayedDate"
            FROM candidates c
            JOIN LATERAL (
                SELECT filtered."Id" FROM (/*INNER*/) filtered
                WHERE filtered."Id" = c."Id" OFFSET 0
            ) permitted ON TRUE
            WHERE NOT c."IsFolder"
              AND NOT (SELECT "RequiresCore" FROM guard)
              AND NOT EXISTS (
                  SELECT 1 FROM candidates sibling
                  WHERE sibling."Id" <> c."Id"
                    AND COALESCE(sibling."PrimaryVersionId", sibling."Id")
                        = COALESCE(c."PrimaryVersionId", c."Id")
                    AND (
                        sibling."LastPlayedDate" > c."LastPlayedDate"
                        OR (sibling."LastPlayedDate" IS NOT DISTINCT FROM c."LastPlayedDate"
                            AND sibling."Id" < c."Id")
                    )
              )
        ), page AS (
            SELECT "Id", "SortName", "LastPlayedDate"
            FROM eligible
            ORDER BY "LastPlayedDate" DESC, "SortName", "Id"
            LIMIT NULLIF(@pgsql_resume_limit, -1) OFFSET @pgsql_resume_offset
        )
        SELECT guard."RequiresCore",
               CASE WHEN @pgsql_resume_count AND NOT guard."RequiresCore"
                    THEN (SELECT COUNT(*)::integer FROM eligible) END AS "TotalRecordCount",
               page."Id"
        FROM guard LEFT JOIN page ON TRUE
        ORDER BY page."LastPlayedDate" DESC, page."SortName", page."Id"
        """;

    /// <summary>Attempts an optimized page, returning null when core should handle the request.</summary>
    /// <param name="filter">The original request.</param>
    /// <returns>A hydrated page, including successful empty pages, or null for fallback.</returns>
    public QueryResult<BaseItem>? TryGetItems(InternalItemsQuery filter)
    {
        if (!options.OptimizeResume || !ResumeQueryFilter.TryCreate(filter, out var translated))
        {
            return null;
        }

        return QueryFallback.TryDatabase(
            () => Execute(filter, translated),
            logger,
            "PostgreSQL Resume selection failed; falling back to core implementation");
    }

    /// <summary>Builds the same bound selector used for execution and plan verification.</summary>
    /// <param name="context">The selector context.</param>
    /// <param name="source">The original supported request.</param>
    /// <param name="translatedFilter">Its independent core filter.</param>
    /// <returns>A bound command owned by the caller.</returns>
    internal DbCommand CreateSelectionCommand(JellyfinDbContext context, InternalItemsQuery source, InternalItemsQuery translatedFilter)
    {
        var inner = queryHelpers.PrepareItemQuery(context, translatedFilter);
        inner = queryHelpers.TranslateQuery(inner, context, translatedFilter);
        var parameters = new Dictionary<string, object>
        {
            ["pgsql_resume_user"] = source.User!.Id,
            ["pgsql_resume_limit"] = source.Limit ?? -1,
            ["pgsql_resume_offset"] = source.StartIndex ?? 0,
            ["pgsql_resume_count"] = source.EnableTotalRecordCount,
        };
        return PgQuerySqlBuilder.CreateWrappedCommand(context, inner.Select(e => new { e.Id }), SelectionSql, parameters);
    }

    private QueryResult<BaseItem>? Execute(InternalItemsQuery source, InternalItemsQuery translated)
    {
        using var context = dbProvider.CreateDbContext();
        using var command = CreateSelectionCommand(context, source, translated);
        var rows = PgQuerySqlBuilder.Execute(context, command, reader => (
            RequiresCore: reader.GetBoolean(0),
            Total: reader.IsDBNull(1) ? (int?)null : reader.GetInt32(1),
            Id: reader.IsDBNull(2) ? (Guid?)null : reader.GetGuid(2)));
        if (rows[0].RequiresCore)
        {
            return null;
        }

        var ids = rows.Where(r => r.Id.HasValue).Select(r => r.Id!.Value).ToArray();
        var items = loader.LoadByIds(ids, source);
        return items is null ? null : new QueryResult<BaseItem>(source.StartIndex, rows[0].Total, items);
    }
}
