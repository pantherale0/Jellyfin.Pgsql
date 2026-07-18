using System;
using System.IO;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Pgsql.PlaybackReportingImport;

/// <summary>
/// One-time import of Playback Reporting plugin data into native <see cref="Jellyfin.Database.Implementations.Entities.PlaybackActivity"/>.
/// </summary>
public sealed class PlaybackReportingMigrationService : IHostedService
{
    private const string MigrationMarkerFileName = ".playback-reporting-migration-complete.json";
    private const string SqliteFileName = "playback_reporting.db";
    private const string MigratedSqliteFileName = "playback_reporting.db.migrated";

    private readonly IApplicationPaths _applicationPaths;
    private readonly IPlaybackReportingImporter _importer;
    private readonly ILogger<PlaybackReportingMigrationService> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="PlaybackReportingMigrationService"/> class.
    /// </summary>
    /// <param name="applicationPaths">Application paths.</param>
    /// <param name="importer">The playback reporting importer.</param>
    /// <param name="logger">The logger.</param>
    public PlaybackReportingMigrationService(
        IApplicationPaths applicationPaths,
        IPlaybackReportingImporter importer,
        ILogger<PlaybackReportingMigrationService> logger)
    {
        _applicationPaths = applicationPaths;
        _importer = importer;
        _logger = logger;
    }

    /// <inheritdoc />
    public async Task StartAsync(CancellationToken cancellationToken)
    {
        var mode = Environment.GetEnvironmentVariable("MIGRATE_PLAYBACK_REPORTING");
        if (!string.Equals(mode, "true", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(mode, "force", StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        var markerPath = Path.Join(_applicationPaths.DataPath, MigrationMarkerFileName);
        if (File.Exists(markerPath) && !string.Equals(mode, "force", StringComparison.OrdinalIgnoreCase))
        {
            if (_logger.IsEnabled(LogLevel.Information))
            {
                _logger.LogInformation("Playback reporting migration marker found; skipping import");
            }

            return;
        }

        var tsvOverride = Environment.GetEnvironmentVariable("PLAYBACK_REPORTING_TSV");
        var sqlitePath = Path.Join(_applicationPaths.DataPath, SqliteFileName);

        PlaybackReportingMigrationResult result;
        if (!string.IsNullOrWhiteSpace(tsvOverride))
        {
            if (!File.Exists(tsvOverride))
            {
                _logger.LogWarning("PLAYBACK_REPORTING_TSV was set but file not found: {Path}", tsvOverride);
                return;
            }

            if (_logger.IsEnabled(LogLevel.Information))
            {
                _logger.LogInformation("Importing playback reporting data from TSV: {Path}", tsvOverride);
            }

            result = await _importer.ImportFromTsvAsync(tsvOverride, cancellationToken).ConfigureAwait(false);
        }
        else if (File.Exists(sqlitePath))
        {
            if (_logger.IsEnabled(LogLevel.Information))
            {
                _logger.LogInformation("Importing playback reporting data from SQLite: {Path}", sqlitePath);
            }

            result = await _importer.ImportFromSqliteAsync(sqlitePath, cancellationToken).ConfigureAwait(false);
        }
        else
        {
            _logger.LogWarning(
                "MIGRATE_PLAYBACK_REPORTING is enabled but neither {SqlitePath} nor PLAYBACK_REPORTING_TSV was found",
                sqlitePath);
            return;
        }

        var marker = new MigrationMarker
        {
            MigratedAtUtc = DateTime.UtcNow,
            SourceRows = result.SourceRows,
            ImportedRows = result.Imported,
            SkippedRows = result.Skipped,
        };

        await File.WriteAllTextAsync(
            markerPath,
            JsonSerializer.Serialize(marker),
            cancellationToken).ConfigureAwait(false);

        if (File.Exists(sqlitePath))
        {
            var migratedPath = Path.Join(_applicationPaths.DataPath, MigratedSqliteFileName);
            if (File.Exists(migratedPath))
            {
                File.Delete(migratedPath);
            }

            File.Move(sqlitePath, migratedPath);
            if (_logger.IsEnabled(LogLevel.Information))
            {
                _logger.LogInformation("Renamed plugin SQLite database to {Path}", migratedPath);
            }
        }
    }

    /// <inheritdoc />
    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    private sealed class MigrationMarker
    {
        public DateTime MigratedAtUtc { get; set; }

        public int SourceRows { get; set; }

        public int ImportedRows { get; set; }

        public int SkippedRows { get; set; }
    }
}
