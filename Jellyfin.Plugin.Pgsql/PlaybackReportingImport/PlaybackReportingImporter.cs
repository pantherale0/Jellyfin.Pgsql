using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Pgsql.PlaybackReportingImport;

/// <summary>
/// Imports playback activity rows from the Playback Reporting plugin SQLite database or TSV export.
/// </summary>
public sealed class PlaybackReportingImporter : IPlaybackReportingImporter
{
    private const long TicksPerSecond = 10_000_000L;
    private const string DateTimeFormat = "yyyy-MM-dd HH:mm:ss";
    private const int InsertBatchSize = 2000;
    private const int LookupBatchSize = 500;

    private readonly IDbContextFactory<JellyfinDbContext> _dbContextFactory;
    private readonly ILogger<PlaybackReportingImporter> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="PlaybackReportingImporter"/> class.
    /// </summary>
    /// <param name="dbContextFactory">The database context factory.</param>
    /// <param name="logger">The logger.</param>
    public PlaybackReportingImporter(
        IDbContextFactory<JellyfinDbContext> dbContextFactory,
        ILogger<PlaybackReportingImporter> logger)
    {
        _dbContextFactory = dbContextFactory;
        _logger = logger;
    }

    /// <summary>
    /// Imports playback activity from a SQLite database file.
    /// </summary>
    /// <param name="sqlitePath">Path to <c>playback_reporting.db</c>.</param>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>Import statistics.</returns>
    public async Task<PlaybackReportingMigrationResult> ImportFromSqliteAsync(string sqlitePath, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrEmpty(sqlitePath);

        var rows = new List<PluginPlaybackRow>();
        var connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = sqlitePath,
            Mode = SqliteOpenMode.ReadOnly,
        }.ToString();

        await using var connection = new SqliteConnection(connectionString);
        await connection.OpenAsync(cancellationToken).ConfigureAwait(false);

        await using var command = connection.CreateCommand();
        command.CommandText =
            "SELECT DateCreated, UserId, ItemId, ItemType, ItemName, PlaybackMethod, ClientName, DeviceName, PlayDuration " +
            "FROM PlaybackActivity ORDER BY DateCreated";

        await using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            rows.Add(new PluginPlaybackRow
            {
                DateCreated = reader.GetString(0),
                UserId = reader.GetString(1),
                ItemId = reader.GetString(2),
                ItemType = reader.GetString(3),
                ItemName = reader.GetString(4),
                PlaybackMethod = reader.GetString(5),
                ClientName = reader.GetString(6),
                DeviceName = reader.GetString(7),
                PlayDuration = reader.GetInt32(8),
            });
        }

        return await ImportRowsAsync(rows, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>
    /// Imports playback activity from a plugin TSV export.
    /// </summary>
    /// <param name="tsvPath">Path to the TSV file.</param>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>Import statistics.</returns>
    public async Task<PlaybackReportingMigrationResult> ImportFromTsvAsync(string tsvPath, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrEmpty(tsvPath);

        var rows = new List<PluginPlaybackRow>();
        using var reader = new StreamReader(tsvPath);
        while (true)
        {
            var line = await reader.ReadLineAsync(cancellationToken).ConfigureAwait(false);
            if (line is null)
            {
                break;
            }

            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            var tokens = line.Split('\t');
            if (tokens.Length != 9)
            {
                continue;
            }

            if (!int.TryParse(tokens[8], NumberStyles.Integer, CultureInfo.InvariantCulture, out var duration))
            {
                continue;
            }

            rows.Add(new PluginPlaybackRow
            {
                DateCreated = tokens[0],
                UserId = tokens[1],
                ItemId = tokens[2],
                ItemType = tokens[3],
                ItemName = tokens[4],
                PlaybackMethod = tokens[5],
                ClientName = tokens[6],
                DeviceName = tokens[7],
                PlayDuration = duration,
            });
        }

        return await ImportRowsAsync(rows, cancellationToken).ConfigureAwait(false);
    }

    private async Task<PlaybackReportingMigrationResult> ImportRowsAsync(
        IReadOnlyList<PluginPlaybackRow> rows,
        CancellationToken cancellationToken)
    {
        var result = new PlaybackReportingMigrationResult
        {
            SourceRows = rows.Count,
        };

        if (rows.Count == 0)
        {
            return result;
        }

        await using var dbContext = await _dbContextFactory.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);

        var validUserIds = await dbContext.Users
            .AsNoTracking()
            .Select(u => u.Id)
            .ToHashSetAsync(cancellationToken)
            .ConfigureAwait(false);

        var existingKeys = await dbContext.PlaybackActivity
            .AsNoTracking()
            .Select(p => new ExistingPlaybackKey(p.UserId, p.ItemId, p.DatePlayed, p.PlayedTicks))
            .ToHashSetAsync(cancellationToken)
            .ConfigureAwait(false);

        var itemIds = rows
            .Select(r => ParseOptionalGuid(r.ItemId))
            .Where(id => id.HasValue)
            .Select(id => id!.Value)
            .Distinct()
            .ToList();

        var itemLookup = await LoadItemLookupAsync(dbContext, itemIds, cancellationToken).ConfigureAwait(false);
        var deviceLookup = await LoadDeviceLookupAsync(dbContext, cancellationToken).ConfigureAwait(false);

        var pending = new List<PlaybackActivity>(InsertBatchSize);

        foreach (var row in rows)
        {
            cancellationToken.ThrowIfCancellationRequested();

            if (row.PlayDuration <= 0)
            {
                result.Skipped++;
                continue;
            }

            if (!TryParseGuid(row.UserId, out var userId) || !validUserIds.Contains(userId))
            {
                result.Skipped++;
                continue;
            }

            if (!TryParseGuid(row.ItemId, out var itemId))
            {
                result.Skipped++;
                continue;
            }

            if (!TryParseDatePlayed(row.DateCreated, out var datePlayed))
            {
                result.Skipped++;
                continue;
            }

            var playedTicks = row.PlayDuration * TicksPerSecond;
            var key = new ExistingPlaybackKey(userId, itemId, datePlayed, playedTicks);
            if (existingKeys.Contains(key))
            {
                result.Skipped++;
                continue;
            }

            var mediaType = row.ItemType;
            var itemSubGroup = "Unknown";
            if (itemLookup.TryGetValue(itemId, out var itemInfo))
            {
                mediaType = itemInfo.Type;
                itemSubGroup = itemInfo.FirstGenre;
            }

            var activity = new PlaybackActivity
            {
                Id = Guid.NewGuid(),
                UserId = userId,
                DeviceId = ResolveDeviceId(deviceLookup, userId, row.ClientName, row.DeviceName, datePlayed),
                ItemId = itemId,
                ItemName = row.ItemName,
                MediaType = mediaType,
                PlayedTicks = playedTicks,
                DatePlayed = datePlayed,
                ItemSubGroup = itemSubGroup,
                PlaybackMethod = NullIfEmpty(row.PlaybackMethod),
                ClientName = NullIfEmpty(row.ClientName),
                DeviceName = NullIfEmpty(row.DeviceName),
            };

            pending.Add(activity);
            existingKeys.Add(key);

            if (pending.Count >= InsertBatchSize)
            {
                await FlushBatchAsync(dbContext, pending, cancellationToken).ConfigureAwait(false);
                result.Imported += pending.Count;
                pending.Clear();
            }
        }

        if (pending.Count > 0)
        {
            await FlushBatchAsync(dbContext, pending, cancellationToken).ConfigureAwait(false);
            result.Imported += pending.Count;
        }

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "Playback reporting import finished: imported={Imported}, skipped={Skipped}, source={SourceRows}",
                result.Imported,
                result.Skipped,
                result.SourceRows);
        }

        return result;
    }

    private static async Task FlushBatchAsync(
        JellyfinDbContext dbContext,
        List<PlaybackActivity> pending,
        CancellationToken cancellationToken)
    {
        dbContext.PlaybackActivity.AddRange(pending);
        await dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        dbContext.ChangeTracker.Clear();
    }

    private static async Task<Dictionary<Guid, ItemImportInfo>> LoadItemLookupAsync(
        JellyfinDbContext dbContext,
        List<Guid> itemIds,
        CancellationToken cancellationToken)
    {
        var lookup = new Dictionary<Guid, ItemImportInfo>();

        for (var offset = 0; offset < itemIds.Count; offset += LookupBatchSize)
        {
            var batch = itemIds.Skip(offset).Take(LookupBatchSize).ToList();
            var items = await dbContext.BaseItems
                .AsNoTracking()
                .Where(i => batch.Contains(i.Id))
                .Select(i => new { i.Id, i.Type, i.Genres })
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);

            foreach (var item in items)
            {
                lookup[item.Id] = new ItemImportInfo(
                    item.Type,
                    ParseFirstGenre(item.Genres));
            }
        }

        return lookup;
    }

    private static async Task<Dictionary<Guid, List<DeviceImportInfo>>> LoadDeviceLookupAsync(
        JellyfinDbContext dbContext,
        CancellationToken cancellationToken)
    {
        var devices = await dbContext.Devices
            .AsNoTracking()
            .Select(d => new DeviceImportInfo(d.Id, d.UserId, d.AppName, d.DeviceName, d.DateLastActivity))
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        return devices
            .GroupBy(d => d.UserId)
            .ToDictionary(g => g.Key, g => g.ToList());
    }

    private static int? ResolveDeviceId(
        IReadOnlyDictionary<Guid, List<DeviceImportInfo>> deviceLookup,
        Guid userId,
        string clientName,
        string deviceName,
        DateTime datePlayed)
    {
        if (!deviceLookup.TryGetValue(userId, out var devices))
        {
            return null;
        }

        var matches = devices
            .Where(d => string.Equals(d.AppName, clientName, StringComparison.Ordinal)
                && string.Equals(d.DeviceName, deviceName, StringComparison.Ordinal))
            .ToList();

        if (matches.Count == 0)
        {
            return null;
        }

        var best = matches
            .OrderBy(d => Math.Abs((d.DateLastActivity - datePlayed).TotalSeconds))
            .First();

        return best.Id;
    }

    private static Guid? ParseOptionalGuid(string value)
    {
        return Guid.TryParse(value, out var guid) ? guid : null;
    }

    private static bool TryParseGuid(string value, out Guid guid)
    {
        return Guid.TryParse(value, out guid);
    }

    private static bool TryParseDatePlayed(string value, out DateTime datePlayed)
    {
        if (!DateTime.TryParseExact(
                value,
                DateTimeFormat,
                CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeLocal,
                out var local))
        {
            datePlayed = default;
            return false;
        }

        datePlayed = local.ToUniversalTime();
        return true;
    }

    private static string? NullIfEmpty(string value)
    {
        return string.IsNullOrWhiteSpace(value) ? null : value;
    }

    private static string ParseFirstGenre(string? genres)
    {
        if (string.IsNullOrWhiteSpace(genres))
        {
            return "Unknown";
        }

        var parts = genres.Split('|', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        return parts.Length > 0 ? parts[0] : "Unknown";
    }

    private readonly record struct ExistingPlaybackKey(Guid UserId, Guid ItemId, DateTime DatePlayed, long PlayedTicks);

    private readonly record struct ItemImportInfo(string Type, string FirstGenre);

    private readonly record struct DeviceImportInfo(int Id, Guid UserId, string AppName, string DeviceName, DateTime DateLastActivity);

    private sealed class PluginPlaybackRow
    {
        public string DateCreated { get; set; } = string.Empty;

        public string UserId { get; set; } = string.Empty;

        public string ItemId { get; set; } = string.Empty;

        public string ItemType { get; set; } = string.Empty;

        public string ItemName { get; set; } = string.Empty;

        public string PlaybackMethod { get; set; } = string.Empty;

        public string ClientName { get; set; } = string.Empty;

        public string DeviceName { get; set; } = string.Empty;

        public int PlayDuration { get; set; }
    }
}
