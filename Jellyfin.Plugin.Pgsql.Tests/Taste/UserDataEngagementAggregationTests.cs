using System;
using System.Collections.Generic;
using Jellyfin.Plugin.Pgsql.Taste;
using Xunit;

namespace Jellyfin.Plugin.Pgsql.Tests.Taste;

public sealed class UserDataEngagementAggregationTests
{
    private static readonly Guid ItemId = Guid.Parse("302de25b-2fdb-f942-eebc-38c9b0f21b7c");

    [Fact]
    public void ToDictionaryByItemId_MergesDuplicateCustomDataKeyRows()
    {
        var older = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        var newer = new DateTime(2026, 6, 1, 0, 0, 0, DateTimeKind.Utc);
        var rows = new List<UserDataEngagementRow>
        {
            new(ItemId, IsFavorite: false, Likes: null, Played: true, PlayCount: 1, Rating: null, PlaybackPositionTicks: 100, LastPlayedDate: older, RunTimeTicks: 1000),
            new(ItemId, IsFavorite: true, Likes: true, Played: false, PlayCount: 3, Rating: 8.0, PlaybackPositionTicks: 50, LastPlayedDate: newer, RunTimeTicks: 1000),
        };

        var byItem = UserDataEngagementAggregation.ToDictionaryByItemId(rows);

        Assert.Single(byItem);
        var merged = byItem[ItemId];
        Assert.True(merged.IsFavorite);
        Assert.True(merged.Likes);
        Assert.True(merged.Played);
        Assert.Equal(3, merged.PlayCount);
        Assert.Equal(8.0, merged.Rating);
        Assert.Equal(100, merged.PlaybackPositionTicks);
        Assert.Equal(newer, merged.LastPlayedDate);
    }
}
