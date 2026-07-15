using System;
using System.Collections.Generic;
using Jellyfin.Plugin.Pgsql.Similar;
using Jellyfin.Plugin.Pgsql.Taste;
using Xunit;

namespace Jellyfin.Plugin.Pgsql.Tests.Taste;

public sealed class LinearTasteScorerTests
{
    [Fact]
    public void ComputeBonus_SharedGenre_BoostsScore()
    {
        var profile = new UserTasteFeaturePayload
        {
            Genres = new Dictionary<string, float>(StringComparer.OrdinalIgnoreCase)
            {
                ["comedy"] = 1f
            }
        };

        var bonus = LinearTasteScorer.ComputeBonus(
            profile,
            new TasteCandidateFeatures(
                ["comedy"],
                [],
                [],
                [],
                [],
                7f),
            maxBonus: MovieSimilarityWeights.MaxTasteBonus);

        Assert.True(bonus > 0);
        Assert.True(bonus <= MovieSimilarityWeights.MaxTasteBonus);
    }

    [Fact]
    public void ComputeBonus_OutsideRatingBand_AppliesSoftPenalty()
    {
        var profile = new UserTasteFeaturePayload
        {
            Genres = new Dictionary<string, float>(StringComparer.OrdinalIgnoreCase)
            {
                ["comedy"] = 1f
            },
            RatingP25 = 7f,
            RatingP75 = 8.5f
        };

        var inBand = LinearTasteScorer.ComputeBonus(
            profile,
            new TasteCandidateFeatures(["comedy"], [], [], [], [], 7.5f),
            180);

        var outOfBand = LinearTasteScorer.ComputeBonus(
            profile,
            new TasteCandidateFeatures(["comedy"], [], [], [], [], 3f),
            180);

        Assert.True(inBand > outOfBand);
    }

    [Fact]
    public void ComputeBonus_RespectsAbsoluteCap()
    {
        var directorId = Guid.Parse("dddddddd-eeee-ffff-aaaa-000000000001");
        var profile = new UserTasteFeaturePayload
        {
            Genres = new Dictionary<string, float>(StringComparer.OrdinalIgnoreCase)
            {
                ["comedy"] = 1f,
                ["action"] = 1f
            },
            Tags = new Dictionary<string, float>(StringComparer.OrdinalIgnoreCase)
            {
                ["feel-good"] = 1f
            },
            Studios = new Dictionary<string, float>(StringComparer.OrdinalIgnoreCase)
            {
                ["pixar"] = 1f
            },
            Directors = new Dictionary<string, float>(StringComparer.Ordinal)
            {
                [directorId.ToString("N")] = 1f
            }
        };

        var bonus = LinearTasteScorer.ComputeBonus(
            profile,
            new TasteCandidateFeatures(
                ["comedy", "action"],
                ["feel-good"],
                ["pixar"],
                [directorId],
                [],
                8f),
            maxBonus: 50);

        Assert.Equal(50, bonus);
        Assert.True(bonus < MovieSimilarityWeights.TitleFranchiseMaxWeight);
    }

    [Fact]
    public void ComputeBonus_EmptyProfile_ReturnsZero()
    {
        var bonus = LinearTasteScorer.ComputeBonus(
            new UserTasteFeaturePayload(),
            new TasteCandidateFeatures(["comedy"], [], [], [], [], null),
            180);

        Assert.Equal(0, bonus);
    }
}
