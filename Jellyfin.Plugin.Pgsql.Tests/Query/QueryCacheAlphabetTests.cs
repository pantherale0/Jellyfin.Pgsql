using System;
using Jellyfin.Data.Entities;
using Jellyfin.Plugin.Pgsql.Query;
using MediaBrowser.Controller.Entities;
using Xunit;

namespace Jellyfin.Plugin.Pgsql.Tests.Query;

public sealed class QueryCacheAlphabetTests
{
    [Theory]
    [InlineData("prefix")]
    [InlineData("greater")]
    [InlineData("less")]
    public void BuildBrowseKey_SeparatesAlphabetBoundaries(string boundary)
    {
        var query = new InternalItemsQuery
        {
            User = new User("cache-test", "default", "default"),
            ParentId = Guid.NewGuid(),
            StartIndex = 0,
            Limit = 1,
        };

        var unfiltered = QueryCacheKeyBuilder.BuildBrowseKey(query, 0, 0);
        Assert.NotNull(unfiltered);
        SetBoundary(query, boundary, "M");
        var m = QueryCacheKeyBuilder.BuildBrowseKey(query, 0, 0);
        SetBoundary(query, boundary, "S");
        var s = QueryCacheKeyBuilder.BuildBrowseKey(query, 0, 0);

        Assert.NotNull(m);
        Assert.NotNull(s);
        Assert.NotEqual(unfiltered, m);
        Assert.NotEqual(m, s);
        Assert.Equal(s, QueryCacheKeyBuilder.BuildBrowseKey(query, 0, 0));
    }

    [Fact]
    public void AlphabetStrings_CannotAliasAdjacentFields()
    {
        var query = new InternalItemsQuery { NameStartsWith = "A|B", NameStartsWithOrGreater = "C" };
        var first = QueryCacheKeyBuilder.BuildResumeKey(query, 0, 0);
        Assert.NotNull(first);
        query.NameStartsWith = "A";
        query.NameStartsWithOrGreater = "B|C";
        Assert.NotEqual(first, QueryCacheKeyBuilder.BuildResumeKey(query, 0, 0));
    }

    private static void SetBoundary(InternalItemsQuery query, string boundary, string value)
    {
        switch (boundary)
        {
            case "prefix":
                query.NameStartsWith = value;
                break;
            case "greater":
                query.NameStartsWithOrGreater = value;
                break;
            case "less":
                query.NameLessThan = value;
                break;
        }
    }
}
