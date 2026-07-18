namespace Jellyfin.Plugin.Pgsql.Admin.EmbyImport;

/// <summary>
/// Preview / result counts for an Emby UserData import.
/// </summary>
public sealed class EmbyImportCounts
{
    /// <summary>
    /// Gets or sets the number of Emby UserDatas keys that matched a Jellyfin item.
    /// </summary>
    public int MatchedKeys { get; set; }

    /// <summary>
    /// Gets or sets the number of Emby keys with no matching Jellyfin item.
    /// </summary>
    public int UnmatchedKeys { get; set; }

    /// <summary>
    /// Gets or sets the number of distinct Jellyfin items that will receive data.
    /// </summary>
    public int MatchedItems { get; set; }

    /// <summary>
    /// Gets or sets the number of items with no existing target UserData (new).
    /// </summary>
    public int ItemsNew { get; set; }

    /// <summary>
    /// Gets or sets the number of items that already have target UserData (merged).
    /// </summary>
    public int ItemsMerged { get; set; }

    /// <summary>
    /// Gets or sets the number of Emby UserDatas rows read for the selected users.
    /// </summary>
    public int SourceRows { get; set; }
}
