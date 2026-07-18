using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Plugin.Pgsql.Taste;
using Xunit;

namespace Jellyfin.Plugin.Pgsql.Tests.Taste;

public sealed class TastePersonaGeneratorTests
{
    private readonly TastePersonaGenerator _generator = new();

    [Fact]
    public void Generate_ColdStart_ReturnsStillCalibrating()
    {
        var result = _generator.Generate(
            Guid.NewGuid(),
            null,
            sampleCount: 2,
            updatedAt: DateTime.UtcNow,
            minSamples: 10);

        Assert.Equal("Still Calibrating", result.Title);
        Assert.Equal("calibrating", result.Code);
        Assert.Equal("unknown", result.Focus);
        Assert.Contains("watching", result.Blurb, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Rebuild", result.Blurb, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain('·', result.Blurb);
    }

    [Fact]
    public void Generate_SameSeed_IsStable()
    {
        var userId = Guid.Parse("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
        var updatedAt = new DateTime(2026, 7, 15, 12, 0, 0, DateTimeKind.Utc);
        var payload = SpecialistHorrorPayload();

        var a = _generator.Generate(userId, payload, 40, updatedAt, minSamples: 10);
        var b = _generator.Generate(userId, payload, 40, updatedAt, minSamples: 10);

        Assert.Equal(a.Title, b.Title);
        Assert.Equal(a.Blurb, b.Blurb);
        Assert.Equal(a.Code, b.Code);
        Assert.Equal("specialist", a.Focus);
        Assert.Contains("Horror", a.Title, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain('·', a.Blurb);
        Assert.DoesNotContain("Rebuild", a.Blurb, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Generate_GenreFlip_CanChangeTitle()
    {
        var userId = Guid.Parse("11111111-2222-3333-4444-555555555555");
        var updatedAt = new DateTime(2026, 7, 15, 12, 0, 0, DateTimeKind.Utc);

        var horror = _generator.Generate(userId, SpecialistHorrorPayload(), 40, updatedAt, 10);
        var comedy = _generator.Generate(userId, SpecialistComedyPayload(), 40, updatedAt, 10);

        Assert.NotEqual(horror.Code, comedy.Code);
        Assert.NotEqual(horror.Title, comedy.Title);
    }

    [Fact]
    public void Generate_HorrorVsRomance_BlurbVibesDiffer()
    {
        var userId = Guid.Parse("22222222-3333-4444-5555-666666666666");
        var updatedAt = new DateTime(2026, 7, 15, 12, 0, 0, DateTimeKind.Utc);

        var horror = _generator.Generate(userId, SpecialistHorrorPayload(), 40, updatedAt, 10);
        var romance = _generator.Generate(userId, SpecialistRomancePayload(), 40, updatedAt, 10);

        Assert.True(
            ContainsAny(horror.Blurb, "dark", "dread", "chill", "shadows", "fright", "tense"),
            $"Horror blurb missing vibe words: {horror.Blurb}");
        Assert.True(
            ContainsAny(romance.Blurb, "spark", "chemistry", "soft", "teasing", "flirt", "burn", "heart"),
            $"Romance blurb missing vibe words: {romance.Blurb}");
        Assert.NotEqual(horror.Blurb, romance.Blurb);
    }

    [Fact]
    public void Generate_AffinityHint_MentionsLabel()
    {
        var userId = Guid.Parse("33333333-4444-5555-6666-777777777777");
        var updatedAt = new DateTime(2026, 7, 15, 12, 0, 0, DateTimeKind.Utc);
        var payload = SpecialistHorrorPayload();
        payload.Tags["neon"] = 0.4f;

        // Force affinity by trying many seeds until the tag sentence is chosen,
        // or assert with a fixed hint that weight-gates always make the tag available.
        var withHint = _generator.Generate(
            userId,
            payload,
            40,
            updatedAt,
            10,
            new TasteAffinityHints(TopTag: "Neon"));

        // Without a people/studio competing and with rng, tag may or may not be picked
        // among candidates — seed enough user ids with the same payload until we see Neon.
        var found = withHint.Blurb.Contains("Neon", StringComparison.Ordinal);
        if (!found)
        {
            for (var i = 0; i < 48 && !found; i++)
            {
                var id = Guid.Parse($"00000000-0000-0000-0000-{i:D12}");
                var blurb = _generator.Generate(
                    id,
                    payload,
                    40,
                    updatedAt,
                    10,
                    new TasteAffinityHints(TopTag: "Neon")).Blurb;
                found = blurb.Contains("Neon", StringComparison.Ordinal);
            }
        }

        Assert.True(found, "Expected at least one seeded blurb to mention affinity tag Neon");
    }

    [Fact]
    public void Generate_WithoutAffinity_DoesNotFabricatePerson()
    {
        var userId = Guid.Parse("44444444-5555-6666-7777-888888888888");
        var updatedAt = new DateTime(2026, 7, 15, 12, 0, 0, DateTimeKind.Utc);
        var result = _generator.Generate(userId, SpecialistHorrorPayload(), 40, updatedAt, 10);

        Assert.DoesNotContain("Nolan", result.Blurb, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("when  shows up", result.Blurb, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Generate_SameAxes_DifferentUsers_CanVarySurfaceForm()
    {
        var updatedAt = new DateTime(2026, 7, 15, 12, 0, 0, DateTimeKind.Utc);
        var payload = SpecialistHorrorPayload();
        var titles = new HashSet<string>(StringComparer.Ordinal);

        for (var i = 0; i < 24; i++)
        {
            var userId = Guid.Parse($"00000000-0000-0000-0000-{i:D12}");
            titles.Add(_generator.Generate(userId, payload, 40, updatedAt, 10).Title);
        }

        Assert.True(titles.Count >= 2);
    }

    private static bool ContainsAny(string haystack, params string[] needles)
        => needles.Where(needle => haystack.Contains(needle, StringComparison.OrdinalIgnoreCase)).Any();

    private static UserTasteFeaturePayload SpecialistHorrorPayload()
        => new()
        {
            Genres = new Dictionary<string, float>(StringComparer.OrdinalIgnoreCase)
            {
                ["horror"] = 0.75f,
                ["thriller"] = 0.15f,
                ["drama"] = 0.1f
            },
            RatingMean = 7.8f,
            RatingP25 = 7.0f,
            RatingP75 = 8.4f
        };

    private static UserTasteFeaturePayload SpecialistComedyPayload()
        => new()
        {
            Genres = new Dictionary<string, float>(StringComparer.OrdinalIgnoreCase)
            {
                ["comedy"] = 0.8f,
                ["romance"] = 0.12f,
                ["family"] = 0.08f
            },
            RatingMean = 6.5f,
            RatingP25 = 5.8f,
            RatingP75 = 7.2f
        };

    private static UserTasteFeaturePayload SpecialistRomancePayload()
        => new()
        {
            Genres = new Dictionary<string, float>(StringComparer.OrdinalIgnoreCase)
            {
                ["romance"] = 0.8f,
                ["drama"] = 0.12f,
                ["comedy"] = 0.08f
            },
            RatingMean = 6.8f,
            RatingP25 = 6.2f,
            RatingP75 = 7.5f
        };
}
