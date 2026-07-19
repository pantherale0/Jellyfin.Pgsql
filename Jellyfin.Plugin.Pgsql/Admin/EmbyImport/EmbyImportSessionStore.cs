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

    /// <summary>Chunk size used for Cloudflare-safe uploads (8 MiB).</summary>
    public const int ChunkSizeBytes = 8 * 1024 * 1024;

    /// <summary>Maximum size of a single Emby database file.</summary>
    public const long MaxFileBytes = 512L * 1024 * 1024;

    private static readonly TimeSpan SessionTtl = TimeSpan.FromHours(1);
    private static readonly byte[] SqliteHeaderBytes = "SQLite format 3\0"u8.ToArray();

    private readonly ConcurrentDictionary<string, EmbyImportSession> _sessions = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _sessionLocks = new(StringComparer.Ordinal);
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
    /// Creates a pending chunked-upload session.
    /// </summary>
    /// <param name="libraryDbBytes">Declared library.db size.</param>
    /// <param name="usersDbBytes">Declared users.db size.</param>
    /// <param name="createdByUserId">Administrator who started the upload.</param>
    /// <returns>The pending session.</returns>
    public EmbyImportSession CreatePending(long libraryDbBytes, long usersDbBytes, Guid createdByUserId)
    {
        if (createdByUserId == Guid.Empty)
        {
            throw new EmbyImportException("Authenticated user id is required.");
        }

        if (libraryDbBytes <= 0 || usersDbBytes <= 0)
        {
            throw new EmbyImportException("library.db and users.db sizes must be greater than zero.");
        }

        if (libraryDbBytes > MaxFileBytes || usersDbBytes > MaxFileBytes)
        {
            throw new EmbyImportException(
                $"Each Emby database must be at most {MaxFileBytes / (1024 * 1024)} MB.");
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
            using (File.Create(libraryPath + ".part"))
            {
            }

            using (File.Create(usersPath + ".part"))
            {
            }

            var session = new EmbyImportSession
            {
                SessionId = sessionId,
                DirectoryPath = directory,
                LibraryDbPath = libraryPath,
                UsersDbPath = usersPath,
                CreatedUtc = DateTime.UtcNow,
                CreatedByUserId = createdByUserId,
                ExpectedLibraryBytes = libraryDbBytes,
                ExpectedUsersBytes = usersDbBytes,
            };

            if (!_sessions.TryAdd(sessionId, session))
            {
                DeleteDirectory(directory);
                throw new EmbyImportException("Failed to register import session.");
            }

            _sessionLocks[sessionId] = new SemaphoreSlim(1, 1);
            return session;
        }
        catch
        {
            DeleteDirectory(directory);
            throw;
        }
    }

    /// <summary>
    /// Appends one sequential chunk to a pending upload.
    /// </summary>
    /// <param name="sessionId">Session id.</param>
    /// <param name="callerUserId">Authenticated administrator.</param>
    /// <param name="fileKind">Which file the chunk belongs to.</param>
    /// <param name="chunkIndex">Zero-based chunk index.</param>
    /// <param name="chunk">Chunk stream.</param>
    /// <param name="chunkLength">Declared chunk length.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task representing the operation.</returns>
    public async Task AppendChunkAsync(
        string sessionId,
        Guid callerUserId,
        EmbyUploadFileKind fileKind,
        int chunkIndex,
        Stream chunk,
        long chunkLength,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(chunk);

        if (chunkIndex < 0)
        {
            throw new EmbyImportException("chunkIndex must be non-negative.");
        }

        if (chunkLength <= 0 || chunkLength > ChunkSizeBytes)
        {
            throw new EmbyImportException($"Each chunk must be between 1 and {ChunkSizeBytes} bytes.");
        }

        var session = GetOwnedSession(sessionId, callerUserId, requireFinalized: false);
        var gate = GetSessionLock(session.SessionId);

        var buffer = new byte[chunkLength];
        var offset = 0;
        while (offset < buffer.Length)
        {
            var read = await chunk.ReadAsync(buffer.AsMemory(offset, buffer.Length - offset), cancellationToken)
                .ConfigureAwait(false);
            if (read == 0)
            {
                break;
            }

            offset += read;
        }

        if (offset != chunkLength)
        {
            throw new EmbyImportException("Chunk length did not match the uploaded body.");
        }

        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (session.IsFinalized)
            {
                throw new EmbyImportException("Upload session is already finalized.");
            }

            var (expectedBytes, received, nextIndex, partPath, label) = fileKind switch
            {
                EmbyUploadFileKind.LibraryDb => (
                    session.ExpectedLibraryBytes,
                    session.LibraryBytesReceived,
                    session.LibraryNextChunkIndex,
                    session.LibraryPartPath,
                    "library.db"),
                EmbyUploadFileKind.UsersDb => (
                    session.ExpectedUsersBytes,
                    session.UsersBytesReceived,
                    session.UsersNextChunkIndex,
                    session.UsersPartPath,
                    "users.db"),
                _ => throw new EmbyImportException("Unknown upload file kind."),
            };

            if (chunkIndex != nextIndex)
            {
                throw new EmbyImportException(
                    $"Unexpected chunk index for {label}: expected {nextIndex}, got {chunkIndex}.");
            }

            if (received + chunkLength > expectedBytes)
            {
                throw new EmbyImportException($"{label} upload exceeds the declared size.");
            }

            if (chunkIndex == 0)
            {
                if (buffer.Length < SqliteHeaderBytes.Length
                    || !buffer.AsSpan(0, SqliteHeaderBytes.Length).SequenceEqual(SqliteHeaderBytes))
                {
                    throw new EmbyImportException($"{label} is not a valid SQLite database.");
                }
            }

            await using (var file = new FileStream(
                             partPath,
                             FileMode.Append,
                             FileAccess.Write,
                             FileShare.None,
                             bufferSize: 1024 * 128,
                             FileOptions.Asynchronous | FileOptions.SequentialScan))
            {
                await file.WriteAsync(buffer.AsMemory(0, buffer.Length), cancellationToken).ConfigureAwait(false);
                await file.FlushAsync(cancellationToken).ConfigureAwait(false);
            }

            if (fileKind == EmbyUploadFileKind.LibraryDb)
            {
                session.LibraryBytesReceived = received + chunkLength;
                session.LibraryNextChunkIndex = nextIndex + 1;
            }
            else
            {
                session.UsersBytesReceived = received + chunkLength;
                session.UsersNextChunkIndex = nextIndex + 1;
            }
        }
        finally
        {
            gate.Release();
        }
    }

    /// <summary>
    /// Finalizes a pending upload after all chunks arrive.
    /// </summary>
    /// <param name="sessionId">Session id.</param>
    /// <param name="callerUserId">Authenticated administrator.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The finalized session.</returns>
    public async Task<EmbyImportSession> FinalizeAsync(
        string sessionId,
        Guid callerUserId,
        CancellationToken cancellationToken)
    {
        var session = GetOwnedSession(sessionId, callerUserId, requireFinalized: false);
        var gate = GetSessionLock(session.SessionId);

        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (session.IsFinalized)
            {
                return session;
            }

            if (session.LibraryBytesReceived != session.ExpectedLibraryBytes)
            {
                throw new EmbyImportException(
                    $"library.db upload incomplete: received {session.LibraryBytesReceived} of {session.ExpectedLibraryBytes} bytes.");
            }

            if (session.UsersBytesReceived != session.ExpectedUsersBytes)
            {
                throw new EmbyImportException(
                    $"users.db upload incomplete: received {session.UsersBytesReceived} of {session.ExpectedUsersBytes} bytes.");
            }

            ValidateSqliteFile(session.LibraryPartPath, "library.db");
            ValidateSqliteFile(session.UsersPartPath, "users.db");

#pragma warning disable CA3003 // Paths are created under a fixed data root with validated session ids.
            File.Move(session.LibraryPartPath, session.LibraryDbPath, overwrite: true);
            File.Move(session.UsersPartPath, session.UsersDbPath, overwrite: true);
#pragma warning restore CA3003
            session.IsFinalized = true;
            return session;
        }
        finally
        {
            gate.Release();
        }
    }

    /// <summary>
    /// Gets a finalized session by id for the given administrator.
    /// </summary>
    /// <param name="sessionId">Session id.</param>
    /// <param name="callerUserId">Authenticated administrator user id.</param>
    /// <returns>The session.</returns>
    public EmbyImportSession GetRequired(string sessionId, Guid callerUserId)
        => GetOwnedSession(sessionId, callerUserId, requireFinalized: true);

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

        if (_sessionLocks.TryRemove(sessionId, out var gate))
        {
            gate.Dispose();
        }

        DeleteDirectory(session.DirectoryPath);
        return true;
    }

    private SemaphoreSlim GetSessionLock(string sessionId)
    {
        if (_sessionLocks.TryGetValue(sessionId, out var gate))
        {
            return gate;
        }

        throw new EmbyImportException("Import session was not found or has expired.");
    }

    private EmbyImportSession GetOwnedSession(string sessionId, Guid callerUserId, bool requireFinalized)
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

        if (requireFinalized && !session.IsFinalized)
        {
            throw new EmbyImportException("Upload is not complete. Finish uploading all chunks first.");
        }

        return session;
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

    private static void ValidateSqliteFile(string path, string label)
    {
        using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        var header = new byte[SqliteHeaderBytes.Length];
        var read = file.Read(header, 0, header.Length);
        if (read < header.Length || !header.AsSpan().SequenceEqual(SqliteHeaderBytes))
        {
            throw new EmbyImportException($"{label} is not a valid SQLite database.");
        }
    }

    private void CleanupExpired()
    {
        lock (_cleanupLock)
        {
            var cutoff = DateTime.UtcNow - SessionTtl;
            foreach (var key in _sessions
                         .Where(p => p.Value.CreatedUtc < cutoff)
                         .Select(p => p.Key)
                         .ToArray())
            {
                Delete(key);
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
