namespace Jellyfin.Plugin.Pgsql.Admin.EmbyImport;

/// <summary>
/// Which Emby database file a chunk belongs to.
/// </summary>
public enum EmbyUploadFileKind
{
    /// <summary>
    /// Emby <c>library.db</c>.
    /// </summary>
    LibraryDb = 0,

    /// <summary>
    /// Emby <c>users.db</c>.
    /// </summary>
    UsersDb = 1,
}
