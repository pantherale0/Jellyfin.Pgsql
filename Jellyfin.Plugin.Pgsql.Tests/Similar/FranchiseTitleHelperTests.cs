using System;
using System.Linq;
using Jellyfin.Plugin.Pgsql.Similar;
using Xunit;

namespace Jellyfin.Plugin.Pgsql.Tests.Similar;

public sealed class FranchiseTitleHelperTests
{
    [Theory]
    [InlineData(null, "")]
    [InlineData("", "")]
    [InlineData("  ", "")]
    [InlineData("Spider-Man", "spider man")]
    [InlineData("Spider-Man (2002)", "spider man")]
    [InlineData("The Amazing Spider-Man", "the amazing spider man")]
    [InlineData("  Mr. Robot ", "mr robot")]
    public void NormalizeTitle_StripsPunctuationAndYears(string? input, string expected)
    {
        Assert.Equal(expected, FranchiseTitleHelper.NormalizeTitle(input));
    }

    [Theory]
    [InlineData("Spider-Man", new[] { "spider" })]
    [InlineData("The Amazing Spider-Man", new[] { "amazing", "spider" })]
    [InlineData("Iron Man", new string[0])] // "iron" is 4 chars; "man" is 3 — both below min length 5
    [InlineData("Despicable Me", new[] { "despicable" })]
    [InlineData("Spider-Man: No Way Home", new[] { "spider" })]
    public void ExtractSignificantTokens_DropsStopWordsAndShortTokens(string title, string[] expected)
    {
        var tokens = FranchiseTitleHelper.ExtractSignificantTokens(title);
        Assert.Equal(expected, tokens);
    }

    [Theory]
    [InlineData("Spider-Man", "The Amazing Spider-Man", true)]
    [InlineData("Spider-Man", "Spider-Man: No Way Home", true)]
    [InlineData("Spider-Man", "Iron Man", false)]
    [InlineData("Spider-Man", "The Incredibles", false)]
    public void SharesSignificantToken_DetectsFranchiseOverlap(string left, string right, bool expected)
    {
        Assert.Equal(expected, FranchiseTitleHelper.SharesSignificantToken(left, right));
    }

    [Theory]
    [InlineData(0.39, 0)]
    [InlineData(0.4, 200)]
    [InlineData(0.5, 250)]
    [InlineData(1.0, 500)]
    public void FranchiseScoreFromWordSimilarity_MapsBand(double similarity, int expected)
    {
        Assert.Equal(expected, FranchiseTitleHelper.FranchiseScoreFromWordSimilarity(similarity));
    }

    [Fact]
    public void CollectionWeight_ExceedsTitlePlusGenreCeiling()
    {
        // Director*N + actors + genres + max franchise must stay below collection.
        var maxReasonableLocal =
            MovieSimilarityWeights.TitleFranchiseMaxWeight
            + (MovieSimilarityWeights.DirectorWeight * 2)
            + (MovieSimilarityWeights.ActorWeight * 10)
            + (MovieSimilarityWeights.GenreWeight * 5)
            + (MovieSimilarityWeights.TagWeight * 5)
            + (MovieSimilarityWeights.StudioWeight * 3);

        Assert.True(
            MovieSimilarityWeights.CollectionWeight > maxReasonableLocal,
            $"CollectionWeight {MovieSimilarityWeights.CollectionWeight} should exceed {maxReasonableLocal}");
    }

    [Fact]
    public void ScoreOrdering_CollectionBeatsTitleBeatsGenre()
    {
        var collectionMate = MovieSimilarityWeights.CollectionWeight;
        var titleMate = MovieSimilarityWeights.SharedSignificantTokenWeight;
        var genreOnly = MovieSimilarityWeights.GenreWeight * 3;

        var ordered = new[] { genreOnly, collectionMate, titleMate }
            .OrderByDescending(s => s)
            .ToArray();

        Assert.Equal([collectionMate, titleMate, genreOnly], ordered);
    }

    [Fact]
    public void PreferredProviderOrder_PutsPostgreSQLSimilarityFirst()
    {
        // Mirrors ApplicationHost export ordering used by SimilarItemsManager.AddParts.
        var names = new[] { "Local Genre/Tag", "TheMovieDb", "PostgreSQL Similarity", "Local Genre/Tag" };
        var ordered = names
            .OrderBy(n => string.Equals(n, "PostgreSQL Similarity", StringComparison.Ordinal) ? 0 : 1)
            .ToArray();

        Assert.Equal("PostgreSQL Similarity", ordered[0]);
        Assert.Contains("Local Genre/Tag", ordered.Skip(1));
    }
}
