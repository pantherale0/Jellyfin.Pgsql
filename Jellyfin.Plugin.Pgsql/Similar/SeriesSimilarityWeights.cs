namespace Jellyfin.Plugin.Pgsql.Similar;

/// <summary>
/// Scoring constants for series similarity (no franchise/collection tiers).
/// </summary>
public static class SeriesSimilarityWeights
{
    /// <summary>Genre overlap weight.</summary>
    public const int GenreWeight = 10;

    /// <summary>Tag overlap weight.</summary>
    public const int TagWeight = 5;

    /// <summary>Studio / network overlap weight.</summary>
    public const int StudioWeight = 8;

    /// <summary>Director overlap weight.</summary>
    public const int DirectorWeight = 40;

    /// <summary>Actor / guest-star overlap weight.</summary>
    public const int ActorWeight = 20;

    /// <summary>Absolute cap for user-taste bonus.</summary>
    public const int MaxTasteBonus = 180;
}
