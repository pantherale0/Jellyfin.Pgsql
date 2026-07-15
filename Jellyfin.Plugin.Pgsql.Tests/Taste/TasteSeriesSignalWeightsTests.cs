using Jellyfin.Plugin.Pgsql.Taste;
using Xunit;

namespace Jellyfin.Plugin.Pgsql.Tests.Taste;

public sealed class TasteSeriesSignalWeightsTests
{
    [Fact]
    public void BingeCappedPlayWeight_ZeroOrNegative_IsZero()
    {
        Assert.Equal(0f, TasteSeriesSignalWeights.BingeCappedPlayWeight(0));
        Assert.Equal(0f, TasteSeriesSignalWeights.BingeCappedPlayWeight(-3));
    }

    [Fact]
    public void BingeCappedPlayWeight_SingleEpisode_IsBaseWeight()
    {
        // log2(1+1) = 1 → base * 1
        Assert.Equal(TasteSeriesSignalWeights.BaseSeriesPlayWeight, TasteSeriesSignalWeights.BingeCappedPlayWeight(1));
    }

    [Fact]
    public void BingeCappedPlayWeight_IsLessThanUnboundedSum()
    {
        const int episodes = 40;
        var capped = TasteSeriesSignalWeights.BingeCappedPlayWeight(episodes);
        var unbounded = TasteSeriesSignalWeights.BaseSeriesPlayWeight * episodes;
        Assert.True(capped < unbounded);
        Assert.True(capped <= TasteSeriesSignalWeights.BaseSeriesPlayWeight * TasteSeriesSignalWeights.MaxBingeMultiplier);
    }

    [Fact]
    public void BingeCappedPlayWeight_ManyEpisodes_HitsCap()
    {
        // log2(1+n) >= 2 when n >= 3
        var weight = TasteSeriesSignalWeights.BingeCappedPlayWeight(100);
        Assert.Equal(
            TasteSeriesSignalWeights.BaseSeriesPlayWeight * TasteSeriesSignalWeights.MaxBingeMultiplier,
            weight);
    }

    [Theory]
    [InlineData(1, 2)]
    [InlineData(2, 3)]
    [InlineData(3, 10)]
    public void BingeCappedPlayWeight_IsMonotonicNonDecreasing(int fewer, int more)
    {
        Assert.True(
            TasteSeriesSignalWeights.BingeCappedPlayWeight(fewer)
            <= TasteSeriesSignalWeights.BingeCappedPlayWeight(more));
    }
}
