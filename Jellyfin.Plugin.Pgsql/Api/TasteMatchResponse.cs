using System.Collections.Generic;

namespace Jellyfin.Plugin.Pgsql.Api;

/// <summary>
/// Match response.
/// </summary>
public sealed class TasteMatchResponse
{
    /// <summary>Gets or sets matches.</summary>
    public IReadOnlyList<TasteMatchItemDto> Matches { get; set; } = [];
}
