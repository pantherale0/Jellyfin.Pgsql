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
}
