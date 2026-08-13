using System;
using Microsoft.Extensions.Logging;
using Npgsql;

namespace Jellyfin.Plugin.Pgsql.Database;

/// <summary>
/// PostgreSQL-specific compatibility helpers not covered by EF migrations alone.
/// </summary>
internal static class PostgreSqlCompat
{
    // Jellyfin groups library items with GroupBy(...).Min(e => e.Id). PostgreSQL has no min(uuid)/max(uuid).
    private const string EnsureUuidAggregatesSql = """
        CREATE OR REPLACE FUNCTION uuid_smaller(uuid, uuid)
        RETURNS uuid
        LANGUAGE sql
        IMMUTABLE
        PARALLEL SAFE
        STRICT
        RETURN (CASE WHEN $1 < $2 THEN $1 ELSE $2 END);

        CREATE OR REPLACE FUNCTION uuid_larger(uuid, uuid)
        RETURNS uuid
        LANGUAGE sql
        IMMUTABLE
        PARALLEL SAFE
        STRICT
        RETURN (CASE WHEN $1 > $2 THEN $1 ELSE $2 END);

        DO $compat$
        BEGIN
            IF NOT EXISTS (
                SELECT 1
                FROM pg_catalog.pg_proc p
                JOIN pg_catalog.pg_aggregate a ON a.aggfnoid = p.oid
                WHERE p.proname = 'min'
                  AND p.proargtypes[0] = 'uuid'::regtype::oid) THEN
                CREATE AGGREGATE min(uuid) (
                    SFUNC = uuid_smaller,
                    STYPE = uuid,
                    COMBINEFUNC = uuid_smaller,
                    SORTOP = <
                );
            END IF;

            IF NOT EXISTS (
                SELECT 1
                FROM pg_catalog.pg_proc p
                JOIN pg_catalog.pg_aggregate a ON a.aggfnoid = p.oid
                WHERE p.proname = 'max'
                  AND p.proargtypes[0] = 'uuid'::regtype::oid) THEN
                CREATE AGGREGATE max(uuid) (
                    SFUNC = uuid_larger,
                    STYPE = uuid,
                    COMBINEFUNC = uuid_larger,
                    SORTOP = >
                );
            END IF;
        END
        $compat$;
        """;

    private const string EnsureSearchSqlHelpersSql = """
        CREATE EXTENSION IF NOT EXISTS pg_trgm;

        -- Inlined to `ILIKE` so GIN/gist pg_trgm indexes on the haystack can be used.
        -- STRICT: NULL haystack returns NULL (false in WHERE) without coalesce wrapping.
        CREATE OR REPLACE FUNCTION jellyfin_ilike(haystack text, pattern text)
        RETURNS boolean
        LANGUAGE sql
        IMMUTABLE
        PARALLEL SAFE
        STRICT
        AS $func$
          SELECT haystack ILIKE pattern ESCAPE '\'
        $func$;

        -- Inlined to `<%` so GIN/gist pg_trgm indexes on the haystack can be used.
        -- Threshold comes from pg_trgm.word_similarity_threshold (set per transaction).
        CREATE OR REPLACE FUNCTION jellyfin_word_similar(needle text, haystack text)
        RETURNS boolean
        LANGUAGE sql
        IMMUTABLE
        PARALLEL SAFE
        STRICT
        AS $func$
          SELECT needle <% haystack
        $func$;
        """;

    public static void EnsureUuidAggregates(string connectionString, ILogger logger)
    {
        try
        {
            using var connection = new NpgsqlConnection(connectionString);
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = EnsureUuidAggregatesSql;
            command.ExecuteNonQuery();

            if (logger.IsEnabled(LogLevel.Debug))
            {
                logger.LogDebug("Ensured PostgreSQL min(uuid)/max(uuid) aggregates are available");
            }
        }
        catch (NpgsqlException ex)
        {
            if (logger.IsEnabled(LogLevel.Warning))
            {
                logger.LogWarning(ex, "Failed to ensure PostgreSQL uuid min/max aggregates");
            }
        }
    }

    /// <summary>
    /// Ensures ILIKE helper used by search/similar EF DbFunction mappings exists.
    /// </summary>
    /// <param name="connectionString">PostgreSQL connection string.</param>
    /// <param name="logger">Logger.</param>
    public static void EnsureSearchSqlHelpers(string connectionString, ILogger logger)
    {
        try
        {
            using var connection = new NpgsqlConnection(connectionString);
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = EnsureSearchSqlHelpersSql;
            command.ExecuteNonQuery();

            if (logger.IsEnabled(LogLevel.Debug))
            {
                logger.LogDebug("Ensured PostgreSQL search SQL helpers (jellyfin_ilike, jellyfin_word_similar, pg_trgm) are available");
            }
        }
        catch (NpgsqlException ex)
        {
            if (logger.IsEnabled(LogLevel.Warning))
            {
                logger.LogWarning(ex, "Failed to ensure PostgreSQL search SQL helpers");
            }
        }
    }
}
