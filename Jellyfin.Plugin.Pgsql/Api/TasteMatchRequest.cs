using System;
using System.Collections.Generic;

namespace Jellyfin.Plugin.Pgsql.Api;

/// <summary>
/// Match request body.
/// </summary>
public sealed class TasteMatchRequest
{
    /// <summary>Gets or sets user id.</summary>
    public Guid UserId { get; set; }

    /// <summary>Gets or sets item ids.</summary>
    public IReadOnlyList<Guid> ItemIds { get; set; } = [];
}
