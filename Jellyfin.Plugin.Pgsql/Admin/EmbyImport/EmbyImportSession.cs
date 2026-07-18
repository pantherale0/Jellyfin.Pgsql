using System;

namespace Jellyfin.Plugin.Pgsql.Admin.EmbyImport;

/// <summary>
/// An uploaded Emby database pair held for a single import wizard session.
/// </summary>
public sealed class EmbyImportSession
{
    /// <summary>
    /// Gets the session id.
    /// </summary>
    public required string SessionId { get; init; }

    /// <summary>
    /// Gets the directory containing the uploaded databases.
    /// </summary>
    public required string DirectoryPath { get; init; }

    /// <summary>
    /// Gets the path to the uploaded <c>library.db</c>.
    /// </summary>
    public required string LibraryDbPath { get; init; }

    /// <summary>
    /// Gets the path to the uploaded <c>users.db</c>.
    /// </summary>
    public required string UsersDbPath { get; init; }

    /// <summary>
    /// Gets the UTC creation time.
    /// </summary>
    public required DateTime CreatedUtc { get; init; }
}
