using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.DbConfiguration;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Configuration;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.Logging;
using Npgsql;

namespace Jellyfin.Plugin.Pgsql.Database;

/// <summary>
/// Configures jellyfin to use an Postgres database.
/// </summary>
[JellyfinDatabaseProviderKey("Jellyfin-PgSql")]
public sealed class PgSqlDatabaseProvider : IJellyfinDatabaseProvider
{
    private const string BackupFolderName = "PgsqlBackups";
    private readonly ILogger<PgSqlDatabaseProvider> _logger;
    private readonly IApplicationPaths _applicationPaths;

    /// <summary>
    /// Initializes a new instance of the <see cref="PgSqlDatabaseProvider"/> class.
    /// </summary>
    /// <param name="applicationPaths">Service to construct the backup paths.</param>
    /// <param name="logger">A logger.</param>
    public PgSqlDatabaseProvider(IApplicationPaths applicationPaths, ILogger<PgSqlDatabaseProvider> logger)
    {
        _applicationPaths = applicationPaths;
        _logger = logger;
    }

    /// <inheritdoc/>
    public IDbContextFactory<JellyfinDbContext>? DbContextFactory { get; set; }

    /// <inheritdoc/>
    public void Initialise(DbContextOptionsBuilder options, DatabaseConfigurationOptions databaseConfiguration)
    {
        var customOptions = databaseConfiguration.CustomProviderOptions?.Options;

        var connectionBuilder = GetConnectionBuilder(customOptions);
        connectionBuilder.ApplicationName = $"jellyfin+{FileVersionInfo.GetVersionInfo(Assembly.GetEntryAssembly()!.Location).FileVersion}";

        options
            .UseNpgsql(connectionBuilder.ToString(), pgSqlOptions =>
            {
                pgSqlOptions.MigrationsAssembly(GetType().Assembly.FullName);
            })
            .ConfigureWarnings(w => w.Ignore(RelationalEventId.PendingModelChangesWarning));

        PostgreSqlCompat.EnsureUuidAggregates(connectionBuilder.ToString(), _logger);
        PostgreSqlCompat.EnsureSearchSqlHelpers(connectionBuilder.ToString(), _logger);

        var enableSensitiveDataLogging = GetCustomDatabaseOption(customOptions, "EnableSensitiveDataLogging", e => e.Equals(bool.TrueString, StringComparison.OrdinalIgnoreCase), () => false);
        if (enableSensitiveDataLogging)
        {
            options.EnableSensitiveDataLogging(enableSensitiveDataLogging);
            if (_logger.IsEnabled(LogLevel.Information))
            {
                _logger.LogInformation("EnableSensitiveDataLogging is enabled on PostgreSQL connection");
            }
        }
    }

    /// <inheritdoc/>
    public async Task RunScheduledOptimisation(CancellationToken cancellationToken)
    {
        if (DbContextFactory is null)
        {
            return;
        }

        var context = await DbContextFactory.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
        await using (context.ConfigureAwait(false))
        {
            if (context.Database.IsNpgsql())
            {
                await context.Database.ExecuteSqlRawAsync("VACUUM ANALYZE", cancellationToken).ConfigureAwait(false);
                if (_logger.IsEnabled(LogLevel.Information))
                {
                    _logger.LogInformation("PostgreSQL database optimized successfully");
                }
            }
        }
    }

    /// <inheritdoc/>
    public void OnModelCreating(ModelBuilder modelBuilder)
    {
        // Use C collation for consistent case-sensitive behavior matching SQLite BINARY
        modelBuilder.UseCollation("C");

        // Configure all DateTime properties to ensure UTC for PostgreSQL compatibility, matching SQLite provider
        foreach (var entityType in modelBuilder.Model.GetEntityTypes())
        {
            foreach (var property in entityType.GetProperties().Where(p =>
                p.ClrType == typeof(DateTime) || p.ClrType == typeof(DateTime?)))
            {
                property.SetValueConverter(
                    new Microsoft.EntityFrameworkCore.Storage.ValueConversion.ValueConverter<DateTime, DateTime>(
                        v => v.ToUniversalTime(),
                        v => DateTime.SpecifyKind(v, DateTimeKind.Utc)));
            }
        }

        // Jellyfin entity configs use SQLite-style [Column] filter syntax; PostgreSQL needs quoted identifiers.
        foreach (var entityType in modelBuilder.Model.GetEntityTypes())
        {
            foreach (var index in entityType.GetIndexes())
            {
                var filter = index.GetFilter();
                if (filter is not null && filter.Contains('[', StringComparison.Ordinal))
                {
                    index.SetFilter(Regex.Replace(filter, @"\[(\w+)\]", "\"$1\""));
                }
            }
        }

        modelBuilder.Entity<PlaybackActivity>(entity =>
        {
            entity.HasOne(e => e.User)
                .WithMany()
                .HasForeignKey(e => e.UserId)
                .OnDelete(DeleteBehavior.Cascade);

            entity.HasOne(e => e.Device)
                .WithMany()
                .HasForeignKey(e => e.DeviceId)
                .OnDelete(DeleteBehavior.SetNull);

            entity.HasIndex(e => new { e.UserId, e.DatePlayed });
            entity.HasIndex(e => new { e.ItemId, e.DatePlayed });
            entity.HasIndex(e => e.DatePlayed);
            entity.HasIndex(e => new { e.DatePlayed, e.PlayMethod });
            entity.HasIndex(e => e.DeviceId)
                .HasFilter("\"DeviceId\" IS NOT NULL");
            entity.HasIndex(e => new { e.ChannelId, e.DatePlayed })
                .HasFilter("\"ChannelId\" IS NOT NULL");
        });

        modelBuilder.Entity<PlaybackActivityDaily>(entity =>
        {
            entity.ToTable("PlaybackActivityDaily");
            entity.HasKey(e => e.Date);
        });

        modelBuilder.Entity<UserTasteProfile>(entity =>
        {
            entity.ToTable("UserTasteProfiles");
            entity.HasKey(e => e.UserId);
            entity.Property(e => e.FeaturesJson).IsRequired();
        });

        modelBuilder.Entity<TasteModelEvalRun>(entity =>
        {
            entity.ToTable("TasteModelEvalRuns");
            entity.HasKey(e => e.Id);
            entity.HasIndex(e => e.CreatedAt);
        });

        modelBuilder.Entity<UserTasteRecommendation>(entity =>
        {
            entity.ToTable("UserTasteRecommendations");
            entity.HasKey(e => new { e.UserId, e.ItemType, e.Rank });
            entity.Property(e => e.ItemType).IsRequired();
            entity.Property(e => e.Tier).IsRequired();
            entity.HasIndex(e => new { e.UserId, e.ItemType });
        });

        modelBuilder.Entity<UserTasteRecommendationImpression>(entity =>
        {
            entity.ToTable("UserTasteRecommendationImpressions");
            entity.HasKey(e => e.Id);
            entity.Property(e => e.ItemType).IsRequired();
            entity.HasIndex(e => new { e.UserId, e.ItemId, e.ServedAt });
            entity.HasIndex(e => new { e.UserId, e.ServedAt });
        });

        var tokenMatch = typeof(Jellyfin.Plugin.Pgsql.Search.PgSearchDbFunctions)
            .GetMethod(
                nameof(Jellyfin.Plugin.Pgsql.Search.PgSearchDbFunctions.TokenLevenshteinMatch),
                [typeof(string), typeof(string), typeof(int)]);
        if (tokenMatch is not null)
        {
            modelBuilder.HasDbFunction(tokenMatch)
                .HasName("jellyfin_token_levenshtein_match");
        }

        // Map through the plugin's own MethodInfo so translation works across ALC boundaries
        // (Npgsql EF.Functions.Trigrams*/ILike MethodInfo from a private plugin copy does not).
        RegisterSearchDbFunction(
            modelBuilder,
            nameof(Jellyfin.Plugin.Pgsql.Search.PgSearchDbFunctions.WordSimilarity),
            "word_similarity",
            [typeof(string), typeof(string)]);
        RegisterSearchDbFunction(
            modelBuilder,
            nameof(Jellyfin.Plugin.Pgsql.Search.PgSearchDbFunctions.TrigramSimilarity),
            "similarity",
            [typeof(string), typeof(string)]);
        RegisterSearchDbFunction(
            modelBuilder,
            nameof(Jellyfin.Plugin.Pgsql.Search.PgSearchDbFunctions.ILike),
            "jellyfin_ilike",
            [typeof(string), typeof(string)]);
    }

    private static void RegisterSearchDbFunction(
        ModelBuilder modelBuilder,
        string methodName,
        string sqlName,
        Type[] parameterTypes)
    {
        var method = typeof(Jellyfin.Plugin.Pgsql.Search.PgSearchDbFunctions)
            .GetMethod(methodName, parameterTypes);
        if (method is not null)
        {
            modelBuilder.HasDbFunction(method).HasName(sqlName);
        }
    }

    /// <inheritdoc/>
    public Task RunShutdownTask(CancellationToken cancellationToken)
    {
        // Clear Npgsql connection pools on shutdown
        NpgsqlConnection.ClearAllPools();
        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation("PostgreSQL connection pools cleared on shutdown");
        }

        return Task.CompletedTask;
    }

    /// <inheritdoc/>
    public void ConfigureConventions(ModelConfigurationBuilder configurationBuilder)
    {
    }

    /// <inheritdoc/>
    public async Task<string> MigrationBackupFast(CancellationToken cancellationToken)
    {
        var key = DateTime.UtcNow.ToString("yyyyMMddHHmmss", CultureInfo.InvariantCulture);
        var backupFolder = Path.Join(_applicationPaths.DataPath, BackupFolderName);
        Directory.CreateDirectory(backupFolder);

        var connectionBuilder = GetConnectionBuilder(null);
        var backupFile = Path.Join(backupFolder, $"{key}_{connectionBuilder.Database}.sql");

        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = "pg_dump",
                Arguments = $"--host={connectionBuilder.Host} --port={connectionBuilder.Port} --username={connectionBuilder.Username} --dbname={connectionBuilder.Database} --file=\"{backupFile}\" --no-password --verbose --clean --if-exists",
                Environment = { ["PGPASSWORD"] = connectionBuilder.Password },
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true
            }
        };

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation("Starting PostgreSQL backup: {BackupFile}", backupFile);
        }

        process.Start();
        await process.WaitForExitAsync(cancellationToken).ConfigureAwait(false);

        if (process.ExitCode != 0)
        {
            var error = await process.StandardError.ReadToEndAsync(cancellationToken).ConfigureAwait(false);
            if (_logger.IsEnabled(LogLevel.Error))
            {
                _logger.LogError("pg_dump failed with exit code {ExitCode}: {Error}", process.ExitCode, error);
            }

            throw new InvalidOperationException($"pg_dump failed: {error}");
        }

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation("PostgreSQL backup completed successfully: {BackupFile}", backupFile);
        }

        return key;
    }

    /// <inheritdoc/>
    public async Task RestoreBackupFast(string key, CancellationToken cancellationToken)
    {
        NpgsqlConnection.ClearAllPools();

        var connectionBuilder = GetConnectionBuilder(null);
        var backupFile = Path.Join(_applicationPaths.DataPath, BackupFolderName, $"{key}_{connectionBuilder.Database}.sql");

        if (!File.Exists(backupFile))
        {
            if (_logger.IsEnabled(LogLevel.Critical))
            {
                _logger.LogCritical("Tried to restore a backup that does not exist: {Key}", key);
            }

            return;
        }

        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = "psql",
                Arguments = $"--host={connectionBuilder.Host} --port={connectionBuilder.Port} --username={connectionBuilder.Username} --dbname={connectionBuilder.Database} --file=\"{backupFile}\" --no-password --quiet",
                Environment = { ["PGPASSWORD"] = connectionBuilder.Password },
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true
            }
        };

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation("Starting PostgreSQL restore from: {BackupFile}", backupFile);
        }

        process.Start();
        await process.WaitForExitAsync(cancellationToken).ConfigureAwait(false);

        if (process.ExitCode != 0)
        {
            var error = await process.StandardError.ReadToEndAsync(cancellationToken).ConfigureAwait(false);
            if (_logger.IsEnabled(LogLevel.Error))
            {
                _logger.LogError("psql restore failed with exit code {ExitCode}: {Error}", process.ExitCode, error);
            }

            throw new InvalidOperationException($"psql restore failed: {error}");
        }

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation("PostgreSQL restore completed successfully from: {BackupFile}", backupFile);
        }
    }

    /// <inheritdoc/>
    public Task DeleteBackup(string key)
    {
        var connectionBuilder = GetConnectionBuilder(null);
        var backupFile = Path.Join(_applicationPaths.DataPath, BackupFolderName, $"{key}_{connectionBuilder.Database}.sql");

        if (!File.Exists(backupFile))
        {
            if (_logger.IsEnabled(LogLevel.Critical))
            {
                _logger.LogCritical("Tried to delete a backup that does not exist: {Key}", key);
            }

            return Task.CompletedTask;
        }

        File.Delete(backupFile);
        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation("Deleted backup file: {BackupFile}", backupFile);
        }

        return Task.CompletedTask;
    }

    /// <inheritdoc/>
    public async Task PurgeDatabase(JellyfinDbContext dbContext, IEnumerable<string>? tableNames)
    {
        ArgumentNullException.ThrowIfNull(tableNames);

        var truncateQueries = new List<string>();
        foreach (var tableName in tableNames)
        {
            truncateQueries.Add($"TRUNCATE TABLE \"{tableName}\" RESTART IDENTITY CASCADE;");
        }

        var truncateAllQuery = string.Join('\n', truncateQueries);

        await dbContext.Database.ExecuteSqlRawAsync(truncateAllQuery).ConfigureAwait(false);
        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation("PostgreSQL database tables purged successfully");
        }
    }

    private T? GetCustomDatabaseOption<T>(ICollection<CustomDatabaseOption>? options, string key, Func<string, T> converter, Func<T>? defaultValue = null)
    {
        if (options is null)
        {
            return defaultValue is not null ? defaultValue() : default;
        }

        var value = options.FirstOrDefault(e => e.Key.Equals(key, StringComparison.OrdinalIgnoreCase));
        if (value is null)
        {
            return defaultValue is not null ? defaultValue() : default;
        }

        return converter(value.Value);
    }

    private NpgsqlConnectionStringBuilder GetConnectionBuilder(ICollection<CustomDatabaseOption>? options)
    {
        var includeErrorDetail = GetCustomDatabaseOption(options, "IncludeErrorDetail", e => e.Equals(bool.TrueString, StringComparison.OrdinalIgnoreCase), () => false);
        var logParameters = GetCustomDatabaseOption(options, "LogParameters", e => e.Equals(bool.TrueString, StringComparison.OrdinalIgnoreCase), () => false);

        var connectionBuilder = new NpgsqlConnectionStringBuilder
        {
            Host = Environment.GetEnvironmentVariable("POSTGRES_HOST") ?? "jellyfin",
            Port = int.Parse(Environment.GetEnvironmentVariable("POSTGRES_PORT") ?? "5432", CultureInfo.InvariantCulture),
            Database = Environment.GetEnvironmentVariable("POSTGRES_DB") ?? "jellyfin",
            Username = Environment.GetEnvironmentVariable("POSTGRES_USER") ?? "jellyfin",
            Password = Environment.GetEnvironmentVariable("POSTGRES_PASSWORD") ?? throw new InvalidOperationException("PostgreSQL password must be provided via POSTGRES_PASSWORD environment variable"),
            // Default of 30s is too tight for heavy library queries on large remote databases.
            CommandTimeout = int.Parse(Environment.GetEnvironmentVariable("Pgsql_COMMAND_TIMEOUT") ?? "90", CultureInfo.InvariantCulture)
        };

        if (includeErrorDetail)
        {
            connectionBuilder.IncludeErrorDetail = includeErrorDetail;
        }

        if (logParameters)
        {
            connectionBuilder.LogParameters = logParameters;
        }

        if (_logger.IsEnabled(LogLevel.Information))
        {
            var safeConnectionString = new NpgsqlConnectionStringBuilder(connectionBuilder.ToString())
            {
                Password = null
            }.ToString();

            _logger.LogInformation("PostgreSQL connection string: {ConnectionString}", safeConnectionString);
        }

        return connectionBuilder;
    }
}
