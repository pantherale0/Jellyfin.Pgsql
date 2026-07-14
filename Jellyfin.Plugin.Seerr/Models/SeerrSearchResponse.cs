using System.Collections.Generic;

namespace Jellyfin.Plugin.Seerr.Models;

/// <summary>
/// Search response returned to Jellyfin clients.
/// </summary>
public sealed class SeerrSearchResponse
{
    /// <summary>
    /// Gets or sets requestable search results.
    /// </summary>
    public IReadOnlyList<SeerrSearchItem> Items { get; set; } = [];
}
