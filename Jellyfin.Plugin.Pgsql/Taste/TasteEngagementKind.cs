namespace Jellyfin.Plugin.Pgsql.Taste;

/// <summary>
/// Engagement classification for a media item relative to a user.
/// </summary>
public enum TasteEngagementKind
{
    /// <summary>No usable signal.</summary>
    None = 0,

    /// <summary>Favorite and/or like without relying on completion.</summary>
    FavoriteOrLike = 1,

    /// <summary>Played to completion or deep completion ratio.</summary>
    DeepPlay = 2,

    /// <summary>Partial but meaningful completion.</summary>
    MidPlay = 3,

    /// <summary>Short watch that did not return.</summary>
    Abandon = 4,
}
