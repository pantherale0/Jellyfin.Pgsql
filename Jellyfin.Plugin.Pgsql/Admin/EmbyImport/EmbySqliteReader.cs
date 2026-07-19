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
            byId[userId] = byId.TryGetValue(userId, out var existing)
                ? new EmbyUserInfo
                {
                    Id = existing.Id,
                    Name = existing.Name,
                    UserDataCount = count,
                }
                : new EmbyUserInfo
                {
                    Id = userId,
                    Name = string.Format(CultureInfo.InvariantCulture, "Unknown (id={0})", userId),
                    UserDataCount = count,
                };
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

        await using var connection = OpenReadOnly(libraryDbPath);
        await connection.OpenAsync(cancellationToken).ConfigureAwait(false);

        var schema = await DetectUserDataSchemaAsync(connection, cancellationToken).ConfigureAwait(false);
        await using var command = connection.CreateCommand();
        command.CommandText = schema switch
        {
            UserDataSchema.LegacyKeyColumn =>
                "SELECT key, userId, rating, played, playCount, isFavorite, playbackPositionTicks, " +
                "lastPlayedDate, AudioStreamIndex, SubtitleStreamIndex FROM UserDatas",
            UserDataSchema.KeyTableV2 =>
                "SELECT k.UserDataKey, d.userId, d.rating, d.played, d.playCount, d.isFavorite, " +
                "d.playbackPositionTicks, d.LastPlayedDateInt, d.AudioStreamIndex, d.SubtitleStreamIndex " +
                "FROM UserDatas d INNER JOIN UserDataKeys2 k ON k.Id = d.UserDataKeyId",
            _ => throw new EmbyImportException("Unsupported Emby UserDatas schema."),
        };

        var rows = new List<EmbyUserDataRow>();
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

            var key = reader.GetString(0);
            if (string.IsNullOrWhiteSpace(key))
            {
                continue;
            }

            rows.Add(new EmbyUserDataRow
            {
                Key = key,
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
                AudioStreamIndex = await ReadOptionalStreamIndexAsync(reader, 8, cancellationToken)
                    .ConfigureAwait(false),
                SubtitleStreamIndex = await ReadOptionalStreamIndexAsync(reader, 9, cancellationToken)
                    .ConfigureAwait(false),
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

        _ = await DetectUserDataSchemaAsync(connection, cancellationToken).ConfigureAwait(false);
    }

    private static async Task<UserDataSchema> DetectUserDataSchemaAsync(
        SqliteConnection connection,
        CancellationToken cancellationToken)
    {
        // Older Emby: UserDatas.key + lastPlayedDate.
        if (await ColumnExistsAsync(connection, "UserDatas", "key", cancellationToken).ConfigureAwait(false))
        {
            return UserDataSchema.LegacyKeyColumn;
        }

        // Current Emby: UserDatas.UserDataKeyId → UserDataKeys2.UserDataKey (+ LastPlayedDateInt).
        if (await TableExistsAsync(connection, "UserDataKeys2", cancellationToken).ConfigureAwait(false)
            && await ColumnExistsAsync(connection, "UserDatas", "UserDataKeyId", cancellationToken)
                .ConfigureAwait(false)
            && await ColumnExistsAsync(connection, "UserDataKeys2", "UserDataKey", cancellationToken)
                .ConfigureAwait(false))
        {
            return UserDataSchema.KeyTableV2;
        }

        throw new EmbyImportException(
            "Unsupported library.db UserDatas schema. Expected either a key column or UserDataKeys2.");
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

    private static async Task<bool> ColumnExistsAsync(
        SqliteConnection connection,
        string tableName,
        string columnName,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        // pragma_table_info(?) is parameterized; table names are only passed from compile-time constants.
        command.CommandText = "SELECT 1 FROM pragma_table_info(@table) WHERE name=@column LIMIT 1";
        command.Parameters.AddWithValue("@table", tableName);
        command.Parameters.AddWithValue("@column", columnName);
        var value = await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false);
        return value is not null and not DBNull;
    }

    private static async Task<int?> ReadOptionalStreamIndexAsync(
        SqliteDataReader reader,
        int index,
        CancellationToken cancellationToken)
    {
        if (await reader.IsDBNullAsync(index, cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        var value = reader.GetInt32(index);
        // Emby uses -1 for "unset" stream indexes.
        return value < 0 ? null : value;
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

        // Emby LastPlayedDateInt is unix seconds (INT/BIGINT depending on provider).
        var unixTimestamp = rawValue switch
        {
            long l => l,
            int i => (long)i,
            _ => 0L,
        };

        if (unixTimestamp > 0
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

    private enum UserDataSchema
    {
        LegacyKeyColumn,
        KeyTableV2,
    }
}
