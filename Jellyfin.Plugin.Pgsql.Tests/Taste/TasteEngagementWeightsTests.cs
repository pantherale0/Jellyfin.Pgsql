using System;
using Jellyfin.Plugin.Pgsql.Taste;
using Xunit;

namespace Jellyfin.Plugin.Pgsql.Tests.Taste;

public sealed class TasteEngagementWeightsTests
{
    private static readonly DateTime Now = new(2026, 7, 22, 12, 0, 0, DateTimeKind.Utc);
    private static readonly long TwoHourRuntime = TimeSpan.FromHours(2).Ticks;
    private static readonly long NinetySeconds = TimeSpan.FromSeconds(90).Ticks;
    private static readonly long TenMinutes = TimeSpan.FromMinutes(10).Ticks;
    private static readonly long HundredMinutes = TimeSpan.FromMinutes(100).Ticks;

    [Fact]
    public void Classify_Favorite_IsFavoriteOrLike()
    {
        var input = Base(isFavorite: true, maxTicks: NinetySeconds, runTime: TwoHourRuntime, lastPlayedDaysAgo: 20);
        Assert.Equal(TasteEngagementKind.FavoriteOrLike, TasteEngagementWeights.Classify(input, Now));
    }

    [Fact]
    public void Classify_DeepCompletion_IsDeepPlay()
    {
        var input = Base(maxTicks: HundredMinutes, runTime: TwoHourRuntime, lastPlayedDaysAgo: 2);
        Assert.Equal(TasteEngagementKind.DeepPlay, TasteEngagementWeights.Classify(input, Now));
    }

    [Fact]
    public void Classify_MidCompletion_IsMidPlay()
    {
        var input = Base(maxTicks: TimeSpan.FromMinutes(40).Ticks, runTime: TwoHourRuntime, lastPlayedDaysAgo: 2);
        Assert.Equal(TasteEngagementKind.MidPlay, TasteEngagementWeights.Classify(input, Now));
    }

    [Fact]
    public void Classify_ShortWatchOldEnough_IsAbandon()
    {
        var input = Base(maxTicks: NinetySeconds, runTime: TwoHourRuntime, lastPlayedDaysAgo: 20);
        Assert.Equal(TasteEngagementKind.Abandon, TasteEngagementWeights.Classify(input, Now));
    }

    [Fact]
    public void Classify_ShortWatchTooRecent_IsNotAbandon()
    {
        var input = Base(maxTicks: NinetySeconds, runTime: TwoHourRuntime, lastPlayedDaysAgo: 3);
        Assert.Equal(TasteEngagementKind.None, TasteEngagementWeights.Classify(input, Now));
    }

    [Fact]
    public void Classify_LaterPlayWithinWindow_ClearsAbandon()
    {
        var input = Base(
            maxTicks: NinetySeconds,
            runTime: TwoHourRuntime,
            lastPlayedDaysAgo: 20,
            hasLaterPlay: true);
        Assert.Equal(TasteEngagementKind.None, TasteEngagementWeights.Classify(input, Now));
    }

    [Fact]
    public void Classify_MissingRuntimeWithPlayed_FallsBackToDeep()
    {
        var input = Base(played: true, playCount: 1, maxTicks: TenMinutes, runTime: null, lastPlayedDaysAgo: 2);
        Assert.Equal(TasteEngagementKind.DeepPlay, TasteEngagementWeights.Classify(input, Now));
    }

    [Fact]
    public void ComputeLinearWeight_AbandonIsNegative_RecAbandonStronger()
    {
        var plain = Base(maxTicks: NinetySeconds, runTime: TwoHourRuntime, lastPlayedDaysAgo: 20);
        var rec = plain with { WasRecommended = true };
        var plainW = TasteEngagementWeights.ComputeLinearWeight(plain, Now);
        var recW = TasteEngagementWeights.ComputeLinearWeight(rec, Now);
        Assert.True(plainW < 0);
        Assert.True(recW < plainW);
    }

    [Fact]
    public void ComputeLinearWeight_RecPositiveBoostsFavorite()
    {
        var plain = Base(isFavorite: true, played: true, playCount: 1, maxTicks: HundredMinutes, runTime: TwoHourRuntime, lastPlayedDaysAgo: 1);
        var rec = plain with { WasRecommended = true };
        var plainW = TasteEngagementWeights.ComputeLinearWeight(plain, Now);
        var recW = TasteEngagementWeights.ComputeLinearWeight(rec, Now);
        Assert.True(recW > plainW);
        Assert.True(Math.Abs(recW - (plainW * TasteEngagementWeights.RecPositiveEngageMultiplier)) < 0.001f);
    }

    [Fact]
    public void TryGetNeuralExample_AbandonIsNegativeLabel()
    {
        var input = Base(maxTicks: NinetySeconds, runTime: TwoHourRuntime, lastPlayedDaysAgo: 20, wasRecommended: true);
        Assert.True(TasteEngagementWeights.TryGetNeuralExample(input, Now, out var positive, out var weight));
        Assert.False(positive);
        var expected = TasteEngagementWeights.ApplyNeuralRecencyDecay(
            TasteEngagementWeights.NeuralRecAbandonWeight,
            Now.AddDays(-20),
            Now);
        Assert.Equal(expected, weight);
    }

    [Fact]
    public void ApplyNeuralRecencyDecay_AgesSampleWeight()
    {
        var fresh = TasteEngagementWeights.ApplyNeuralRecencyDecay(2f, Now, Now);
        var aged = TasteEngagementWeights.ApplyNeuralRecencyDecay(2f, Now.AddDays(-180), Now);
        Assert.Equal(2f, fresh);
        Assert.True(aged < fresh);
        Assert.InRange(aged, 0.7f, 0.8f);
    }

    [Fact]
    public void IsConfirmedImpressionSkip_RequiresConfirmWindow()
    {
        Assert.False(TasteEngagementWeights.IsConfirmedImpressionSkip(Now.AddDays(-3), Now));
        Assert.True(TasteEngagementWeights.IsConfirmedImpressionSkip(Now.AddDays(-14), Now));
        Assert.Equal(
            TasteEngagementWeights.AbandonNoReturnDays,
            TasteEngagementWeights.ImpressionSkipConfirmDays);
        Assert.Equal(0.75f, TasteEngagementWeights.NeuralImpressionSkipWeight);
    }

    [Fact]
    public void IsSeriesAbandon_MajorityOfFewEpisodes()
    {
        Assert.True(TasteEngagementWeights.IsSeriesAbandon(1, 1));
        Assert.True(TasteEngagementWeights.IsSeriesAbandon(2, 2));
        Assert.False(TasteEngagementWeights.IsSeriesAbandon(3, 3));
        Assert.False(TasteEngagementWeights.IsSeriesAbandon(2, 0));
    }

    private static TasteEngagementInput Base(
        bool isFavorite = false,
        bool? likes = null,
        bool played = false,
        int playCount = 0,
        long maxTicks = 0,
        long? runTime = 0,
        int lastPlayedDaysAgo = 0,
        bool hasLaterPlay = false,
        bool wasRecommended = false)
    {
        DateTime? last = lastPlayedDaysAgo > 0 ? Now.AddDays(-lastPlayedDaysAgo) : null;
        return new TasteEngagementInput(
            IsFavorite: isFavorite,
            Likes: likes,
            Played: played,
            PlayCount: playCount,
            UserRating: null,
            MaxPlayedTicks: maxTicks,
            RunTimeTicks: runTime,
            LastPlayedUtc: last,
            HasLaterPlayWithinNoReturnWindow: hasLaterPlay,
            WasRecommended: wasRecommended);
    }
}
