using System;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Plugin.Pgsql.Database;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.Logging.Abstractions;

namespace Jellyfin.Plugin.Pgsql.Tests.Infrastructure;

internal sealed class TestDbContextFactory : IDbContextFactory<JellyfinDbContext>
{
    private readonly DbContextOptions<JellyfinDbContext> _options;
    private readonly PgSqlDatabaseProvider _provider;

    public TestDbContextFactory(string connectionString)
    {
        var optionsBuilder = new DbContextOptionsBuilder<JellyfinDbContext>();
        optionsBuilder.UseNpgsql(connectionString, npgsqlOptions =>
        {
            npgsqlOptions.MigrationsAssembly(typeof(PgSqlDatabaseProvider).Assembly.GetName().Name);
        })
        .ConfigureWarnings(w => w.Ignore(RelationalEventId.PendingModelChangesWarning));

        _provider = new PgSqlDatabaseProvider(null!, NullLogger<PgSqlDatabaseProvider>.Instance);
        // EnsureSearchSqlHelpers runs during PgSqlDatabaseProvider.Initialise in production;
        // invoke the same SQL here so mapped jellyfin_ilike exists before MigrateAsync.
        using (var connection = new Npgsql.NpgsqlConnection(connectionString))
        {
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = """
                CREATE EXTENSION IF NOT EXISTS pg_trgm;
                CREATE OR REPLACE FUNCTION jellyfin_ilike(haystack text, pattern text)
                RETURNS boolean
                LANGUAGE sql
                IMMUTABLE
                PARALLEL SAFE
                STRICT
                AS $func$
                  SELECT haystack ILIKE pattern ESCAPE '\'
                $func$;
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
            command.ExecuteNonQuery();
        }

        _options = optionsBuilder.Options;
    }

    public JellyfinDbContext CreateDbContext()
    {
        return new JellyfinDbContext(
            _options,
            NullLogger<JellyfinDbContext>.Instance,
            _provider,
            new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
    }

    public Task<JellyfinDbContext> CreateDbContextAsync(CancellationToken cancellationToken = default)
    {
        return Task.FromResult(CreateDbContext());
    }
}
