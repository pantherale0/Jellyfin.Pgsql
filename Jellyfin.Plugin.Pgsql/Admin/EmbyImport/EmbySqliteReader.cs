using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Data.Sqlite;

namespace Jellyfin.Plugin.Pgsql.Admin.EmbyImport;

/// <summary>
/// Reads Emby <c>users.db</c> and <c>library.db</c> UserDatas.
/// </summary>
public sealed class EmbySqliteReader
{
    /// <summary>
    /// Lists Emby users with UserData counts from an upload session.
    /// </summary>
    /// <param name="session">Import session.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Emby users.</returns>
    public async Task<IReadOnlyList<EmbyUserInfo>> ListUsersAsync(
        EmbyImportSession session,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(session);

        await ValidateLibraryDbAsync(session.LibraryDbPath, cancellationToken).ConfigureAwait(false);

        var users = await ReadUsersAsync(session.UsersDbPath, cancellationToken).ConfigureAwait(false);
        if (users.Count == 0)
        {
            throw new EmbyImportException(
                "Could not resolve any users from users.db. Expected a LocalUsersv2 (or Users) table with names.");
        }

        var counts = await CountUserDataByUserAsync(session.LibraryDbPath, cancellationToken)
            .ConfigureAwait(false);

        var byId = users.ToDictionary(u => u.Id, u => u);
        foreach (var (userId, count) in counts)
        {
            if (byId.TryGetValue(userId, out var existing))
            {
                byId[userId] = new EmbyUserInfo
                {
                    Id = existing.Id,
                    Name = existing.Name,
                    UserDataCount = count,
                };
            }
            else
            {
                byId[userId] = new EmbyUserInfo
                {
                    Id = userId,
                    Name = string.Format(CultureInfo.InvariantCulture, "Unknown (id={0})", userId),
                    UserDataCount = count,
                };
            }
        }

        return byId.Values
            .OrderBy(u => u.Name, StringComparer.OrdinalIgnoreCase)
            .ThenBy(u => u.Id)
            .ToList();
    }

    /// <summary>
    /// Reads UserDatas rows for the selected Emby user ids.
    /// </summary>
    /// <param name="libraryDbPath">Path to library.db.</param>
    /// <param name="embyUserIds">Emby user ids.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>UserData rows.</returns>
    public async Task<IReadOnlyList<EmbyUserDataRow>> ReadUserDataAsync(
        string libraryDbPath,
        IReadOnlyCollection<int> embyUserIds,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrEmpty(libraryDbPath);
        ArgumentNullException.ThrowIfNull(embyUserIds);

        if (embyUserIds.Count == 0)
        {
            return Array.Empty<EmbyUserDataRow>();
        }

        // Filter in-process so CommandText stays a compile-time constant (CA2100 / CA3001).
        var idSet = embyUserIds.ToHashSet();
        var rows = new List<EmbyUserDataRow>();

        await using var connection = OpenReadOnly(libraryDbPath);
        await connection.OpenAsync(cancellationToken).ConfigureAwait(false);

        await using var command = connection.CreateCommand();
        command.CommandText =
            "SELECT key, userId, rating, played, playCount, isFavorite, playbackPositionTicks, " +
            "lastPlayedDate, AudioStreamIndex, SubtitleStreamIndex FROM UserDatas";

        await using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            if (await reader.IsDBNullAsync(0, cancellationToken).ConfigureAwait(false))
            {
                continue;
            }

            var userId = reader.GetInt32(1);
            if (!idSet.Contains(userId))
            {
                continue;
            }

            rows.Add(new EmbyUserDataRow
            {
                Key = reader.GetString(0),
                UserId = userId,
                Rating = await reader.IsDBNullAsync(2, cancellationToken).ConfigureAwait(false)
                    ? null
                    : reader.GetDouble(2),
                Played = reader.GetBoolean(3),
                PlayCount = reader.GetInt32(4),
                IsFavorite = reader.GetBoolean(5),
                PlaybackPositionTicks = reader.GetInt64(6),
                LastPlayedDate = await reader.IsDBNullAsync(7, cancellationToken).ConfigureAwait(false)
                    ? null
                    : ReadDateTime(reader, 7),
                AudioStreamIndex = await reader.IsDBNullAsync(8, cancellationToken).ConfigureAwait(false)
                    ? null
                    : reader.GetInt32(8),
                SubtitleStreamIndex = await reader.IsDBNullAsync(9, cancellationToken).ConfigureAwait(false)
                    ? null
                    : reader.GetInt32(9),
            });
        }

        return rows;
    }

    private async Task ValidateLibraryDbAsync(string libraryDbPath, CancellationToken cancellationToken)
    {
        await using var connection = OpenReadOnly(libraryDbPath);
        await connection.OpenAsync(cancellationToken).ConfigureAwait(false);

        if (!await TableExistsAsync(connection, "UserDatas", cancellationToken).ConfigureAwait(false))
        {
            throw new EmbyImportException("library.db does not contain a UserDatas table.");
        }
    }

    private async Task<IReadOnlyList<EmbyUserInfo>> ReadUsersAsync(
        string usersDbPath,
        CancellationToken cancellationToken)
    {
        await using var connection = OpenReadOnly(usersDbPath);
        await connection.OpenAsync(cancellationToken).ConfigureAwait(false);

        if (await TableExistsAsync(connection, "LocalUsersv2", cancellationToken).ConfigureAwait(false))
        {
            return await ReadLocalUsersV2Async(connection, cancellationToken).ConfigureAwait(false);
        }

        if (await TableExistsAsync(connection, "Users", cancellationToken).ConfigureAwait(false))
        {
            var users = await TryReadUsersByIdNameAsync(connection, cancellationToken).ConfigureAwait(false);
            if (users.Count > 0)
            {
                return users;
            }

            users = await TryReadUsersByInternalIdNameAsync(connection, cancellationToken).ConfigureAwait(false);
            if (users.Count > 0)
            {
                return users;
            }
        }

        if (await TableExistsAsync(connection, "LocalUsers", cancellationToken).ConfigureAwait(false))
        {
            var users = await TryReadLocalUsersByIdNameAsync(connection, cancellationToken).ConfigureAwait(false);
            if (users.Count > 0)
            {
                return users;
            }
        }

        return Array.Empty<EmbyUserInfo>();
    }

    private static async Task<IReadOnlyList<EmbyUserInfo>> ReadLocalUsersV2Async(
        SqliteConnection connection,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT Id, data FROM LocalUsersv2";

        var users = new List<EmbyUserInfo>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            var id = reader.GetInt32(0);
            if (await reader.IsDBNullAsync(1, cancellationToken).ConfigureAwait(false))
            {
                users.Add(new EmbyUserInfo
                {
                    Id = id,
                    Name = string.Format(CultureInfo.InvariantCulture, "User {0}", id),
                    UserDataCount = 0,
                });
                continue;
            }

            var json = reader.GetValue(1) switch
            {
                string s => s,
                byte[] bytes => Encoding.UTF8.GetString(bytes),
                ReadOnlyMemory<byte> rom => Encoding.UTF8.GetString(rom.Span),
                _ => reader.GetString(1),
            };

            var (name, internalId) = ParseUserJson(json, id);
            users.Add(new EmbyUserInfo
            {
                Id = internalId,
                Name = name,
                UserDataCount = 0,
            });
        }

        return users;
    }

    private static async Task<IReadOnlyList<EmbyUserInfo>> TryReadUsersByIdNameAsync(
        SqliteConnection connection,
        CancellationToken cancellationToken)
    {
        try
        {
            await using var command = connection.CreateCommand();
            command.CommandText = "SELECT Id, Name FROM Users";
            return await ReadUserIdNameRowsAsync(command, cancellationToken).ConfigureAwait(false);
        }
        catch (SqliteException)
        {
            return Array.Empty<EmbyUserInfo>();
        }
    }

    private static async Task<IReadOnlyList<EmbyUserInfo>> TryReadUsersByInternalIdNameAsync(
        SqliteConnection connection,
        CancellationToken cancellationToken)
    {
        try
        {
            await using var command = connection.CreateCommand();
            command.CommandText = "SELECT InternalId, Name FROM Users";
            return await ReadUserIdNameRowsAsync(command, cancellationToken).ConfigureAwait(false);
        }
        catch (SqliteException)
        {
            return Array.Empty<EmbyUserInfo>();
        }
    }

    private static async Task<IReadOnlyList<EmbyUserInfo>> TryReadLocalUsersByIdNameAsync(
        SqliteConnection connection,
        CancellationToken cancellationToken)
    {
        try
        {
            await using var command = connection.CreateCommand();
            command.CommandText = "SELECT Id, Name FROM LocalUsers";
            return await ReadUserIdNameRowsAsync(command, cancellationToken).ConfigureAwait(false);
        }
        catch (SqliteException)
        {
            return Array.Empty<EmbyUserInfo>();
        }
    }

    private static async Task<IReadOnlyList<EmbyUserInfo>> ReadUserIdNameRowsAsync(
        SqliteCommand command,
        CancellationToken cancellationToken)
    {
        var users = new List<EmbyUserInfo>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            if (await reader.IsDBNullAsync(0, cancellationToken).ConfigureAwait(false)
                || await reader.IsDBNullAsync(1, cancellationToken).ConfigureAwait(false))
            {
                continue;
            }

            users.Add(new EmbyUserInfo
            {
                Id = Convert.ToInt32(reader.GetValue(0), CultureInfo.InvariantCulture),
                Name = reader.GetString(1),
                UserDataCount = 0,
            });
        }

        return users;
    }

    private static (string Name, int InternalId) ParseUserJson(string json, int fallbackId)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            var name = root.TryGetProperty("Name", out var nameEl) && nameEl.ValueKind == JsonValueKind.String
                ? nameEl.GetString()
                : null;
            var internalId = fallbackId;
            if (root.TryGetProperty("InternalId", out var idEl) && idEl.TryGetInt32(out var parsed))
            {
                internalId = parsed;
            }

            if (string.IsNullOrWhiteSpace(name))
            {
                name = string.Format(CultureInfo.InvariantCulture, "User {0}", internalId);
            }

            return (name, internalId);
        }
        catch (JsonException)
        {
            return (string.Format(CultureInfo.InvariantCulture, "User {0}", fallbackId), fallbackId);
        }
    }

    private static async Task<Dictionary<int, int>> CountUserDataByUserAsync(
        string libraryDbPath,
        CancellationToken cancellationToken)
    {
        await using var connection = OpenReadOnly(libraryDbPath);
        await connection.OpenAsync(cancellationToken).ConfigureAwait(false);

        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT userId, COUNT(*) FROM UserDatas GROUP BY userId";

        var result = new Dictionary<int, int>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            result[reader.GetInt32(0)] = reader.GetInt32(1);
        }

        return result;
    }

    private static async Task<bool> TableExistsAsync(
        SqliteConnection connection,
        string tableName,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT 1 FROM sqlite_master WHERE type='table' AND name=@name LIMIT 1";
        command.Parameters.AddWithValue("@name", tableName);
        var value = await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false);
        return value is not null and not DBNull;
    }

    private static SqliteConnection OpenReadOnly(string path)
    {
        var connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = path,
            Mode = SqliteOpenMode.ReadOnly,
        }.ToString();
        return new SqliteConnection(connectionString);
    }

    private static DateTime? ReadDateTime(SqliteDataReader reader, int index)
    {
        var rawValue = reader.GetValue(index);
        if (rawValue is DateTime dateTime)
        {
            return dateTime.Kind == DateTimeKind.Unspecified
                ? DateTime.SpecifyKind(dateTime, DateTimeKind.Utc)
                : dateTime.ToUniversalTime();
        }

        if (rawValue is long unixTimestamp
            && unixTimestamp > 0
            && unixTimestamp <= DateTimeOffset.MaxValue.ToUnixTimeSeconds())
        {
            return DateTimeOffset.FromUnixTimeSeconds(unixTimestamp).UtcDateTime;
        }

        if (rawValue is string s
            && DateTime.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var parsed))
        {
            return parsed.Kind == DateTimeKind.Unspecified
                ? DateTime.SpecifyKind(parsed, DateTimeKind.Utc)
                : parsed.ToUniversalTime();
        }

        return null;
    }
}
