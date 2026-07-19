using System;

namespace Jellyfin.Plugin.Pgsql.Query;

/// <summary>
/// Version stamps used in query cache keys so invalidation can bump a counter instead of
/// scanning and deleting keys (including Redis KEYS).
/// </summary>
internal interface IQueryCacheVersionStore
{
    /// <summary>
    /// Gets the current library-wide cache generation.
    /// </summary>
    /// <returns>The library version.</returns>
    long GetLibraryVersion();

    /// <summary>
    /// Gets the current cache generation for a user.
    /// </summary>
    /// <param name="userId">The user id.</param>
    /// <returns>The user version.</returns>
    long GetUserVersion(Guid userId);

    /// <summary>
    /// Bumps the cache generation for a user so prior keys become unreachable.
    /// </summary>
    /// <param name="userId">The user id.</param>
    void BumpUser(Guid userId);

    /// <summary>
    /// Bumps the library-wide cache generation so prior keys become unreachable.
    /// </summary>
    void BumpLibrary();
}
