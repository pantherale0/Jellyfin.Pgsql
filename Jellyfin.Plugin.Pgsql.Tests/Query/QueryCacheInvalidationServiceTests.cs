using System;
using Jellyfin.Plugin.Pgsql.Query;
using MediaBrowser.Model.Entities;
using Xunit;

namespace Jellyfin.Plugin.Pgsql.Tests.Query;

public sealed class QueryCacheInvalidationServiceTests
{
    [Theory]
    [InlineData(UserDataSaveReason.PlaybackProgress, false)]
    [InlineData(UserDataSaveReason.PlaybackStart, true)]
    [InlineData(UserDataSaveReason.PlaybackFinished, true)]
    [InlineData(UserDataSaveReason.TogglePlayed, true)]
    [InlineData(UserDataSaveReason.UpdateUserRating, true)]
    public void ShouldBumpUserCache_SkipsPlaybackProgress(UserDataSaveReason reason, bool expected)
    {
        Assert.Equal(expected, QueryCacheInvalidationService.ShouldBumpUserCache(reason));
    }
}

public sealed class MemoryQueryCacheVersionStoreTests
{
    [Fact]
    public void BumpUser_InvalidatesOnlyThatUser()
    {
        var store = new MemoryQueryCacheVersionStore();
        var userA = Guid.NewGuid();
        var userB = Guid.NewGuid();

        Assert.Equal(0, store.GetUserVersion(userA));
        Assert.Equal(0, store.GetLibraryVersion());

        store.BumpUser(userA);

        Assert.Equal(1, store.GetUserVersion(userA));
        Assert.Equal(0, store.GetUserVersion(userB));
        Assert.Equal(0, store.GetLibraryVersion());
    }

    [Fact]
    public void BumpLibrary_IncrementsLibraryVersion()
    {
        var store = new MemoryQueryCacheVersionStore();
        store.BumpLibrary();
        store.BumpLibrary();
        Assert.Equal(2, store.GetLibraryVersion());
    }
}

public sealed class QueryCacheKeyBuilderVersionTests
{
    [Fact]
    public void BuildResumeKey_IncludesVersionStamps()
    {
        var filter = new MediaBrowser.Controller.Entities.InternalItemsQuery
        {
            IsResumable = true,
        };

        var key = QueryCacheKeyBuilder.BuildResumeKey(filter, libraryVersion: 3, userVersion: 7);
        Assert.NotNull(key);
        Assert.StartsWith("lv3:uv7:resume:", key, StringComparison.Ordinal);
    }
}
