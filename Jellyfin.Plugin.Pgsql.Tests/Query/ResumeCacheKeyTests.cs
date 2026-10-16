using System;
using Jellyfin.Plugin.Pgsql.Query;
using Xunit;

namespace Jellyfin.Plugin.Pgsql.Tests.Query;

public sealed class ResumeCacheKeyTests
{
    [Theory]
    [InlineData("owned")]
    [InlineData("alternate")]
    [InlineData("descendant")]
    [InlineData("linked")]
    [InlineData("rating")]
    [InlineData("allowed-tag")]
    [InlineData("blocked-tag")]
    public void BuildResumeKey_SeparatesSupportedRestrictions(string field)
    {
        var query = ResumeQueryFilterTests.CreateQuery();
        var original = QueryCacheKeyBuilder.BuildResumeKey(query, 1, 1);
        switch (field)
        {
            case "owned": query.IncludeOwnedItems = false; break;
            case "alternate": query.IncludeAlternateVersions = true; break;
            case "descendant": query.DescendantOfId = Guid.NewGuid(); break;
            case "linked": query.LinkedChildAncestorIds = [Guid.NewGuid()]; break;
            case "rating": query.MaxParentalRating = new(500, 1); break;
            case "allowed-tag": query.IncludeInheritedTags = ["family"]; break;
            case "blocked-tag": query.ExcludeInheritedTags = ["adult"]; break;
        }

        Assert.NotNull(original);
        Assert.NotEqual(original, QueryCacheKeyBuilder.BuildResumeKey(query, 1, 1));
    }
}
