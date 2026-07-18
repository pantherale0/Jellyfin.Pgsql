namespace Jellyfin.Plugin.Pgsql.Api;

/// <summary>
/// Read-only taste feature flags for the admin shadow-eval page.
/// </summary>
public sealed class TasteShadowEvalStatusDto
{
    /// <summary>Gets or sets a value indicating whether taste profiles are enabled.</summary>
    public bool TasteEnabled { get; set; }

    /// <summary>Gets or sets a value indicating whether shadow training runs with profile rebuild.</summary>
    public bool ShadowTrainingEnabled { get; set; }

    /// <summary>Gets or sets a value indicating whether neural scores may affect live ranking.</summary>
    public bool NeuralServingEnabled { get; set; }
}
