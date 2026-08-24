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

    /// <summary>Gets or sets a value indicating whether neural scores may affect stored For You / Because you X rankings.</summary>
    public bool NeuralServingEnabled { get; set; }

    /// <summary>Gets or sets a value indicating whether a shadow model is loaded for inference.</summary>
    public bool NeuralModelLoaded { get; set; }

    /// <summary>Gets or sets the loaded model filename, or null.</summary>
    public string? NeuralModelPath { get; set; }

    /// <summary>Gets or sets the live matured For You impression→engage rate.</summary>
    public double? ForYouEngageRate { get; set; }

    /// <summary>Gets or sets the For You engage window in days.</summary>
    public int ForYouEngageWindowDays { get; set; }

    /// <summary>Gets or sets the matured distinct For You impression count.</summary>
    public int ForYouImpressionCount { get; set; }

    /// <summary>Gets or sets the matured For You engage count.</summary>
    public int ForYouEngageCount { get; set; }
}
