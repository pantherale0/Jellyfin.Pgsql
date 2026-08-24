using System;
using System.Collections.Generic;

namespace Jellyfin.Plugin.Pgsql.Taste;

/// <summary>
/// Source-kind values stored on <c>UserTasteBecauseYouRecommendation</c>.
/// </summary>
public static class BecauseYouSourceKinds
{
    /// <summary>Baseline is a recently played movie.</summary>
    public const string RecentlyPlayed = "RecentlyPlayed";

    /// <summary>Baseline is a liked or favorited movie.</summary>
    public const string Liked = "Liked";
}
