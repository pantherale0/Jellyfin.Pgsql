using System;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.Pgsql.Ha;

/// <summary>
/// No-op overlay used when Redis progress cache cannot start.
/// </summary>
internal sealed class NoOpPlaybackProgressCache : IPlaybackProgressCache
{
    /// <inheritdoc />
    public void Set(Guid userId, Guid itemId, long positionTicks)
    {
    }

    /// <inheritdoc />
    public bool TryGet(Guid userId, Guid itemId, out long positionTicks)
    {
        positionTicks = 0;
        return false;
    }
}
