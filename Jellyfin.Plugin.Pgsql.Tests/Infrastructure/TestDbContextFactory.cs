using System;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Locking;
using Jellyfin.Plugin.Pgsql.Database;
using Microsoft.EntityFrameworkCore;
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
        });

        _provider = new PgSqlDatabaseProvider(null!, NullLogger<PgSqlDatabaseProvider>.Instance);
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
