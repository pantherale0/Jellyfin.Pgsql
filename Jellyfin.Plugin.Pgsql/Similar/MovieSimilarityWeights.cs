namespace Jellyfin.Plugin.Pgsql.Similar;

/// <summary>
/// Scoring constants for franchise-first movie similarity.
/// Collection weight must always exceed title-franchise + genre/people maxima.
/// </summary>
public static class MovieSimilarityWeights
{
    /// <summary>Co-membership in the same BoxSet.</summary>
    public const int CollectionWeight = 1_000_000;

    /// <summary>Maximum score from title word_similarity (similarity × this value).</summary>
    public const int TitleFranchiseMaxWeight = 500;

    /// <summary>Bonus when titles share a significant franchise token.</summary>
    public const int SharedSignificantTokenWeight = 250;

    /// <summary>Minimum pg_trgm word_similarity to count as title-franchise related.</summary>
    public const double TitleWordSimilarityFloor = 0.4;

    /// <summary>Genre overlap weight (matches core MovieSimilarItemsProvider).</summary>
    public const int GenreWeight = 10;

    /// <summary>Tag overlap weight.</summary>
    public const int TagWeight = 5;

    /// <summary>Studio overlap weight.</summary>
    public const int StudioWeight = 5;

    /// <summary>Director overlap weight.</summary>
    public const int DirectorWeight = 50;

    /// <summary>Actor / guest-star overlap weight.</summary>
    public const int ActorWeight = 15;
}
