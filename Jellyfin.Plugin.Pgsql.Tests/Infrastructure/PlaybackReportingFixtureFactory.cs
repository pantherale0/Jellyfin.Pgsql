using System;
using System.Globalization;
using System.IO;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Entities.Security;
using Jellyfin.Plugin.Pgsql.PlaybackReportingImport;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;

namespace Jellyfin.Plugin.Pgsql.Tests.Infrastructure;

internal static class PlaybackReportingFixtureFactory
{
    public static string GetFixturePath(string fileName)
    {
        return Path.Combine(AppContext.BaseDirectory, "Fixtures", fileName);
    }

    public static string CreatePluginSqliteDatabase()
    {
        var path = Path.Combine(Path.GetTempPath(), $"playback_reporting_{Guid.NewGuid():N}.db");
        if (File.Exists(path))
        {
            File.Delete(path);
        }

        using var connection = new SqliteConnection($"Data Source={path}");
        connection.Open();

        using (var create = connection.CreateCommand())
        {
            create.CommandText =
                "CREATE TABLE PlaybackActivity (" +
                "DateCreated DATETIME NOT NULL, UserId TEXT, ItemId TEXT, ItemType TEXT, ItemName TEXT, " +
                "PlaybackMethod TEXT, ClientName TEXT, DeviceName TEXT, PlayDuration INT)";
            create.ExecuteNonQuery();
        }

        InsertRow(connection, "2024-06-01 20:30:00", PlaybackReportingTestIds.UserId, PlaybackReportingTestIds.MovieItemId, 3600);
        InsertRow(connection, "2024-06-02 21:00:00", PlaybackReportingTestIds.UserId, PlaybackReportingTestIds.MovieItemId, 0);
        InsertRow(connection, "2024-06-04 18:00:00", PlaybackReportingTestIds.UserId, PlaybackReportingTestIds.OtherItemId, 900);

        return path;
    }

    public static PlaybackReportingImporter CreateImporter(string connectionString)
    {
        var factory = new TestDbContextFactory(connectionString);
        return new PlaybackReportingImporter(factory, NullLogger<PlaybackReportingImporter>.Instance);
    }

    public static async Task SeedTestDataAsync(JellyfinDbContext dbContext)
    {
        var user = new User("playback-test", "default", "default")
        {
            Id = PlaybackReportingTestIds.UserId,
        };

        if (!await dbContext.Users.AnyAsync(u => u.Id == user.Id).ConfigureAwait(false))
        {
            dbContext.Users.Add(user);
        }

        var movie = new BaseItemEntity
        {
            Id = PlaybackReportingTestIds.MovieItemId,
            Type = "Movie",
            Name = "Seeded Movie",
            Genres = "Action|Drama",
        };

        if (!await dbContext.BaseItems.AnyAsync(i => i.Id == movie.Id).ConfigureAwait(false))
        {
            dbContext.BaseItems.Add(movie);
        }

        var otherMovie = new BaseItemEntity
        {
            Id = PlaybackReportingTestIds.OtherItemId,
            Type = "Movie",
            Name = "Other Movie",
            Genres = "Comedy",
        };

        if (!await dbContext.BaseItems.AnyAsync(i => i.Id == otherMovie.Id).ConfigureAwait(false))
        {
            dbContext.BaseItems.Add(otherMovie);
        }

        var device = new Device(
            PlaybackReportingTestIds.UserId,
            "Jellyfin Web",
            "10.10.0",
            "Chrome",
            PlaybackReportingTestIds.DeviceClientId)
        {
            DateLastActivity = DateTime.Parse("2024-06-01 20:00:00", CultureInfo.InvariantCulture).ToUniversalTime(),
        };

        if (!await dbContext.Devices.AnyAsync(d => d.UserId == device.UserId && d.DeviceId == device.DeviceId).ConfigureAwait(false))
        {
            dbContext.Devices.Add(device);
        }

        await dbContext.SaveChangesAsync().ConfigureAwait(false);
    }

    public static async Task ClearPlaybackActivityAsync(JellyfinDbContext dbContext)
    {
        await dbContext.PlaybackActivity.ExecuteDeleteAsync().ConfigureAwait(false);
    }

    private static void InsertRow(
        SqliteConnection connection,
        string dateCreated,
        Guid userId,
        Guid itemId,
        int playDuration)
    {
        using var insert = connection.CreateCommand();
        insert.CommandText =
            "INSERT INTO PlaybackActivity " +
            "(DateCreated, UserId, ItemId, ItemType, ItemName, PlaybackMethod, ClientName, DeviceName, PlayDuration) " +
            "VALUES (@DateCreated, @UserId, @ItemId, @ItemType, @ItemName, @PlaybackMethod, @ClientName, @DeviceName, @PlayDuration)";
        insert.Parameters.AddWithValue("@DateCreated", dateCreated);
        insert.Parameters.AddWithValue("@UserId", userId.ToString("N"));
        insert.Parameters.AddWithValue("@ItemId", itemId.ToString("N"));
        insert.Parameters.AddWithValue("@ItemType", "Video");
        insert.Parameters.AddWithValue("@ItemName", "Test Movie");
        insert.Parameters.AddWithValue("@PlaybackMethod", "DirectPlay");
        insert.Parameters.AddWithValue("@ClientName", "Jellyfin Web");
        insert.Parameters.AddWithValue("@DeviceName", "Chrome");
        insert.Parameters.AddWithValue("@PlayDuration", playDuration);
        insert.ExecuteNonQuery();
    }
}
