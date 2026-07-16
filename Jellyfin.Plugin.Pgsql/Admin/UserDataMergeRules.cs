using System;
using Jellyfin.Database.Implementations.Entities;

namespace Jellyfin.Plugin.Pgsql.Admin;

/// <summary>
/// Conflict-resolution helpers for merging <see cref="UserData"/> rows.
/// </summary>
internal static class UserDataMergeRules
{
    /// <summary>
    /// Merges <paramref name="source"/> into <paramref name="target"/> in place.
    /// </summary>
    /// <param name="target">The row to keep.</param>
    /// <param name="source">The row being absorbed.</param>
    public static void MergeInto(UserData target, UserData source)
    {
        ArgumentNullException.ThrowIfNull(target);
        ArgumentNullException.ThrowIfNull(source);

        target.Played = target.Played || source.Played;
        target.IsFavorite = target.IsFavorite || source.IsFavorite;
        target.PlayCount = Math.Max(target.PlayCount, source.PlayCount);

        if (source.LastPlayedDate is not null
            && (target.LastPlayedDate is null || source.LastPlayedDate > target.LastPlayedDate))
        {
            target.LastPlayedDate = source.LastPlayedDate;
            target.AudioStreamIndex = source.AudioStreamIndex ?? target.AudioStreamIndex;
            target.SubtitleStreamIndex = source.SubtitleStreamIndex ?? target.SubtitleStreamIndex;
        }
        else
        {
            target.AudioStreamIndex ??= source.AudioStreamIndex;
            target.SubtitleStreamIndex ??= source.SubtitleStreamIndex;
        }

        target.Rating ??= source.Rating;
        target.Likes ??= source.Likes;

        if (source.PlaybackPositionTicks > target.PlaybackPositionTicks)
        {
            target.PlaybackPositionTicks = source.PlaybackPositionTicks;
        }

        if (source.RetentionDate is not null
            && (target.RetentionDate is null || source.RetentionDate > target.RetentionDate))
        {
            target.RetentionDate = source.RetentionDate;
        }
    }
}
