using System;
using System.Globalization;
using System.Linq;
using System.Threading.Tasks;
using Jellyfin.Plugin.Pgsql.PlaybackReportingImport;
using Jellyfin.Plugin.Pgsql.Tests.Infrastructure;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace Jellyfin.Plugin.Pgsql.Tests.PlaybackReportingImport;

[Collection(PostgresCollection.Name)]
public sealed class PlaybackReportingImporterTests
{
    private readonly PostgresDatabaseFixture _fixture;

    public PlaybackReportingImporterTests(PostgresDatabaseFixture fixture)
    {
        _fixture = fixture;
    }

    [PostgresTestFact]
    public async Task ImportFromTsvAsync_ImportsValidRows_SkipsInvalidAndZeroDuration()
    {
        Assert.True(_fixture.IsAvailable, $"PostgreSQL fixture failed to initialize: {_fixture.InitializationError}");

        var factory = new TestDbContextFactory(_fixture.ConnectionString);
        await using var dbContext = await factory.CreateDbContextAsync().ConfigureAwait(false);
        await PlaybackReportingFixtureFactory.SeedTestDataAsync(dbContext).ConfigureAwait(false);
        await PlaybackReportingFixtureFactory.ClearPlaybackActivityAsync(dbContext).ConfigureAwait(false);

        var importer = PlaybackReportingFixtureFactory.CreateImporter(_fixture.ConnectionString);
        var tsvPath = PlaybackReportingFixtureFactory.GetFixturePath("sample-export.tsv");

        var result = await importer.ImportFromTsvAsync(tsvPath, default).ConfigureAwait(false);

        Assert.Equal(4, result.SourceRows);
        Assert.Equal(2, result.Imported);
        Assert.Equal(2, result.Skipped);

        await using var verifyContext = await factory.CreateDbContextAsync().ConfigureAwait(false);
        var rows = await verifyContext.PlaybackActivity
            .AsNoTracking()
            .OrderBy(p => p.DatePlayed)
            .ToListAsync()
            .ConfigureAwait(false);

        Assert.Equal(2, rows.Count);

        var first = rows[0];
        Assert.Equal(PlaybackReportingTestIds.UserId, first.UserId);
        Assert.Equal(PlaybackReportingTestIds.MovieItemId, first.ItemId);
        Assert.Equal("Movie", first.MediaType);
        Assert.Equal("Action", first.ItemSubGroup);
        Assert.Equal(3600L * 10_000_000L, first.PlayedTicks);
        Assert.Equal("DirectPlay", first.PlaybackMethod);
        Assert.Equal("Jellyfin Web", first.ClientName);
        Assert.Equal("Chrome", first.DeviceName);
        Assert.NotNull(first.DeviceId);

        var second = rows[1];
        Assert.Equal(PlaybackReportingTestIds.OtherItemId, second.ItemId);
        Assert.Equal("Comedy", second.ItemSubGroup);
        Assert.Equal(900L * 10_000_000L, second.PlayedTicks);
        Assert.Equal("Firefox", second.DeviceName);
        Assert.Null(second.DeviceId);
    }

    [PostgresTestFact]
    public async Task ImportFromSqliteAsync_ImportsRows_AndIsIdempotent()
    {
        Assert.True(_fixture.IsAvailable, $"PostgreSQL fixture failed to initialize: {_fixture.InitializationError}");

        var factory = new TestDbContextFactory(_fixture.ConnectionString);
        await using var dbContext = await factory.CreateDbContextAsync().ConfigureAwait(false);
        await PlaybackReportingFixtureFactory.SeedTestDataAsync(dbContext).ConfigureAwait(false);
        await PlaybackReportingFixtureFactory.ClearPlaybackActivityAsync(dbContext).ConfigureAwait(false);

        var sqlitePath = PlaybackReportingFixtureFactory.CreatePluginSqliteDatabase();
        try
        {
            var importer = PlaybackReportingFixtureFactory.CreateImporter(_fixture.ConnectionString);

            var firstRun = await importer.ImportFromSqliteAsync(sqlitePath, default).ConfigureAwait(false);
            Assert.Equal(3, firstRun.SourceRows);
            Assert.Equal(2, firstRun.Imported);
            Assert.Equal(1, firstRun.Skipped);

            var secondRun = await importer.ImportFromSqliteAsync(sqlitePath, default).ConfigureAwait(false);
            Assert.Equal(3, secondRun.SourceRows);
            Assert.Equal(0, secondRun.Imported);
            Assert.Equal(3, secondRun.Skipped);

            await using var verifyContext = await factory.CreateDbContextAsync().ConfigureAwait(false);
            var count = await verifyContext.PlaybackActivity.CountAsync().ConfigureAwait(false);
            Assert.Equal(2, count);
        }
        finally
        {
            if (System.IO.File.Exists(sqlitePath))
            {
                System.IO.File.Delete(sqlitePath);
            }
        }
    }

    [PostgresTestFact]
    public async Task ImportFromTsvAsync_ParsesDatePlayedAsUtcFromLocalAssumption()
    {
        Assert.True(_fixture.IsAvailable, $"PostgreSQL fixture failed to initialize: {_fixture.InitializationError}");

        var factory = new TestDbContextFactory(_fixture.ConnectionString);
        await using var dbContext = await factory.CreateDbContextAsync().ConfigureAwait(false);
        await PlaybackReportingFixtureFactory.SeedTestDataAsync(dbContext).ConfigureAwait(false);
        await PlaybackReportingFixtureFactory.ClearPlaybackActivityAsync(dbContext).ConfigureAwait(false);

        var tsvPath = System.IO.Path.Join(System.IO.Path.GetTempPath(), $"playback-date-{Guid.NewGuid():N}.tsv");
        var local = new DateTime(2024, 6, 1, 20, 30, 0, DateTimeKind.Local);
        await System.IO.File.WriteAllTextAsync(
            tsvPath,
            string.Create(
                CultureInfo.InvariantCulture,
                $"{local:yyyy-MM-dd HH:mm:ss}\t{PlaybackReportingTestIds.UserId:N}\t{PlaybackReportingTestIds.MovieItemId:N}\tVideo\tDate Test\tDirectPlay\tJellyfin Web\tChrome\t60"))
            .ConfigureAwait(false);

        try
        {
            var importer = PlaybackReportingFixtureFactory.CreateImporter(_fixture.ConnectionString);
            await importer.ImportFromTsvAsync(tsvPath, default).ConfigureAwait(false);

            await using var verifyContext = await factory.CreateDbContextAsync().ConfigureAwait(false);
            var row = await verifyContext.PlaybackActivity.SingleAsync().ConfigureAwait(false);
            Assert.Equal(local.ToUniversalTime(), row.DatePlayed);
        }
        finally
        {
            if (System.IO.File.Exists(tsvPath))
            {
                System.IO.File.Delete(tsvPath);
            }
        }
    }
}
