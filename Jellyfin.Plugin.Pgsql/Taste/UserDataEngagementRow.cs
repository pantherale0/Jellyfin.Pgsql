using System;
using System.Collections.Generic;

namespace Jellyfin.Plugin.Pgsql.Taste;

/// <summary>
/// Engagement fields from one or more <c>UserData</c> rows for a single library item.
/// Jellyfin keys <c>UserData</c> by (<c>ItemId</c>, <c>UserId</c>, <c>CustomDataKey</c>),
/// so alternate versions can produce multiple rows per item.
/// </summary>
/// <param name="ItemId">Library item id.</param>
/// <param name="IsFavorite">Whether any row is favorited.</param>
/// <param name="Likes">Explicit like/dislike when present.</param>
/// <param name="Played">Whether any row is marked played.</param>
/// <param name="PlayCount">Highest play count across rows.</param>
/// <param name="Rating">First non-null user rating.</param>
/// <param name="PlaybackPositionTicks">Highest playback position across rows.</param>
/// <param name="LastPlayedDate">Latest play timestamp across rows.</param>
/// <param name="RunTimeTicks">Item runtime when known.</param>
internal readonly record struct UserDataEngagementRow(
    Guid ItemId,
    bool IsFavorite,
    bool? Likes,
    bool Played,
    int PlayCount,
    double? Rating,
    long PlaybackPositionTicks,
    DateTime? LastPlayedDate,
    long? RunTimeTicks);

/// <summary>
/// Collapses multi-key <c>UserData</c> rows to one engagement snapshot per item.
/// </summary>
internal static class UserDataEngagementAggregation
{
    /// <summary>
    /// Merges two rows for the same item using the same field rules as user-data conflict merge.
    /// </summary>
    /// <param name="target">Row to keep as the base.</param>
    /// <param name="source">Row being absorbed.</param>
    /// <returns>Merged engagement snapshot.</returns>
    public static UserDataEngagementRow Merge(UserDataEngagementRow target, UserDataEngagementRow source)
    {
        DateTime? lastPlayed = target.LastPlayedDate;
        if (source.LastPlayedDate is not null
            && (lastPlayed is null || source.LastPlayedDate > lastPlayed))
        {
            lastPlayed = source.LastPlayedDate;
        }

        return new UserDataEngagementRow(
            ItemId: target.ItemId,
            IsFavorite: target.IsFavorite || source.IsFavorite,
            Likes: target.Likes ?? source.Likes,
            Played: target.Played || source.Played,
            PlayCount: Math.Max(target.PlayCount, source.PlayCount),
            Rating: target.Rating ?? source.Rating,
            PlaybackPositionTicks: Math.Max(target.PlaybackPositionTicks, source.PlaybackPositionTicks),
            LastPlayedDate: lastPlayed,
            RunTimeTicks: target.RunTimeTicks ?? source.RunTimeTicks);
    }

    /// <summary>
    /// Builds a dictionary keyed by item id, merging duplicate keys.
    /// </summary>
    /// <param name="rows">Engagement rows that may share an item id.</param>
    /// <returns>One merged row per item id.</returns>
    public static Dictionary<Guid, UserDataEngagementRow> ToDictionaryByItemId(
        IEnumerable<UserDataEngagementRow> rows)
    {
        ArgumentNullException.ThrowIfNull(rows);

        var result = new Dictionary<Guid, UserDataEngagementRow>();
        foreach (var row in rows)
        {
            if (result.TryGetValue(row.ItemId, out var existing))
            {
                result[row.ItemId] = Merge(existing, row);
            }
            else
            {
                result[row.ItemId] = row;
            }
        }

        return result;
    }
}
