using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.Pgsql.Admin.EmbyImport;

/// <summary>
/// Preview / result counts for an Emby UserData import.
/// </summary>
public sealed class EmbyImportCounts
{
    /// <summary>
    /// Gets or sets the number of Emby UserDatas keys that matched a Jellyfin item.
    /// </summary>
    [JsonPropertyName("matchedKeys")]
    public int MatchedKeys { get; set; }

    /// <summary>
    /// Gets or sets the number of Emby keys with no matching Jellyfin item.
    /// </summary>
    [JsonPropertyName("unmatchedKeys")]
    public int UnmatchedKeys { get; set; }

    /// <summary>
    /// Gets or sets the number of distinct Jellyfin items that will receive data.
    /// </summary>
    [JsonPropertyName("matchedItems")]
    public int MatchedItems { get; set; }

    /// <summary>
    /// Gets or sets the number of items with no existing target UserData (new).
    /// </summary>
    [JsonPropertyName("itemsNew")]
    public int ItemsNew { get; set; }

    /// <summary>
    /// Gets or sets the number of items that already have target UserData (merged).
    /// </summary>
    [JsonPropertyName("itemsMerged")]
    public int ItemsMerged { get; set; }

    /// <summary>
    /// Gets or sets the number of Emby UserDatas rows read for the selected users.
    /// </summary>
    [JsonPropertyName("sourceRows")]
    public int SourceRows { get; set; }
}
