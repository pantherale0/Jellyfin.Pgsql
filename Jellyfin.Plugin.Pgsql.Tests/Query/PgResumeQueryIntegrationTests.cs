using System;
using System.Linq;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.Pgsql.Configuration;
using Jellyfin.Plugin.Pgsql.Tests.Infrastructure;
using MediaBrowser.Model.Entities;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace Jellyfin.Plugin.Pgsql.Tests.Query;

[Collection(PostgresCollection.Name)]
public sealed class PgResumeQueryIntegrationTests(PostgresDatabaseFixture database)
{
    [PostgresTestFact]
    public void Selector_PreservesVersionWinnersAndNullableDateOrdering()
    {
        using var fixture = new ResumeQueryTestFixture(database);
        fixture.AddItem(1);
        fixture.AddProgress(1, 1);
        fixture.AddProgress(1, 3);
        fixture.AddItem(2);
        fixture.AddItem(3, primary: 2);
        fixture.AddProgress(2, 1);
        fixture.AddProgress(3, 4);
        fixture.AddItem(4);
        fixture.AddItem(5, primary: 4);
        fixture.AddProgress(4, 5);
        fixture.AddProgress(5, 5);
        fixture.AddItem(6);
        fixture.AddItem(7, primary: 6);
        fixture.AddProgress(6, null);
        fixture.AddProgress(7, null);
        fixture.AddItem(8);
        fixture.AddItem(9, primary: 8);
        fixture.AddProgress(8, null);
        fixture.AddProgress(9, 6);

        var result = fixture.Selector().TryGetItems(fixture.Query());
        Assert.NotNull(result);
        Guid[] expected = [fixture.Id(6), fixture.Id(8), fixture.Id(9), fixture.Id(4), fixture.Id(3), fixture.Id(1)];
        Assert.Equal(expected, result.Items.Select(i => i.Id));
        Assert.Equal(6, result.TotalRecordCount);
        Assert.Equal(expected, fixture.Core.GetItems(fixture.Query()).Items.Select(i => i.Id));
    }

    [PostgresTestFact]
    public void Selector_AppliesRestrictionsAfterVersionComparison()
    {
        using var fixture = new ResumeQueryTestFixture(database);
        fixture.AddItem(1);
        fixture.AddProgress(1, 1);
        fixture.AddItem(2, primary: 1, rating: 1500);
        fixture.AddProgress(2, 2);
        fixture.AddItem(3, rating: null);
        fixture.AddProgress(3, 3);
        fixture.AddItem(4);
        fixture.AddProgress(4, 4);
        fixture.AddItem(5);
        fixture.AddProgress(5, 5);
        var query = fixture.Query();
        query.MaxParentalRating = new(1000, 0);
        query.BlockUnratedItems = [UnratedItem.Movie];
        query.ExcludeItemIds = [fixture.Id(5)];

        var result = fixture.Selector().TryGetItems(query);
        Assert.NotNull(result);
        Assert.Equal([fixture.Id(4)], result.Items.Select(i => i.Id));
        Assert.Equal([fixture.Id(4)], fixture.Core.GetItems(query).Items.Select(i => i.Id));
    }

    [PostgresTestFact]
    public void Selector_PreservesTotalsForEmptyAndOffsetPages()
    {
        using var fixture = new ResumeQueryTestFixture(database);
        for (var i = 1; i <= 9; i++)
        {
            fixture.AddItem(i);
            fixture.AddProgress(i, i);
        }

        var query = fixture.Query();
        query.Limit = 2;
        query.StartIndex = 2;
        var selector = fixture.Selector();
        var result = selector.TryGetItems(query);
        Assert.NotNull(result);
        Assert.Equal(9, result.TotalRecordCount);
        Assert.Equal(2, result.StartIndex);
        Assert.Equal([fixture.Id(7), fixture.Id(6)], result.Items.Select(i => i.Id));
        query.StartIndex = 20;
        result = selector.TryGetItems(query);
        Assert.NotNull(result);
        Assert.Empty(result.Items);
        Assert.Equal(9, result.TotalRecordCount);
        query.StartIndex = 0;
        query.Limit = 0;
        result = selector.TryGetItems(query);
        Assert.NotNull(result);
        Assert.Empty(result.Items);
        Assert.Equal(9, result.TotalRecordCount);
        query.Limit = 2;
        query.EnableTotalRecordCount = false;
        Assert.Equal(2, selector.TryGetItems(query)!.TotalRecordCount);
    }

    [PostgresTestFact]
    public void Selector_ReturnsSuccessfulEmptyPageButFallsBackForFolders()
    {
        using var fixture = new ResumeQueryTestFixture(database);
        var selector = fixture.Selector();
        var result = selector.TryGetItems(fixture.Query());
        Assert.NotNull(result);
        Assert.Empty(result.Items);
        Assert.Equal(0, result.TotalRecordCount);
        fixture.AddItem(1, folder: true);
        fixture.AddProgress(1, 1);
        var query = fixture.Query();
        query.Limit = 0;
        Assert.Null(selector.TryGetItems(query));
        Assert.Null(fixture.Selector(new PluginConfiguration { OptimizeResumeQueries = false }).TryGetItems(query));
    }

    [PostgresTestFact]
    public void Selector_IgnoresFolderProgressOutsideTheRequestedScope()
    {
        using var fixture = new ResumeQueryTestFixture(database);
        fixture.AddItem(1);
        fixture.AddProgress(1, 1);
        fixture.AddItem(2, folder: true);
        fixture.AddProgress(2, 2);
        var query = fixture.Query();
        query.ExcludeItemIds = [fixture.Id(2)];

        var result = fixture.Selector().TryGetItems(query);
        Assert.NotNull(result);
        Assert.Equal([fixture.Id(1)], result.Items.Select(i => i.Id));
        Assert.Equal([fixture.Id(1)], fixture.Core.GetItems(query).Items.Select(i => i.Id));
    }

    [PostgresTestFact]
    public void Selector_SupportsExplicitLeafRequestsWithFolderProgress()
    {
        using var fixture = new ResumeQueryTestFixture(database);
        fixture.AddItem(1);
        fixture.AddProgress(1, 1);
        fixture.AddItem(2, folder: true);
        fixture.AddProgress(2, 2);
        var query = fixture.Query();
        query.IsFolder = false;

        var result = fixture.Selector().TryGetItems(query);
        Assert.NotNull(result);
        Assert.Equal([fixture.Id(1)], result.Items.Select(i => i.Id));
        Assert.Equal([fixture.Id(1)], fixture.Core.GetItems(query).Items.Select(i => i.Id));
    }

    [PostgresTestFact]
    public void Selector_ReusesLibraryAndInheritedTagFiltersAndSeparatesUsers()
    {
        using var fixture = new ResumeQueryTestFixture(database);
        fixture.AddItem(1);
        fixture.AddItem(2);
        fixture.AddItem(3);
        fixture.AddProgress(1, 1);
        fixture.AddProgress(2, 2);
        fixture.AddProgress(3, 3, fixture.AddUser().Id);
        fixture.AddItem(10, folder: true);
        fixture.AddItem(11, folder: true);
        fixture.AddTag(10, "resume-allowed");
        fixture.AddTag(11, "resume-blocked");
        using (var context = fixture.Factory.CreateDbContext())
        {
            context.AncestorIds.AddRange(
                new() { ItemId = fixture.Id(1), ParentItemId = fixture.Id(10), Item = null!, ParentItem = null! },
                new() { ItemId = fixture.Id(2), ParentItemId = fixture.Id(10), Item = null!, ParentItem = null! },
                new() { ItemId = fixture.Id(2), ParentItemId = fixture.Id(11), Item = null!, ParentItem = null! });
            context.SaveChanges();
        }
        var query = fixture.Query();
        query.IncludeInheritedTags = ["resume-allowed"];
        query.ExcludeInheritedTags = ["resume-blocked"];
        var result = fixture.Selector().TryGetItems(query);
        Assert.NotNull(result);
        Assert.Equal([fixture.Id(1)], result.Items.Select(i => i.Id));
        Assert.Equal([fixture.Id(1)], fixture.Core.GetItems(query).Items.Select(i => i.Id));
        query.TopParentIds = [Guid.NewGuid()];
        Assert.Empty(fixture.Selector().TryGetItems(query)!.Items);
    }

    [PostgresTestFact]
    public void Selector_PreservesLiveTvAllowlistAndLinkedChildRestrictions()
    {
        using var fixture = new ResumeQueryTestFixture(database);
        fixture.AddItem(1, rating: null);
        fixture.AddProgress(1, 1);
        fixture.AddItem(2);
        fixture.AddProgress(2, 2);
        fixture.AddItem(3, rating: 1500);
        using (var context = fixture.Factory.CreateDbContext())
        {
            context.BaseItems.Where(i => i.Id == fixture.Id(1))
                .ExecuteUpdate(s => s.SetProperty(i => i.UnratedType, "LiveTvChannel"));
            context.LinkedChildren.Add(new Jellyfin.Database.Implementations.Entities.LinkedChildEntity
            {
                ParentId = fixture.Id(2), ChildId = fixture.Id(3),
                ChildType = Jellyfin.Database.Implementations.Entities.LinkedChildType.Manual,
            });
            context.SaveChanges();
        }

        fixture.User.SetPreference(PreferenceKind.AllowedLiveTvChannels, new[] { fixture.Id(1) });
        var query = fixture.Query();
        query.BlockUnratedItems = [UnratedItem.LiveTvChannel];
        query.MaxParentalRating = new(1000, 0);
        var result = fixture.Selector().TryGetItems(query);
        Assert.NotNull(result);
        Assert.Equal([fixture.Id(1)], result.Items.Select(i => i.Id));
        Assert.Equal([fixture.Id(1)], fixture.Core.GetItems(query).Items.Select(i => i.Id));
    }

    [PostgresTestFact]
    public void Selector_HandlesManyVersionsWithoutChangingMixedNullRules()
    {
        using var fixture = new ResumeQueryTestFixture(database);
        fixture.AddItem(100);
        fixture.AddProgress(100, 1);
        for (var i = 1; i <= 64; i++)
        {
            fixture.AddItem(100 + i, primary: 100);
            fixture.AddProgress(100 + i, (i % 28) + 1);
        }

        fixture.AddItem(200, primary: 100);
        fixture.AddProgress(200, null);
        var result = fixture.Selector().TryGetItems(fixture.Query());
        Assert.NotNull(result);
        Assert.Equal([fixture.Id(200), fixture.Id(127)], result.Items.Select(i => i.Id));
        Assert.Equal([fixture.Id(200), fixture.Id(127)], fixture.Core.GetItems(fixture.Query()).Items.Select(i => i.Id));
    }
}
