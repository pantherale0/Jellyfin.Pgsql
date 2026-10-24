using System;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.Pgsql.Database;
using Jellyfin.Plugin.Pgsql.Tests.Infrastructure;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Npgsql;
using Xunit;

namespace Jellyfin.Plugin.Pgsql.Tests.Database;

[Collection(PostgresCollection.Name)]
public sealed class PgSqlDatabaseProviderStatisticsTests
{
    private readonly PostgresDatabaseFixture _fixture;

    public PgSqlDatabaseProviderStatisticsTests(PostgresDatabaseFixture fixture)
    {
        _fixture = fixture;
    }

    [PostgresTestFact]
    public async Task RefreshStatistics_AnalyzesNewLibraryTables()
    {
        Assert.True(_fixture.IsAvailable, $"PostgreSQL fixture failed to initialize: {_fixture.InitializationError}");

        var tableName = "refresh_statistics_" + Guid.NewGuid().ToString("N");
        await using var connection = new NpgsqlConnection(_fixture.ConnectionString);
        await connection.OpenAsync(CancellationToken.None).ConfigureAwait(false);
        try
        {
            await using (var create = new NpgsqlCommand($"CREATE TABLE \"{tableName}\" (id integer)", connection))
            {
                await create.ExecuteNonQueryAsync(CancellationToken.None).ConfigureAwait(false);
            }

            await using (var seed = new NpgsqlCommand($"INSERT INTO \"{tableName}\" SELECT generate_series(1, 1000)", connection))
            {
                await seed.ExecuteNonQueryAsync(CancellationToken.None).ConfigureAwait(false);
            }

            await using (var analyze = new NpgsqlCommand($"ANALYZE \"{tableName}\"", connection))
            {
                await analyze.ExecuteNonQueryAsync(CancellationToken.None).ConfigureAwait(false);
            }

            var before = await ReadLastAnalyzeAsync(connection, tableName).ConfigureAwait(false);
            Assert.NotNull(before);

            var provider = new PgSqlDatabaseProvider(null!, NullLogger<PgSqlDatabaseProvider>.Instance)
            {
                DbContextFactory = new TestDbContextFactory(_fixture.ConnectionString)
            };

            await ((Jellyfin.Database.Implementations.IJellyfinDatabaseProvider)provider)
                .RefreshStatistics(CancellationToken.None)
                .ConfigureAwait(false);

            var after = await ReadLastAnalyzeAsync(connection, tableName).ConfigureAwait(false);
            Assert.True(after > before, $"Expected ANALYZE to advance from {before:O} to a later timestamp, got {after:O}.");
        }
        finally
        {
            await using var drop = new NpgsqlCommand($"DROP TABLE IF EXISTS \"{tableName}\"", connection);
            await drop.ExecuteNonQueryAsync(CancellationToken.None).ConfigureAwait(false);
        }
    }

    private static async Task<DateTime?> ReadLastAnalyzeAsync(NpgsqlConnection connection, string tableName)
    {
        await using var command = new NpgsqlCommand(
            "SELECT last_analyze FROM pg_stat_user_tables WHERE relname = @tableName",
            connection);
        command.Parameters.AddWithValue("tableName", tableName);
        var value = await command.ExecuteScalarAsync(CancellationToken.None).ConfigureAwait(false);
        return value is DateTime timestamp ? timestamp : null;
    }
}
