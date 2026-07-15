using System;
using System.Collections.Generic;
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
        Assert.Equal(a.Code, b.Code);
        Assert.Equal("specialist", a.Focus);
        Assert.Contains("Horror", a.Title, StringComparison.OrdinalIgnoreCase);
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
}
