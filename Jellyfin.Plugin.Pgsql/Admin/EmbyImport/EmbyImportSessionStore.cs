using System;
using System.Collections.Concurrent;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Pgsql.Admin.EmbyImport;

/// <summary>
/// Stores uploaded Emby databases in a temp directory for one-shot import sessions.
/// </summary>
public sealed partial class EmbyImportSessionStore
{
    /// <summary>Maximum concurrent live import sessions.</summary>
    public const int MaxConcurrentSessions = 3;

    private static readonly TimeSpan SessionTtl = TimeSpan.FromHours(1);
    private static readonly byte[] SqliteHeaderBytes = "SQLite format 3\0"u8.ToArray();

    private readonly ConcurrentDictionary<string, EmbyImportSession> _sessions = new(StringComparer.Ordinal);
    private readonly string _rootPath;
    private readonly ILogger<EmbyImportSessionStore> _logger;
    private readonly object _cleanupLock = new();

    /// <summary>
    /// Initializes a new instance of the <see cref="EmbyImportSessionStore"/> class.
    /// </summary>
    /// <param name="appPaths">Application paths.</param>
    /// <param name="logger">Logger.</param>
    public EmbyImportSessionStore(IApplicationPaths appPaths, ILogger<EmbyImportSessionStore> logger)
    {
        ArgumentNullException.ThrowIfNull(appPaths);
        _logger = logger;
        _rootPath = Path.Join(appPaths.DataPath, "pgsql-emby-import");
        Directory.CreateDirectory(_rootPath);
    }

    /// <summary>
    /// Creates a session from uploaded database streams.
    /// </summary>
    /// <param name="libraryDb">Library database stream.</param>
    /// <param name="usersDb">Users database stream.</param>
    /// <param name="createdByUserId">Administrator who uploaded the databases.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The created session.</returns>
    public async Task<EmbyImportSession> CreateAsync(
        Stream libraryDb,
        Stream usersDb,
        Guid createdByUserId,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(libraryDb);
        ArgumentNullException.ThrowIfNull(usersDb);
        if (createdByUserId == Guid.Empty)
        {
            throw new EmbyImportException("Authenticated user id is required.");
        }

        CleanupExpired();

        if (_sessions.Count >= MaxConcurrentSessions)
        {
            throw new EmbyImportException(
                $"Too many active Emby import sessions (max {MaxConcurrentSessions}). Discard or wait for an existing session to expire.");
        }

        var sessionId = Guid.NewGuid().ToString("N", CultureInfo.InvariantCulture);
        var directory = Path.Join(_rootPath, sessionId);
        Directory.CreateDirectory(directory);

        var libraryPath = Path.Join(directory, "library.db");
        var usersPath = Path.Join(directory, "users.db");

        try
        {
            await WriteValidatedSqliteAsync(libraryDb, libraryPath, "library.db", cancellationToken)
                .ConfigureAwait(false);
            await WriteValidatedSqliteAsync(usersDb, usersPath, "users.db", cancellationToken)
                .ConfigureAwait(false);

            var session = new EmbyImportSession
            {
                SessionId = sessionId,
                DirectoryPath = directory,
                LibraryDbPath = libraryPath,
                UsersDbPath = usersPath,
                CreatedUtc = DateTime.UtcNow,
                CreatedByUserId = createdByUserId,
            };

            if (!_sessions.TryAdd(sessionId, session))
            {
                DeleteDirectory(directory);
                throw new EmbyImportException("Failed to register import session.");
            }

            return session;
        }
        catch
        {
            DeleteDirectory(directory);
            throw;
        }
    }

    /// <summary>
    /// Gets a session by id for the given administrator, or throws if missing/expired/unauthorized.
    /// </summary>
    /// <param name="sessionId">Session id.</param>
    /// <param name="callerUserId">Authenticated administrator user id.</param>
    /// <returns>The session.</returns>
    public EmbyImportSession GetRequired(string sessionId, Guid callerUserId)
    {
        var safeId = NormalizeSessionId(sessionId);
        CleanupExpired();

        if (!_sessions.TryGetValue(safeId, out var session))
        {
            throw new EmbyImportException("Import session was not found or has expired.");
        }

        if (DateTime.UtcNow - session.CreatedUtc > SessionTtl)
        {
            Delete(safeId);
            throw new EmbyImportException("Import session has expired.");
        }

        if (session.CreatedByUserId != callerUserId)
        {
            throw new EmbyImportException("Import session was not found or has expired.");
        }

        return session;
    }

    /// <summary>
    /// Deletes a session owned by <paramref name="callerUserId"/>.
    /// </summary>
    /// <param name="sessionId">Session id.</param>
    /// <param name="callerUserId">Authenticated administrator user id.</param>
    /// <returns><c>true</c> if a session was removed.</returns>
    public bool Delete(string sessionId, Guid callerUserId)
    {
        if (string.IsNullOrWhiteSpace(sessionId) || !SessionIdRegex().IsMatch(sessionId))
        {
            return false;
        }

        if (!_sessions.TryGetValue(sessionId, out var existing)
            || existing.CreatedByUserId != callerUserId)
        {
            return false;
        }

        return Delete(sessionId);
    }

    /// <summary>
    /// Deletes a session and its files.
    /// </summary>
    /// <param name="sessionId">Session id.</param>
    /// <returns><c>true</c> if a session was removed.</returns>
    public bool Delete(string sessionId)
    {
        if (string.IsNullOrWhiteSpace(sessionId) || !SessionIdRegex().IsMatch(sessionId))
        {
            return false;
        }

        if (!_sessions.TryRemove(sessionId, out var session))
        {
            return false;
        }

        DeleteDirectory(session.DirectoryPath);
        return true;
    }

    private static string NormalizeSessionId(string sessionId)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sessionId);
        if (!SessionIdRegex().IsMatch(sessionId))
        {
            throw new EmbyImportException("Import session was not found or has expired.");
        }

        return sessionId;
    }

    private async Task WriteValidatedSqliteAsync(
        Stream source,
        string destinationPath,
        string label,
        CancellationToken cancellationToken)
    {
        await using var file = new FileStream(
            destinationPath,
            FileMode.CreateNew,
            FileAccess.Write,
            FileShare.None,
            bufferSize: 1024 * 128,
            FileOptions.Asynchronous | FileOptions.SequentialScan);

        var header = new byte[16];
        var read = await source.ReadAsync(header.AsMemory(0, header.Length), cancellationToken)
            .ConfigureAwait(false);
        if (read < header.Length || !header.AsSpan().SequenceEqual(SqliteHeaderBytes))
        {
            throw new EmbyImportException($"{label} is not a valid SQLite database.");
        }

        await file.WriteAsync(header.AsMemory(0, header.Length), cancellationToken).ConfigureAwait(false);
        await source.CopyToAsync(file, cancellationToken).ConfigureAwait(false);
        await file.FlushAsync(cancellationToken).ConfigureAwait(false);
    }

    private void CleanupExpired()
    {
        lock (_cleanupLock)
        {
            var cutoff = DateTime.UtcNow - SessionTtl;
            foreach (var expired in _sessions
                         .Where(p => p.Value.CreatedUtc < cutoff)
                         .Select(p => p.Key)
                         .Select(key => _sessions.TryRemove(key, out var session) ? session : null)
                         .Where(session => session is not null))
            {
                DeleteDirectory(expired!.DirectoryPath);
            }

            if (!Directory.Exists(_rootPath))
            {
                return;
            }

            foreach (var dir in Directory.EnumerateDirectories(_rootPath))
            {
                var name = Path.GetFileName(dir);
                if (string.IsNullOrEmpty(name) || !SessionIdRegex().IsMatch(name) || _sessions.ContainsKey(name))
                {
                    continue;
                }

                try
                {
                    var created = Directory.GetCreationTimeUtc(dir);
                    if (created < cutoff)
                    {
                        DeleteDirectory(dir);
                    }
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    if (_logger.IsEnabled(LogLevel.Debug))
                    {
                        _logger.LogDebug(ex, "Failed to inspect orphan Emby import directory {Path}", dir);
                    }
                }
            }
        }
    }

#pragma warning disable CA3003 // Paths are created under a fixed data root with validated session ids.
    private void DeleteDirectory(string path)
    {
        try
        {
            var fullPath = Path.GetFullPath(path);
            var rootFullPath = Path.GetFullPath(_rootPath);
            if (!fullPath.StartsWith(rootFullPath + Path.DirectorySeparatorChar, StringComparison.Ordinal)
                && !string.Equals(fullPath, rootFullPath, StringComparison.Ordinal))
            {
                return;
            }

            if (Directory.Exists(fullPath))
            {
                Directory.Delete(fullPath, recursive: true);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            if (_logger.IsEnabled(LogLevel.Warning))
            {
                _logger.LogWarning(ex, "Failed to delete Emby import session directory {Path}", path);
            }
        }
    }
#pragma warning restore CA3003

    [GeneratedRegex("^[a-fA-F0-9]{32}$", RegexOptions.CultureInvariant)]
    private static partial Regex SessionIdRegex();
}
