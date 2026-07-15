using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Plugin.Pgsql.Taste;
using Xunit;

namespace Jellyfin.Plugin.Pgsql.Tests.Taste;

public sealed class TasteMatchServiceTests
{
    [Fact]
    public void AssignTiers_Empty_ReturnsEmpty()
    {
        Assert.Empty(TasteMatchService.AssignTiers([]));
    }

    [Fact]
    public void AssignTiers_RelativeThresholds_SparseHighAndMid()
    {
        var scored = Enumerable.Range(1, 8)
            .Select(i => (Id: Guid.Parse($"00000000-0000-0000-0000-{i:D12}"), Score: i * 10))
            .ToList();

        var matches = TasteMatchService.AssignTiers(scored);
        Assert.Equal(4, matches.Count);

        var high = matches.Where(m => m.Tier == "high").ToList();
        var mid = matches.Where(m => m.Tier == "mid").ToList();
        Assert.Equal(2, high.Count);
        Assert.Equal(2, mid.Count);

        Assert.Equal(80, high[0].Score);
        Assert.Equal(70, high[1].Score);
        Assert.Equal(60, mid[0].Score);
        Assert.Equal(50, mid[1].Score);
    }

    [Fact]
    public void AssignTiers_SinglePositive_IsHigh()
    {
        var id = Guid.NewGuid();
        var matches = TasteMatchService.AssignTiers([(id, 42)]);
        Assert.Single(matches);
        Assert.Equal("high", matches[0].Tier);
        Assert.Equal(id, matches[0].ItemId);
    }

    [Fact]
    public void MaxBatchSize_IsSixtyFour()
    {
        Assert.Equal(64, TasteMatchService.MaxBatchSize);
    }
}
