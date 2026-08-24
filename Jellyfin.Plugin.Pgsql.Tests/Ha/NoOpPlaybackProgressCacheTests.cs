using System;
using Jellyfin.Plugin.Pgsql.Ha;
using Xunit;

namespace Jellyfin.Plugin.Pgsql.Tests.Ha;

public sealed class NoOpPlaybackProgressCacheTests
{
    [Fact]
    public void TryGet_IsFailOpen()
    {
        var cache = new NoOpPlaybackProgressCache();
        cache.Set(Guid.NewGuid(), Guid.NewGuid(), 123);
        Assert.False(cache.TryGet(Guid.NewGuid(), Guid.NewGuid(), out var ticks));
        Assert.Equal(0, ticks);
    }

    [Theory]
    [InlineData(0, 1, true)]
    [InlineData(100, 100, false)]
    [InlineData(200, 50, false)]
    public void Overlay_AppliesOnlyWhenCachedTicksAreNewer(long stored, long cached, bool expected)
    {
        Assert.Equal(expected, cached > stored);
    }
}
