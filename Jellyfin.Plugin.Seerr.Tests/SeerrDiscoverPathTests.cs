using Jellyfin.Plugin.Seerr.Models;
using Jellyfin.Plugin.Seerr.Services;
using Xunit;

namespace Jellyfin.Plugin.Seerr.Tests;

public sealed class SeerrDiscoverPathTests
{
    [Fact]
    public void BuildDiscoverPath_Movies_IncludesSortAndPage()
    {
        var path = SeerrClient.BuildDiscoverPath("movie", [], null, 1);

        Assert.Equal("discover/movies?page=1&sortBy=popularity.desc", path);
    }

    [Fact]
    public void BuildDiscoverPath_Tv_WithGenresAndVoteFloor()
    {
        var path = SeerrClient.BuildDiscoverPath("tv", [18, 35, 18], 6.5f, 2);

        Assert.Equal("discover/tv?page=2&sortBy=popularity.desc&genre=18%2C35&voteAverageGte=6.5", path);
    }

    [Fact]
    public void BuildDiscoverPath_IgnoresInvalidVoteAverage()
    {
        var path = SeerrClient.BuildDiscoverPath("movie", [28], 0f, 1);

        Assert.Equal("discover/movies?page=1&sortBy=popularity.desc&genre=28", path);
    }

    [Fact]
    public void ParseGenreIds_ClampsToFiveDistinctPositive()
    {
        var ids = SeerrClient.ParseGenreIds("28,0,-1,abc,35,18,878,99,12");

        Assert.Equal([28, 35, 18, 878, 99], ids);
    }

    [Fact]
    public void ParseGenreIds_Empty_ReturnsEmpty()
    {
        Assert.Empty(SeerrClient.ParseGenreIds(null));
        Assert.Empty(SeerrClient.ParseGenreIds("  "));
    }

    [Theory]
    [InlineData("movie", "movie")]
    [InlineData("TV", "tv")]
    [InlineData("person", null)]
    [InlineData(null, null)]
    public void NormalizeDiscoverMediaType_MapsExpected(string? input, string? expected)
    {
        Assert.Equal(expected, SeerrClient.NormalizeDiscoverMediaType(input));
    }

    [Theory]
    [InlineData(SeerrMediaStatus.Unknown, true)]
    [InlineData(SeerrMediaStatus.PartiallyAvailable, true)]
    [InlineData(SeerrMediaStatus.Available, false)]
    [InlineData(SeerrMediaStatus.Pending, false)]
    [InlineData(SeerrMediaStatus.Processing, false)]
    [InlineData(SeerrMediaStatus.Blocklisted, false)]
    [InlineData(SeerrMediaStatus.Deleted, false)]
    public void IsRequestable_MatchesSearchRules(SeerrMediaStatus status, bool expected)
    {
        Assert.Equal(expected, SeerrClient.IsRequestable(status));
    }
}
