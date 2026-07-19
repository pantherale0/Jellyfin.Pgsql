using System.Collections.Generic;
using System.Diagnostics.CodeAnalysis;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.Seerr.Models;
using Jellyfin.Plugin.Seerr.Services;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using Xunit;

namespace Jellyfin.Plugin.Seerr.Tests;

public sealed class SeerrParentalFilterTests
{
    private readonly FakeLocalizationManager _localization = new();

    [Fact]
    public void NeedsFiltering_False_WhenMaxScoreNull()
    {
        var user = CreateUser(maxScore: null);
        Assert.False(SeerrParentalFilter.NeedsFiltering(user));
    }

    [Fact]
    public void NeedsFiltering_True_WhenMaxScoreSet()
    {
        var user = CreateUser(maxScore: 13);
        Assert.True(SeerrParentalFilter.NeedsFiltering(user));
    }

    [Fact]
    public void IsContentAllowed_UnrestrictedUser_AlwaysAllows()
    {
        var user = CreateUser(maxScore: null);
        var rating = new SeerrMediaRating { Adult = true, Certification = "NC-17" };

        Assert.True(SeerrParentalFilter.IsContentAllowed(user, "movie", rating, _localization));
    }

    [Fact]
    public void IsContentAllowed_BlocksAdult_ForRestrictedUser()
    {
        var user = CreateUser(maxScore: 13);
        var rating = new SeerrMediaRating { Adult = true, Certification = "G" };

        Assert.False(SeerrParentalFilter.IsContentAllowed(user, "movie", rating, _localization));
    }

    [Fact]
    public void IsContentAllowed_FailClosed_OnLookupFailure()
    {
        var user = CreateUser(maxScore: 13);

        Assert.False(SeerrParentalFilter.IsContentAllowed(user, "movie", SeerrMediaRating.Failed, _localization));
    }

    [Theory]
    [InlineData("PG-13", true)]
    [InlineData("PG", true)]
    [InlineData("R", false)]
    [InlineData("NC-17", false)]
    public void IsContentAllowed_ComparesMovieScore_AgainstMax13(string certification, bool expected)
    {
        var user = CreateUser(maxScore: 13);
        var rating = new SeerrMediaRating { Certification = certification };

        Assert.Equal(expected, SeerrParentalFilter.IsContentAllowed(user, "movie", rating, _localization));
    }

    [Theory]
    [InlineData("TV-14", true)]
    [InlineData("TV-MA", false)]
    public void IsContentAllowed_ComparesTvScore_AgainstMax14(string certification, bool expected)
    {
        var user = CreateUser(maxScore: 14);
        var rating = new SeerrMediaRating { Certification = certification };

        Assert.Equal(expected, SeerrParentalFilter.IsContentAllowed(user, "tv", rating, _localization));
    }

    [Fact]
    public void IsContentAllowed_RespectsSubScore()
    {
        var user = CreateUser(maxScore: 17, maxSubScore: 0);
        var rRated = new SeerrMediaRating { Certification = "R" };
        var nc17 = new SeerrMediaRating { Certification = "NC-17" };

        Assert.True(SeerrParentalFilter.IsContentAllowed(user, "movie", rRated, _localization));
        Assert.False(SeerrParentalFilter.IsContentAllowed(user, "movie", nc17, _localization));
    }

    [Fact]
    public void IsContentAllowed_Unrated_AllowedWhenNotBlocked()
    {
        var user = CreateUser(maxScore: 13);
        var rating = new SeerrMediaRating { Certification = null };

        Assert.True(SeerrParentalFilter.IsContentAllowed(user, "movie", rating, _localization));
    }

    [Fact]
    public void IsContentAllowed_UnratedMovie_BlockedWhenPolicySet()
    {
        var user = CreateUser(maxScore: 13);
        user.SetPreference(PreferenceKind.BlockUnratedItems, [UnratedItem.Movie]);
        var rating = new SeerrMediaRating { Certification = null };

        Assert.False(SeerrParentalFilter.IsContentAllowed(user, "movie", rating, _localization));
        Assert.True(SeerrParentalFilter.IsContentAllowed(user, "tv", rating, _localization));
    }

    [Fact]
    public void IsContentAllowed_UnratedSeries_BlockedWhenPolicySet()
    {
        var user = CreateUser(maxScore: 13);
        user.SetPreference(PreferenceKind.BlockUnratedItems, [UnratedItem.Series]);
        var rating = new SeerrMediaRating { Certification = null };

        Assert.False(SeerrParentalFilter.IsContentAllowed(user, "tv", rating, _localization));
        Assert.True(SeerrParentalFilter.IsContentAllowed(user, "movie", rating, _localization));
    }

    [Fact]
    public void IsContentAllowed_UnrecognizedCertification_TreatedAsUnrated()
    {
        var user = CreateUser(maxScore: 13);
        user.SetPreference(PreferenceKind.BlockUnratedItems, [UnratedItem.Movie]);
        var rating = new SeerrMediaRating { Certification = "NOT-A-REAL-RATING" };

        Assert.False(SeerrParentalFilter.IsContentAllowed(user, "movie", rating, _localization));
    }

    private static User CreateUser(int? maxScore, int? maxSubScore = null)
    {
        return new User("testuser", "auth", "reset")
        {
            MaxParentalRatingScore = maxScore,
            MaxParentalRatingSubScore = maxSubScore
        };
    }

    private sealed class FakeLocalizationManager : ILocalizationManager
    {
        private static readonly Dictionary<string, ParentalRatingScore> Scores = new(System.StringComparer.OrdinalIgnoreCase)
        {
            ["G"] = new(0, 0),
            ["PG"] = new(10, 0),
            ["PG-13"] = new(13, 0),
            ["TV-14"] = new(14, 0),
            ["R"] = new(17, 0),
            ["NC-17"] = new(17, 1),
            ["TV-MA"] = new(17, 1),
        };

        public ParentalRatingScore? GetRatingScore(string rating, string? countryCode = null)
            => Scores.TryGetValue(rating, out var score) ? score : null;

        public System.Collections.Generic.IEnumerable<CultureDto> GetCultures() => [];

        public System.Collections.Generic.IReadOnlyList<CountryInfo> GetCountries() => [];

        public System.Collections.Generic.IReadOnlyList<ParentalRating> GetParentalRatings() => [];

        public string GetLocalizedString(string phrase, string culture) => phrase;

        public string GetLocalizedString(string phrase) => phrase;

        public string GetServerLocalizedString(string phrase) => phrase;

        public System.Collections.Generic.IEnumerable<LocalizationOption> GetLocalizationOptions() => [];

        public CultureDto? FindLanguageInfo(string language) => null;

        public bool TryGetISO6392TFromB(string isoB, [NotNullWhen(true)] out string? isoT)
        {
            isoT = null;
            return false;
        }
    }
}
