using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.Pgsql.PlaybackReportingImport;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using Xunit;

namespace Jellyfin.Plugin.Pgsql.Tests.PlaybackReportingImport;

public sealed class PlaybackReportingMigrationServiceTests
{
    [Fact]
    public async Task StartAsync_DoesNothing_WhenEnvNotSet()
    {
        var previous = Environment.GetEnvironmentVariable("MIGRATE_PLAYBACK_REPORTING");
        Environment.SetEnvironmentVariable("MIGRATE_PLAYBACK_REPORTING", null);

        try
        {
            var importer = new Mock<IPlaybackReportingImporter>(MockBehavior.Strict);
            var service = CreateService(importer.Object, Path.GetTempPath());

            await service.StartAsync(CancellationToken.None).ConfigureAwait(false);

            importer.VerifyNoOtherCalls();
        }
        finally
        {
            Environment.SetEnvironmentVariable("MIGRATE_PLAYBACK_REPORTING", previous);
        }
    }

    [Fact]
    public async Task StartAsync_SkipsImport_WhenMarkerExists()
    {
        var previous = Environment.GetEnvironmentVariable("MIGRATE_PLAYBACK_REPORTING");
        var tempDir = Path.Combine(Path.GetTempPath(), $"playback-marker-{Guid.NewGuid():N}");
        Directory.CreateDirectory(tempDir);
        var markerPath = Path.Combine(tempDir, ".playback-reporting-migration-complete.json");
        await File.WriteAllTextAsync(markerPath, "{}").ConfigureAwait(false);

        Environment.SetEnvironmentVariable("MIGRATE_PLAYBACK_REPORTING", "true");

        try
        {
            var importer = new Mock<IPlaybackReportingImporter>(MockBehavior.Strict);
            var service = CreateService(importer.Object, tempDir);

            await service.StartAsync(CancellationToken.None).ConfigureAwait(false);

            importer.VerifyNoOtherCalls();
        }
        finally
        {
            Environment.SetEnvironmentVariable("MIGRATE_PLAYBACK_REPORTING", previous);
            if (Directory.Exists(tempDir))
            {
                Directory.Delete(tempDir, recursive: true);
            }
        }
    }

    [Fact]
    public async Task StartAsync_ImportsFromSqlite_WritesMarkerAndRenamesDatabase()
    {
        var previousMigrate = Environment.GetEnvironmentVariable("MIGRATE_PLAYBACK_REPORTING");
        var previousTsv = Environment.GetEnvironmentVariable("PLAYBACK_REPORTING_TSV");
        var tempDir = Path.Combine(Path.GetTempPath(), $"playback-run-{Guid.NewGuid():N}");
        Directory.CreateDirectory(tempDir);

        var sqlitePath = Path.Combine(tempDir, "playback_reporting.db");
        await File.WriteAllTextAsync(sqlitePath, "placeholder").ConfigureAwait(false);

        Environment.SetEnvironmentVariable("MIGRATE_PLAYBACK_REPORTING", "true");
        Environment.SetEnvironmentVariable("PLAYBACK_REPORTING_TSV", null);

        try
        {
            var importer = new Mock<IPlaybackReportingImporter>(MockBehavior.Strict);
            importer
                .Setup(i => i.ImportFromSqliteAsync(sqlitePath, It.IsAny<CancellationToken>()))
                .ReturnsAsync(new PlaybackReportingMigrationResult
                {
                    SourceRows = 3,
                    Imported = 2,
                    Skipped = 1,
                });

            var service = CreateService(importer.Object, tempDir);
            await service.StartAsync(CancellationToken.None).ConfigureAwait(false);

            importer.Verify(i => i.ImportFromSqliteAsync(sqlitePath, It.IsAny<CancellationToken>()), Times.Once);
            Assert.True(File.Exists(Path.Combine(tempDir, ".playback-reporting-migration-complete.json")));
            Assert.False(File.Exists(sqlitePath));
            Assert.True(File.Exists(Path.Combine(tempDir, "playback_reporting.db.migrated")));
        }
        finally
        {
            Environment.SetEnvironmentVariable("MIGRATE_PLAYBACK_REPORTING", previousMigrate);
            Environment.SetEnvironmentVariable("PLAYBACK_REPORTING_TSV", previousTsv);
            if (Directory.Exists(tempDir))
            {
                Directory.Delete(tempDir, recursive: true);
            }
        }
    }

    private static PlaybackReportingMigrationService CreateService(IPlaybackReportingImporter importer, string dataPath)
    {
        var paths = new Mock<IApplicationPaths>();
        paths.Setup(p => p.DataPath).Returns(dataPath);

        return new PlaybackReportingMigrationService(
            paths.Object,
            importer,
            NullLogger<PlaybackReportingMigrationService>.Instance);
    }
}
