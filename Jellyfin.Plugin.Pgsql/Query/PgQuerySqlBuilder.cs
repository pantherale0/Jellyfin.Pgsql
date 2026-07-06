using System;
using System.Collections.Generic;
using System.Data;
using System.Data.Common;
using System.Linq;
using Jellyfin.Database.Implementations;
using Microsoft.EntityFrameworkCore;

namespace Jellyfin.Plugin.Pgsql.Query;

/// <summary>
/// Executes PostgreSQL-specific SQL that wraps an EF Core query as a subquery.
/// The inner query's SQL text and bound parameters are extracted via
/// <c>RelationalQueryableExtensions.CreateDbCommand</c>, which keeps parameter binding
/// intact (unlike parsing <c>ToQueryString()</c> output).
/// </summary>
internal static class PgQuerySqlBuilder
{
    /// <summary>
    /// The placeholder in outer SQL templates that is replaced with the inner query's SQL.
    /// </summary>
    public const string InnerQueryPlaceholder = "/*INNER*/";

    /// <summary>
    /// Executes an outer SQL statement wrapping <paramref name="innerQuery"/> and maps each result row.
    /// </summary>
    /// <typeparam name="TInner">The inner query element type.</typeparam>
    /// <typeparam name="TResult">The mapped row type.</typeparam>
    /// <param name="context">The database context providing the connection.</param>
    /// <param name="innerQuery">The EF query to embed as a subquery.</param>
    /// <param name="outerSqlTemplate">Outer SQL containing <see cref="InnerQueryPlaceholder"/>.</param>
    /// <param name="extraParameters">Additional parameters (names must not collide with EF's <c>@__</c> prefix).</param>
    /// <param name="mapRow">Maps a data record to a result element.</param>
    /// <returns>The mapped rows.</returns>
    public static List<TResult> ExecuteWrapped<TInner, TResult>(
        JellyfinDbContext context,
        IQueryable<TInner> innerQuery,
        string outerSqlTemplate,
        IReadOnlyDictionary<string, object> extraParameters,
        Func<DbDataReader, TResult> mapRow)
    {
        using var innerCommand = innerQuery.CreateDbCommand();
        var sql = outerSqlTemplate.Replace(InnerQueryPlaceholder, innerCommand.CommandText, StringComparison.Ordinal);

        var connection = context.Database.GetDbConnection();
        var wasOpen = connection.State == ConnectionState.Open;
        if (!wasOpen)
        {
            context.Database.OpenConnection();
        }

        try
        {
            using var command = connection.CreateCommand();
#pragma warning disable CA2100 // SQL is composed from EF-generated text and compile-time templates; values are parameterized.
            command.CommandText = sql;
#pragma warning restore CA2100
            var commandTimeout = context.Database.GetCommandTimeout();
            if (commandTimeout.HasValue)
            {
                command.CommandTimeout = commandTimeout.Value;
            }

            foreach (DbParameter parameter in innerCommand.Parameters)
            {
                // NpgsqlParameter implements ICloneable; cloning preserves provider-specific
                // type info (e.g. array parameters) that a plain DbType copy would lose.
                var clone = parameter is ICloneable cloneable
                    ? (DbParameter)cloneable.Clone()
                    : CopyParameter(command, parameter);
                command.Parameters.Add(clone);
            }

            foreach (var (name, value) in extraParameters)
            {
                var extra = command.CreateParameter();
                extra.ParameterName = name;
                extra.Value = value;
                command.Parameters.Add(extra);
            }

            var results = new List<TResult>();
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                results.Add(mapRow(reader));
            }

            return results;
        }
        finally
        {
            if (!wasOpen)
            {
                context.Database.CloseConnection();
            }
        }
    }

    private static DbParameter CopyParameter(DbCommand command, DbParameter source)
    {
        var copy = command.CreateParameter();
        copy.ParameterName = source.ParameterName;
        copy.Value = source.Value;
        copy.DbType = source.DbType;
        return copy;
    }
}
