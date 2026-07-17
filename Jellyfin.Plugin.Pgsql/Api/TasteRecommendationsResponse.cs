using System.Collections.Generic;

namespace Jellyfin.Plugin.Pgsql.Api;

/// <summary>
/// Taste recommendations response for the home feed.
/// </summary>
public sealed class TasteRecommendationsResponse
{
    /// <summary>Gets or sets ranked recommendation items.</summary>
    public IReadOnlyList<TasteMatchItemDto> Items { get; set; } = [];
}
