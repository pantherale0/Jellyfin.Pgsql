using System;
using System.Collections.Concurrent;
using System.Threading;

namespace Jellyfin.Plugin.Pgsql.Query;

/// <summary>
/// In-process <see cref="IQueryCacheVersionStore"/>.
/// </summary>
internal sealed class MemoryQueryCacheVersionStore : IQueryCacheVersionStore
{
    private readonly ConcurrentDictionary<Guid, long> _userVersions = new();
    private long _libraryVersion;

    /// <inheritdoc />
    public long GetLibraryVersion() => Interlocked.Read(ref _libraryVersion);

    /// <inheritdoc />
    public long GetUserVersion(Guid userId)
        => _userVersions.TryGetValue(userId, out var version) ? version : 0;

    /// <inheritdoc />
    public void BumpUser(Guid userId)
        => _userVersions.AddOrUpdate(userId, 1, static (_, current) => current + 1);

    /// <inheritdoc />
    public void BumpLibrary() => Interlocked.Increment(ref _libraryVersion);
}
