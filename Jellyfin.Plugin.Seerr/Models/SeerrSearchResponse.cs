using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.Seerr.Models;

/// <summary>
/// Search response returned to Jellyfin clients.
/// </summary>
public sealed class SeerrSearchResponse
{
    /// <summary>
    /// Gets or sets requestable search results.
    /// </summary>
    [JsonPropertyName("items")]
    public IReadOnlyList<SeerrSearchItem> Items { get; set; } = [];
}
