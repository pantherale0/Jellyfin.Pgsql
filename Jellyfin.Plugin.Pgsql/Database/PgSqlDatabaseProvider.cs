using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.DbConfiguration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Configuration;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Npgsql;

namespace Jellyfin.Plugin.Pgsql.Database;

/// <summary>
/// Configures jellyfin to use an Postgres database.
/// </summary>
[JellyfinDatabaseProviderKey("Jellyfin-PgSql")]
public sealed class PgSqlDatabaseProvider : IJellyfinDatabaseProvider
{
    private readonly ILogger<PgSqlDatabaseProvider> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="PgSqlDatabaseProvider"/> class.
    /// </summary>
    /// <param name="logger">A logger.</param>
    public PgSqlDatabaseProvider(ILogger<PgSqlDatabaseProvider> logger)
    {
        _logger = logger;
    }

    /// <inheritdoc/>
    public IDbContextFactory<JellyfinDbContext>? DbContextFactory { get; set; }

    /// <inheritdoc/>
    public void Initialise(DbContextOptionsBuilder options)
    {
        // var dbSettings = _configurationManager.GetConfiguration<DatabaseConfigurationOptions>("database");
        // var customProviderOptions = dbSettings.CustomProviderOptions?.ConnectionString;

        // if (customProviderOptions is null)
        // {
        //     throw new InvalidOperationException("Selected PgSQL as database provider but did not provide required configuration. Please see docs.");
        // }

        var connectionBuilder = new NpgsqlConnectionStringBuilder("User ID=jellyfin;Password=jellyfin;Host=db;Port=5432;Database=Jellyfin;Pooling=true;");
        connectionBuilder.ApplicationName = $"jellyfin+{FileVersionInfo.GetVersionInfo(Assembly.GetEntryAssembly()!.Location).FileVersion}";
        // connectionBuilder.CommandTimeout = dbSettings.PostgreSql.Timeout;
        // connectionBuilder.Database = dbSettings.PostgreSql.DatabaseName;
        // connectionBuilder.Username = dbSettings.PostgreSql.Username;
        // connectionBuilder.Password = dbSettings.PostgreSql.Password;
        // connectionBuilder.Host = dbSettings.PostgreSql.ServerName;
        // connectionBuilder.Port = dbSettings.PostgreSql.Port;

        var connectionString = connectionBuilder.ToString();

        options
            .UseNpgsql(connectionString, pgSqlOptions => pgSqlOptions.MigrationsAssembly(GetType().Assembly));
    }

    /// <inheritdoc/>
    public Task RunScheduledOptimisation(CancellationToken cancellationToken)
    {
        return Task.CompletedTask;
    }

    /// <inheritdoc/>
    public void OnModelCreating(ModelBuilder modelBuilder)
    {
    }

    /// <inheritdoc/>
    public Task RunShutdownTask(CancellationToken cancellationToken)
    {
        return Task.CompletedTask;
    }

    /// <inheritdoc/>
    public void ConfigureConventions(ModelConfigurationBuilder configurationBuilder)
    {
    }

    /// <inheritdoc/>
    public Task<string> MigrationBackupFast(CancellationToken cancellationToken)
    {
        throw new System.NotImplementedException();
    }

    /// <inheritdoc/>
    public Task RestoreBackupFast(string key, CancellationToken cancellationToken)
    {
        throw new System.NotImplementedException();
    }

    /// <inheritdoc/>
    public Task DeleteBackup(string key)
    {
        throw new System.NotImplementedException();
    }

    /// <inheritdoc/>
    public Task PurgeDatabase(JellyfinDbContext dbContext, IEnumerable<string>? tableNames)
    {
        throw new System.NotImplementedException();
    }
}
