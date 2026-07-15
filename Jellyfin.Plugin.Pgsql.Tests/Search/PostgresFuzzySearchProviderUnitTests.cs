using System;
using Jellyfin.Plugin.Pgsql.Search;
using MediaBrowser.Controller.Library;
using Xunit;

namespace Jellyfin.Plugin.Pgsql.Tests.Search;

public sealed class PostgresFuzzySearchProviderUnitTests
{
    [Fact]
    public void Provider_IsInternalNotExternal_SoSearchManagerExternalLaneIsPreserved()
    {
        // SearchManager prefers IExternalSearchProvider results when any exist; this provider
        // must stay internal so Seerr/Meilisearch-style externals keep precedence.
        Assert.True(typeof(IInternalSearchProvider).IsAssignableFrom(typeof(PostgresFuzzySearchProvider)));
        Assert.False(typeof(IExternalSearchProvider).IsAssignableFrom(typeof(PostgresFuzzySearchProvider)));
    }

    [Theory]
    [InlineData("", false)]
    [InlineData(" ", false)]
    [InlineData("a", false)]
    [InlineData("ab", false)]
    [InlineData("abc", true)]
    [InlineData("Family", true)]
    [InlineData("  bat  ", true)]
    public void CanSearch_EnforcesMinimumTermLength(string term, bool expected)
    {
        var provider = CreateProviderWithoutDeps();
        var canSearch = provider.CanSearch(new SearchProviderQuery { SearchTerm = term });
        Assert.Equal(expected, canSearch);
    }

    [Fact]
    public void CanSearch_ThrowsOnNullQuery()
    {
        var provider = CreateProviderWithoutDeps();
        Assert.Throws<ArgumentNullException>(() => provider.CanSearch(null!));
    }

    [Theory]
    [InlineData("Family", "family")]
    [InlineData("  Mr. Robot ", "mr robot")]
    [InlineData("a", "a")]
    public void NormalizeSearchTerm_CleansInput(string input, string expected)
    {
        Assert.Equal(expected, PostgresFuzzySearchProvider.NormalizeSearchTerm(input));
    }

    [Fact]
    public void MinSearchTermLength_IsThree()
    {
        Assert.Equal(3, PostgresFuzzySearchProvider.MinSearchTermLength);
    }

    [Theory]
    [InlineData("game", "game")]
    [InlineData("100%", @"100\%")]
    [InlineData(@"a\b", @"a\\b")]
    [InlineData("a_b", @"a\_b")]
    public void EscapeLikeLiteral_EscapesMetacharacters(string input, string expected)
    {
        Assert.Equal(expected, PostgresFuzzySearchProvider.EscapeLikeLiteral(input));
    }

    private static PostgresFuzzySearchProvider CreateProviderWithoutDeps()
    {
        // CanSearch / NormalizeSearchTerm do not touch injected services.
        return new PostgresFuzzySearchProvider(null!, null!, null!, null!, null!, null!);
    }
}
