using System.Text.Json;
using System.Text.Json.Serialization;
using Jellyfin.Plugin.Seerr.Services;
using Xunit;

namespace Jellyfin.Plugin.Seerr.Tests;

public sealed class SeerrRatingDtoTests
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    [Fact]
    public void SearchResult_DeserializesAdultFlag()
    {
        const string json = """
            {
              "id": 550,
              "mediaType": "movie",
              "title": "Fight Club",
              "adult": true,
              "overview": "An insomniac..."
            }
            """;

        var result = JsonSerializer.Deserialize<SeerrSearchResultDto>(json, JsonOptions);

        Assert.NotNull(result);
        Assert.Equal(550, result.Id);
        Assert.True(result.Adult);
        Assert.Equal("movie", result.MediaType);
    }

    [Fact]
    public void MovieDetails_DeserializesUsCertification()
    {
        const string json = """
            {
              "adult": false,
              "releases": {
                "results": [
                  {
                    "iso_3166_1": "GB",
                    "release_dates": [{ "certification": "15" }]
                  },
                  {
                    "iso_3166_1": "US",
                    "release_dates": [
                      { "certification": "" },
                      { "certification": "R" }
                    ]
                  }
                ]
              }
            }
            """;

        var details = JsonSerializer.Deserialize<SeerrMovieDetailsDto>(json, JsonOptions);

        Assert.NotNull(details);
        Assert.False(details.Adult);
        Assert.NotNull(details.Releases);
        Assert.Equal(2, details.Releases.Results.Count);
        Assert.Equal("US", details.Releases.Results[1].Iso31661);
        Assert.Equal("R", details.Releases.Results[1].ReleaseDates![1].Certification);
    }

    [Fact]
    public void TvDetails_DeserializesContentRatings()
    {
        const string json = """
            {
              "adult": false,
              "contentRatings": {
                "results": [
                  { "iso_3166_1": "US", "rating": "TV-14" },
                  { "iso_3166_1": "GB", "rating": "15" }
                ]
              }
            }
            """;

        var details = JsonSerializer.Deserialize<SeerrTvDetailsDto>(json, JsonOptions);

        Assert.NotNull(details);
        Assert.NotNull(details.ContentRatings);
        Assert.Equal("TV-14", details.ContentRatings.Results[0].Rating);
        Assert.Equal("US", details.ContentRatings.Results[0].Iso31661);
    }

    [Fact]
    public void ExtractMovieCertification_PrefersUsOverOtherCountries()
    {
        var details = new SeerrMovieDetailsDto
        {
            Releases = new SeerrReleaseDatesDto
            {
                Results =
                [
                    new SeerrReleaseCountryDto
                    {
                        Iso31661 = "GB",
                        ReleaseDates = [new SeerrReleaseDateEntryDto { Certification = "15" }]
                    },
                    new SeerrReleaseCountryDto
                    {
                        Iso31661 = "US",
                        ReleaseDates =
                        [
                            new SeerrReleaseDateEntryDto { Certification = "" },
                            new SeerrReleaseDateEntryDto { Certification = "PG-13" }
                        ]
                    }
                ]
            }
        };

        Assert.Equal("PG-13", SeerrClient.ExtractMovieCertification(details));
    }

    [Fact]
    public void ExtractTvCertification_PrefersUsRating()
    {
        var details = new SeerrTvDetailsDto
        {
            ContentRatings = new SeerrContentRatingsDto
            {
                Results =
                [
                    new SeerrContentRatingEntryDto { Iso31661 = "GB", Rating = "15" },
                    new SeerrContentRatingEntryDto { Iso31661 = "US", Rating = "TV-MA" }
                ]
            }
        };

        Assert.Equal("TV-MA", SeerrClient.ExtractTvCertification(details));
    }
}
