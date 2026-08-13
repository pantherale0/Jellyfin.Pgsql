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

    [Fact]
    public void ComputeBonus_OutsideYearBand_AppliesSoftPenalty()
    {
        var profile = ComedyProfile();
        profile.YearP25 = 2015f;
        profile.YearP75 = 2020f;

        var inBand = LinearTasteScorer.ComputeBonus(
            profile,
            Candidate(year: 2018),
            180);

        var outOfBand = LinearTasteScorer.ComputeBonus(
            profile,
            Candidate(year: 1990),
            180);

        Assert.True(inBand > outOfBand);
    }

    [Fact]
    public void ComputeBonus_OutsideRuntimeBand_AppliesSoftPenalty()
    {
        var profile = ComedyProfile();
        profile.RuntimeP25Ticks = (float)TimeSpan.FromMinutes(90).Ticks;
        profile.RuntimeP75Ticks = (float)TimeSpan.FromMinutes(120).Ticks;

        var inBand = LinearTasteScorer.ComputeBonus(
            profile,
            Candidate(runtimeTicks: TimeSpan.FromMinutes(100).Ticks),
            180);

        var outOfBand = LinearTasteScorer.ComputeBonus(
            profile,
            Candidate(runtimeTicks: TimeSpan.FromHours(4).Ticks),
            180);

        Assert.True(inBand > outOfBand);
    }

    [Fact]
    public void ComputeBonus_OutsideParentalBand_AppliesSoftPenalty()
    {
        var profile = ComedyProfile();
        profile.ParentalP25 = 4f;
        profile.ParentalP75 = 6f;

        var inBand = LinearTasteScorer.ComputeBonus(
            profile,
            Candidate(parental: 5),
            180);

        var outOfBand = LinearTasteScorer.ComputeBonus(
            profile,
            Candidate(parental: 10),
            180);

        Assert.True(inBand > outOfBand);
    }

    [Fact]
    public void ComputeBonus_TypeMismatch_OnlyWhenSeriesShareExtreme()
    {
        var movieMajority = ComedyProfile();
        movieMajority.SeriesShare = 0.1f;
        var mixed = ComedyProfile();
        mixed.SeriesShare = 0.5f;

        var moviePrefSeries = LinearTasteScorer.ComputeBonus(
            movieMajority,
            Candidate(isSeries: true),
            180);
        var moviePrefMovie = LinearTasteScorer.ComputeBonus(
            movieMajority,
            Candidate(isSeries: false),
            180);
        var mixedSeries = LinearTasteScorer.ComputeBonus(
            mixed,
            Candidate(isSeries: true),
            180);
        var mixedMovie = LinearTasteScorer.ComputeBonus(
            mixed,
            Candidate(isSeries: false),
            180);

        Assert.True(moviePrefMovie > moviePrefSeries);
        Assert.Equal(mixedMovie, mixedSeries);
        Assert.True(LinearTasteScorer.IsTypeMismatch(0.1f, isSeries: true));
        Assert.False(LinearTasteScorer.IsTypeMismatch(0.5f, isSeries: true));
    }

    [Fact]
    public void ComputeBonus_SharedWriter_BoostsScore()
    {
        var writerId = Guid.Parse("aaaaaaaa-bbbb-cccc-dddd-000000000001");
        var profile = ComedyProfile();
        profile.Writers = new Dictionary<string, float>(StringComparer.Ordinal)
        {
            [writerId.ToString("N")] = 1f
        };

        var withWriter = LinearTasteScorer.ComputeBonus(
            profile,
            Candidate(writerIds: [writerId]),
            180);
        var withoutWriter = LinearTasteScorer.ComputeBonus(profile, Candidate(), 180);

        Assert.True(withWriter > withoutWriter);
    }

    [Fact]
    public void ComputeBonus_SharedBoxSet_BoostsScore()
    {
        var boxSetId = Guid.Parse("aaaaaaaa-bbbb-cccc-dddd-000000000002");
        var profile = ComedyProfile();
        profile.BoxSets = new Dictionary<string, float>(StringComparer.Ordinal)
        {
            [boxSetId.ToString("N")] = 1f
        };

        var withBoxSet = LinearTasteScorer.ComputeBonus(
            profile,
            Candidate(boxSetIds: [boxSetId]),
            180);
        var withoutBoxSet = LinearTasteScorer.ComputeBonus(profile, Candidate(), 180);

        Assert.True(withBoxSet > withoutBoxSet);
        Assert.True(withBoxSet <= MovieSimilarityWeights.MaxTasteBonus);
    }

    [Fact]
    public void ComputeBonus_SharedLanguage_BoostsScore()
    {
        var profile = ComedyProfile();
        profile.Languages = new Dictionary<string, float>(StringComparer.OrdinalIgnoreCase)
        {
            ["en"] = 1f
        };

        var withLanguage = LinearTasteScorer.ComputeBonus(
            profile,
            Candidate(originalLanguage: "en"),
            180);
        var withoutLanguage = LinearTasteScorer.ComputeBonus(profile, Candidate(), 180);

        Assert.True(withLanguage > withoutLanguage);
    }

    [Fact]
    public void ComputeBonus_SharedCountry_BoostsScore()
    {
        var profile = ComedyProfile();
        profile.Countries = new Dictionary<string, float>(StringComparer.OrdinalIgnoreCase)
        {
            ["usa"] = 1f
        };

        var withCountry = LinearTasteScorer.ComputeBonus(
            profile,
            Candidate(productionCountries: ["usa"]),
            180);
        var withoutCountry = LinearTasteScorer.ComputeBonus(profile, Candidate(), 180);

        Assert.True(withCountry > withoutCountry);
    }

    private static UserTasteFeaturePayload ComedyProfile()
        => new()
        {
            Genres = new Dictionary<string, float>(StringComparer.OrdinalIgnoreCase)
            {
                ["comedy"] = 1f
            }
        };

    private static TasteCandidateFeatures Candidate(
        int? year = null,
        long? runtimeTicks = null,
        int? parental = null,
        bool isSeries = false,
        IReadOnlyCollection<Guid>? writerIds = null,
        IReadOnlyCollection<Guid>? boxSetIds = null,
        string? originalLanguage = null,
        IReadOnlyCollection<string>? productionCountries = null)
        => new(
            ["comedy"],
            [],
            [],
            [],
            [],
            7.5f,
            year,
            runtimeTicks,
            parental,
            isSeries,
            writerIds,
            boxSetIds,
            originalLanguage,
            productionCountries);
}
