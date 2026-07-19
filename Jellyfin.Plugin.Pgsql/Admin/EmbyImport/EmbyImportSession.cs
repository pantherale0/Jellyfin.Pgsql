using System;

namespace Jellyfin.Plugin.Pgsql.Admin.EmbyImport;

/// <summary>
/// An uploaded Emby database pair held for a one-shot import wizard session.
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
    /// Gets the path to the finalized <c>library.db</c>.
    /// </summary>
    public required string LibraryDbPath { get; init; }

    /// <summary>
    /// Gets the path to the finalized <c>users.db</c>.
    /// </summary>
    public required string UsersDbPath { get; init; }

    /// <summary>
    /// Gets the path to the in-progress <c>library.db</c> part file.
    /// </summary>
    public string LibraryPartPath => LibraryDbPath + ".part";

    /// <summary>
    /// Gets the path to the in-progress <c>users.db</c> part file.
    /// </summary>
    public string UsersPartPath => UsersDbPath + ".part";

    /// <summary>
    /// Gets the UTC creation time.
    /// </summary>
    public required DateTime CreatedUtc { get; init; }

    /// <summary>
    /// Gets the Jellyfin user id of the administrator who created the session.
    /// </summary>
    public required Guid CreatedByUserId { get; init; }

    /// <summary>
    /// Gets the declared size of <c>library.db</c> in bytes.
    /// </summary>
    public required long ExpectedLibraryBytes { get; init; }

    /// <summary>
    /// Gets the declared size of <c>users.db</c> in bytes.
    /// </summary>
    public required long ExpectedUsersBytes { get; init; }

    /// <summary>
    /// Gets or sets bytes received for <c>library.db</c>.
    /// </summary>
    public long LibraryBytesReceived { get; set; }

    /// <summary>
    /// Gets or sets bytes received for <c>users.db</c>.
    /// </summary>
    public long UsersBytesReceived { get; set; }

    /// <summary>
    /// Gets or sets the next expected chunk index for <c>library.db</c>.
    /// </summary>
    public int LibraryNextChunkIndex { get; set; }

    /// <summary>
    /// Gets or sets the next expected chunk index for <c>users.db</c>.
    /// </summary>
    public int UsersNextChunkIndex { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether both files were finalized.
    /// </summary>
    public bool IsFinalized { get; set; }
}
