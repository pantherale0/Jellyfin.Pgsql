using System;

namespace Jellyfin.Plugin.Pgsql.Api;

/// <summary>
/// Single match row.
/// </summary>
public sealed class TasteMatchItemDto
{
    /// <summary>Gets or sets item id.</summary>
    public Guid ItemId { get; set; }

    /// <summary>Gets or sets tier.</summary>
    public string Tier { get; set; } = string.Empty;

    /// <summary>Gets or sets score.</summary>
    public int Score { get; set; }
}
