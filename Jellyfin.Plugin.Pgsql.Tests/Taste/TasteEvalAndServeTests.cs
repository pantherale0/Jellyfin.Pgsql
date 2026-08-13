using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Plugin.Pgsql.Taste;
using Xunit;

namespace Jellyfin.Plugin.Pgsql.Tests.Taste;

public sealed class TasteEvalAndServeTests
{
    [Fact]
    public void SplitByEventTime_PutsNewestFractionInHoldout()
    {
        var start = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        var rows = new List<(string Id, DateTime At)>
        {
            ("a", start),
            ("b", start.AddDays(10)),
            ("c", start.AddDays(20)),
            ("d", start.AddDays(30)),
            ("e", start.AddDays(40)),
        };

        var split = TasteEvalMetrics.SplitByEventTime(rows, r => r.At, 0.2f);

        Assert.Contains(split.Holdout, r => r.Id == "e");
        Assert.DoesNotContain(split.Holdout, r => r.Id == "a");
        Assert.Contains(split.Train, r => r.Id == "a");
        Assert.True(split.Holdout.All(h => h.At >= split.WindowStart));
        Assert.True(split.Train.All(t => t.At < split.WindowStart));
    }

    [Fact]
    public void MeanPrecisionAtK_MacroAveragesPerUser()
    {
        var userA = Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
        var userB = Guid.Parse("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
        var rows = new (Guid UserId, float Score, bool Label)[]
        {
            (userA, 0.9f, true),
            (userA, 0.8f, false),
            (userB, 0.7f, false),
            (userB, 0.6f, false),
        };

        var mean = TasteEvalMetrics.MeanPrecisionAtK(rows, 1);
        Assert.Equal(0.5, mean);
    }

    [Fact]
    public void PrecisionAtK_UsesMinOfKAndN()
    {
        var ranked = new (float Score, bool Label)[]
        {
            (1f, true),
            (0.5f, false),
        };

        Assert.Equal(0.5, TasteEvalMetrics.PrecisionAtK(ranked, 10));
        Assert.Equal(1, TasteEvalMetrics.PrecisionAtK(ranked, 1));
        Assert.Equal(0, TasteEvalMetrics.PrecisionAtK([], 10));
    }

    [Fact]
    public void Combiner_FallsBackToLinear_WhenStoreUnavailable()
    {
        Assert.Equal(40, TasteScoreCombiner.Blend(40, neuralProbability: null, useNeural: true, maxBonus: 100));
        Assert.Equal(40, TasteScoreCombiner.Blend(40, 0.9f, useNeural: false, maxBonus: 100));
    }

    [Fact]
    public void Combiner_BlendsMidpoint_WhenAlphaIsHalf()
    {
        Assert.Equal(0.5f, TasteScoreCombiner.NeuralBlendAlpha);
        Assert.Equal(50, TasteScoreCombiner.Blend(0, 1f, useNeural: true, maxBonus: 100));
        Assert.Equal(50, TasteScoreCombiner.Blend(100, 0f, useNeural: true, maxBonus: 100));
        Assert.Equal(75, TasteScoreCombiner.Blend(50, 1f, useNeural: true, maxBonus: 100));
    }

    [Fact]
    public void NeuralExample_AppendsWriterBoxSetLanguageCountryOverlap()
    {
        var writerId = Guid.Parse("aaaaaaaa-bbbb-cccc-dddd-000000000001");
        var boxSetId = Guid.Parse("aaaaaaaa-bbbb-cccc-dddd-000000000002");
        var profile = new UserTasteFeaturePayload
        {
            Genres = new Dictionary<string, float>(StringComparer.OrdinalIgnoreCase)
            {
                ["comedy"] = 1f
            },
            Writers = new Dictionary<string, float>(StringComparer.Ordinal)
            {
                [writerId.ToString("N")] = 1f
            },
            BoxSets = new Dictionary<string, float>(StringComparer.Ordinal)
            {
                [boxSetId.ToString("N")] = 1f
            },
            Languages = new Dictionary<string, float>(StringComparer.OrdinalIgnoreCase)
            {
                ["en"] = 1f
            },
            Countries = new Dictionary<string, float>(StringComparer.OrdinalIgnoreCase)
            {
                ["usa"] = 1f
            }
        };

        var example = TasteNeuralExampleBuilder.Create(
            profile,
            new TasteCandidateFeatures(
                ["comedy"],
                [],
                [],
                [],
                [],
                7.5f,
                WriterIds: [writerId],
                BoxSetIds: [boxSetId],
                OriginalLanguage: "en",
                ProductionCountries: ["usa"]),
            label: true,
            weight: 1f);

        Assert.True(example.WriterOverlap > 0f);
        Assert.True(example.BoxSetOverlap > 0f);
        Assert.True(example.LanguageOverlap > 0f);
        Assert.True(example.CountryOverlap > 0f);
        Assert.Equal(
            new[] { "WriterOverlap", "BoxSetOverlap", "LanguageOverlap", "CountryOverlap" },
            TasteNeuralExample.FeatureColumnNames[^4..]);
    }

    [Fact]
    public void EngageRate_EmptyImpressions_IsNull()
    {
        var snapshot = TasteForYouEngageMetrics.ComputeFromRows([], [], [], 14);
        Assert.Null(snapshot.Rate);
        Assert.Equal(0, snapshot.ImpressionCount);
        Assert.Equal(0, snapshot.EngageCount);
        Assert.Equal(14, snapshot.WindowDays);
    }

    [Fact]
    public void EngageRate_CountsPlaybackInsideWindow_Only()
    {
        var user = Guid.Parse("11111111-1111-1111-1111-111111111111");
        var hit = Guid.Parse("22222222-2222-2222-2222-222222222222");
        var miss = Guid.Parse("33333333-3333-3333-3333-333333333333");
        var served = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        var impressions = new[]
        {
            new TasteImpressionEngageRow(user, hit, served),
            new TasteImpressionEngageRow(user, miss, served),
        };
        var playback = new[]
        {
            new TasteEngageEvent(user, hit, served.AddDays(3)),
            new TasteEngageEvent(user, miss, served.AddDays(20)),
        };

        var snapshot = TasteForYouEngageMetrics.ComputeFromRows(impressions, [], playback, 14);
        Assert.Equal(2, snapshot.ImpressionCount);
        Assert.Equal(1, snapshot.EngageCount);
        Assert.Equal(0.5, snapshot.Rate);
    }
}
