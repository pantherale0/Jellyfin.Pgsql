using System;

namespace Jellyfin.Plugin.Pgsql.Admin.EmbyImport;

/// <summary>
/// A single row from Emby's <c>UserDatas</c> table.
/// </summary>
public sealed class EmbyUserDataRow
{
    /// <summary>
    /// Gets the userdata key (provider id, guid, etc.).
    /// </summary>
    public required string Key { get; init; }

    /// <summary>
    /// Gets the Emby internal user id.
    /// </summary>
    public required int UserId { get; init; }

    /// <summary>
    /// Gets the rating.
    /// </summary>
    public double? Rating { get; init; }

    /// <summary>
    /// Gets a value indicating whether the item was played.
    /// </summary>
    public required bool Played { get; init; }

    /// <summary>
    /// Gets the play count.
    /// </summary>
    public required int PlayCount { get; init; }

    /// <summary>
    /// Gets a value indicating whether the item is a favorite.
    /// </summary>
    public required bool IsFavorite { get; init; }

    /// <summary>
    /// Gets the playback position in ticks.
    /// </summary>
    public required long PlaybackPositionTicks { get; init; }

    /// <summary>
    /// Gets the last played date.
    /// </summary>
    public DateTime? LastPlayedDate { get; init; }

    /// <summary>
    /// Gets the audio stream index.
    /// </summary>
    public int? AudioStreamIndex { get; init; }

    /// <summary>
    /// Gets the subtitle stream index.
    /// </summary>
    public int? SubtitleStreamIndex { get; init; }
}
