using System;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Locking;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Jellyfin.Plugin.Pgsql.Database;

/// <summary>
/// The design time factory for <see cref="JellyfinDbContext"/>.
/// This is only used for the creation of migrations and not during runtime.
/// </summary>
internal sealed class PgSqlDesignTimeJellyfinDbFactory : IDesignTimeDbContextFactory<JellyfinDbContext>
{
    public JellyfinDbContext CreateDbContext(string[] args)
    {
        var connectionString = Environment.GetEnvironmentVariable("ConnectionStrings__Default")
            ?? "Host=localhost;Port=5432;Database=jellyfin;Username=jellyfin;Password=jellyfin";

        var optionsBuilder = new DbContextOptionsBuilder<JellyfinDbContext>();
        optionsBuilder
            .UseNpgsql(connectionString, f => f.MigrationsAssembly(GetType().Assembly))
            .ConfigureWarnings(w => w.Ignore(RelationalEventId.PendingModelChangesWarning));

        return new JellyfinDbContext(
            optionsBuilder.Options,
            NullLogger<JellyfinDbContext>.Instance,
            new PgSqlDatabaseProvider(null!, NullLogger<PgSqlDatabaseProvider>.Instance),
            new NoLockBehavior(NullLogger<NoLockBehavior>.Instance));
    }
}
