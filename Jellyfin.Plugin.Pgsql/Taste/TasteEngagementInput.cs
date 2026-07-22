using System;

namespace Jellyfin.Plugin.Pgsql.Taste;

/// <summary>
/// Input snapshot used to classify engagement for one item.
/// </summary>
/// <param name="IsFavorite">Whether the item is favorited.</param>
/// <param name="Likes">Explicit like/dislike, or null.</param>
/// <param name="Played">Whether Jellyfin marked the item played.</param>
/// <param name="PlayCount">Play count.</param>
/// <param name="UserRating">Optional user rating 0–10.</param>
/// <param name="MaxPlayedTicks">Max of UserData position and PlaybackActivity played ticks.</param>
/// <param name="RunTimeTicks">Item runtime, or null/≤0 when unknown.</param>
/// <param name="LastPlayedUtc">Latest play timestamp UTC, if any.</param>
/// <param name="HasLaterPlayWithinNoReturnWindow">True when another play occurred within the abandon no-return window after the short watch.</param>
/// <param name="WasRecommended">True when a For You impression exists in the lookback window before engagement.</param>
public readonly record struct TasteEngagementInput(
    bool IsFavorite,
    bool? Likes,
    bool Played,
    int PlayCount,
    double? UserRating,
    long MaxPlayedTicks,
    long? RunTimeTicks,
    DateTime? LastPlayedUtc,
    bool HasLaterPlayWithinNoReturnWindow,
    bool WasRecommended);
