using System;

namespace Jellyfin.Plugin.Pgsql.Api;

/// <summary>
/// People affinity row.
/// </summary>
public sealed class TastePersonDto
{
    /// <summary>Gets or sets people id.</summary>
    public Guid Id { get; set; }

    /// <summary>Gets or sets display name.</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>Gets or sets role (director/actor).</summary>
    public string Role { get; set; } = string.Empty;

    /// <summary>Gets or sets weight.</summary>
    public float Weight { get; set; }
}
