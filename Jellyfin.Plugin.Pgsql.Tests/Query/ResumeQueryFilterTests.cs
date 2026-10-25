using System;
using System.Linq;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.Pgsql.Query;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Querying;
using Xunit;

namespace Jellyfin.Plugin.Pgsql.Tests.Query;

public sealed class ResumeQueryFilterTests
{
    internal static InternalItemsQuery CreateQuery() => new(new User("resume", "auth", "reset"))
    {
        IsResumable = true,
        IsVirtualItem = false,
        IncludeOwnedItems = true,
        OrderBy = [(ItemSortBy.DatePlayed, SortOrder.Descending)],
        Limit = 12,
    };

    [Fact]
    public void TryCreate_PreservesRestrictionsWithoutMutatingRequest()
    {
        var query = CreateQuery();
        query.TopParentIds = [Guid.Parse("00000000-0000-0000-0000-000000000011")];
        query.AncestorIds = [Guid.Parse("00000000-0000-0000-0000-000000000012")];
        query.ExcludeItemIds = [Guid.Parse("00000000-0000-0000-0000-000000000013")];
        query.IncludeItemTypes = [BaseItemKind.Movie];
        query.MediaTypes = [MediaType.Video];
        query.BlockUnratedItems = [UnratedItem.Movie];
        query.IncludeInheritedTags = ["allowed"];
        query.ExcludeInheritedTags = ["blocked"];

        Assert.True(ResumeQueryFilter.TryCreate(query, out var translated));
        Assert.NotSame(query, translated);
        Assert.Null(translated.IsResumable);
        Assert.True(translated.IncludeAlternateVersions);
        Assert.True(translated.IncludeOwnedItems);
        Assert.False(translated.IsVirtualItem);
        Assert.Equal(query.TopParentIds, translated.TopParentIds);
        Assert.Equal(query.AncestorIds, translated.AncestorIds);
        Assert.Equal(query.ExcludeItemIds, translated.ExcludeItemIds);
        Assert.Equal([BaseItemKind.Movie], translated.IncludeItemTypes);
        Assert.Equal([MediaType.Video], translated.MediaTypes);
        Assert.Equal([UnratedItem.Movie], translated.BlockUnratedItems);
        Assert.Equal(["allowed"], translated.IncludeInheritedTags);
        Assert.Equal(["blocked"], translated.ExcludeInheritedTags);
        translated.TopParentIds[0] = Guid.Empty;
        Assert.Equal(Guid.Parse("00000000-0000-0000-0000-000000000011"), query.TopParentIds[0]);
        Assert.True(query.IsResumable);
        Assert.False(query.IncludeAlternateVersions);
        Assert.Equal(12, query.Limit);
    }

    [Theory]
    [InlineData("search")]
    [InlineData("folder")]
    [InlineData("sort")]
    [InlineData("favorite")]
    [InlineData("genre")]
    [InlineData("offset")]
    [InlineData("grouping")]
    [InlineData("virtual")]
    public void TryCreate_RejectsUnsupportedCriteria(string criterion)
    {
        var query = CreateQuery();
        switch (criterion)
        {
            case "search": query.SearchTerm = "movie"; break;
            case "folder": query.IsFolder = true; break;
            case "sort": query.OrderBy = [(ItemSortBy.DatePlayed, SortOrder.Ascending)]; break;
            case "favorite": query.IsFavorite = true; break;
            case "genre": query.Genres = ["Drama"]; break;
            case "offset": query.StartIndex = -1; break;
            case "grouping": query.GroupBySeriesPresentationUniqueKey = true; break;
            case "virtual": query.IsVirtualItem = true; break;
        }

        Assert.False(ResumeQueryFilter.TryCreate(query, out var translated));
        Assert.Null(translated);
        Assert.True(query.IsResumable);
    }

    [Theory]
    [InlineData(null)]
    [InlineData(0)]
    public void TryCreate_AcceptsUnboundedOrEmptyPage(int? limit)
    {
        var query = CreateQuery();
        query.Limit = limit;
        query.IncludeOwnedItems = false;
        Assert.True(ResumeQueryFilter.TryCreate(query, out var translated));
        Assert.False(translated.IncludeOwnedItems);
        Assert.True(translated.IncludeAlternateVersions);
    }

    [Fact]
    public void PropertyClassification_CoversCoreQuerySurface()
    {
        var names = typeof(InternalItemsQuery).GetProperties()
            .Where(p => p.CanRead).Select(p => p.Name).Order().ToArray();
        Assert.Equal(names, ResumeQueryFilter.ClassifiedProperties.Order().ToArray());
    }
}
