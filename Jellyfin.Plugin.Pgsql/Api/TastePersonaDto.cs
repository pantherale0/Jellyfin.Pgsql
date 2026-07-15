namespace Jellyfin.Plugin.Pgsql.Api;

/// <summary>
/// Persona surface for the UI.
/// </summary>
public sealed class TastePersonaDto
{
    /// <summary>Gets or sets structured code.</summary>
    public string Code { get; set; } = string.Empty;

    /// <summary>Gets or sets display title.</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>Gets or sets blurb.</summary>
    public string Blurb { get; set; } = string.Empty;

    /// <summary>Gets or sets focus (specialist/omnivore/unknown).</summary>
    public string Focus { get; set; } = "unknown";

    /// <summary>Gets or sets domain axis.</summary>
    public string? Domain { get; set; }

    /// <summary>Gets or sets stance axis.</summary>
    public string? Stance { get; set; }

    /// <summary>Gets or sets bar axis.</summary>
    public string? Bar { get; set; }
}
