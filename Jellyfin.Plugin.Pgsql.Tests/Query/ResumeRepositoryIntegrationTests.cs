using System;
using System.Linq;
using Jellyfin.Database.Implementations;
using Jellyfin.Plugin.Pgsql.Configuration;
using Jellyfin.Plugin.Pgsql.Query;
using Jellyfin.Plugin.Pgsql.Tests.Infrastructure;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Model.Querying;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.EntityFrameworkCore;
using Moq;
using Xunit;

namespace Jellyfin.Plugin.Pgsql.Tests.Query;

[Collection(PostgresCollection.Name)]
public sealed class ResumeRepositoryIntegrationTests(PostgresDatabaseFixture database)
{
    [PostgresTestFact]
    public void Repository_OptimizesCountedAndUncountedRequestsWithCacheDisabled()
    {
        using var fixture = new ResumeQueryTestFixture(database);
        fixture.AddItem(1);
        fixture.AddProgress(1, 1);
        fixture.AddItem(2);
        fixture.AddProgress(2, 2);
        var inner = new Mock<IItemRepository>(MockBehavior.Strict);
        var repository = Create(fixture, inner, new PluginConfiguration { EnableQueryCache = false });
        var query = fixture.Query();
        query.Limit = 1;
        var counted = repository.GetItems(query);
        Assert.Equal([fixture.Id(2)], counted.Items.Select(i => i.Id));
        Assert.Equal(2, counted.TotalRecordCount);
        query.EnableTotalRecordCount = false;
        Assert.Equal([fixture.Id(2)], repository.GetItemList(query).Select(i => i.Id));
        Assert.Equal(1, repository.GetItems(query).TotalRecordCount);
        Assert.True(query.IsResumable);
    }

    [PostgresTestFact]
    public void Repository_CachesOrderedIdsAndHydratesOnHit()
    {
        using var fixture = new ResumeQueryTestFixture(database);
        fixture.AddItem(1);
        fixture.AddProgress(1, 1);
        var inner = new Mock<IItemRepository>(MockBehavior.Strict);
        var stats = new QueryRuntimeStats();
        var repository = Create(fixture, inner, new PluginConfiguration { CacheBackend = "Memory" }, stats);
        var query = fixture.Query();
        Assert.Equal([fixture.Id(1)], repository.GetItemList(query).Select(i => i.Id));
        fixture.AddItem(2);
        fixture.AddProgress(2, 2);
        Assert.Equal([fixture.Id(1)], repository.GetItemList(query).Select(i => i.Id));
        Assert.Equal(1, stats.Snapshot().ResumeCacheHits);
        Assert.Equal(1, stats.Snapshot().ResumeCacheMisses);
    }

    [PostgresTestFact]
    public void Repository_ReturnsEmptySuccessWithoutDelegating()
    {
        using var fixture = new ResumeQueryTestFixture(database);
        var repository = Create(fixture, new Mock<IItemRepository>(MockBehavior.Strict),
            new PluginConfiguration { ResumeCacheTtlSeconds = 0 });
        Assert.Empty(repository.GetItemList(fixture.Query()));
        Assert.Equal(0, repository.GetItems(fixture.Query()).TotalRecordCount);
    }

    [PostgresTestFact]
    public void Repository_CountedUnboundedRequestDoesNotUseCachedMembership()
    {
        using var fixture = new ResumeQueryTestFixture(database);
        fixture.AddItem(1);
        fixture.AddProgress(1, 1);
        var repository = Create(fixture, new Mock<IItemRepository>(MockBehavior.Strict),
            new PluginConfiguration { CacheBackend = "Memory" });
        var query = fixture.Query();
        query.Limit = null;
        query.EnableTotalRecordCount = false;
        Assert.Equal([fixture.Id(1)], repository.GetItemList(query).Select(i => i.Id));
        fixture.AddItem(2);
        fixture.AddProgress(2, 2);
        query.EnableTotalRecordCount = true;
        var result = repository.GetItems(query);
        Assert.Equal(2, result.TotalRecordCount);
        Assert.Equal([fixture.Id(2), fixture.Id(1)], result.Items.Select(i => i.Id));
    }

    [PostgresTestFact]
    public void Repository_DelegatesUnsupportedAndDisabledRequests()
    {
        using var fixture = new ResumeQueryTestFixture(database);
        var sentinel = new MediaBrowser.Controller.Entities.Movies.Movie { Id = fixture.Id(99) };
        var inner = new Mock<IItemRepository>(MockBehavior.Strict);
        inner.Setup(i => i.GetItems(It.IsAny<InternalItemsQuery>()))
            .Returns(new QueryResult<BaseItem>([sentinel]));
        var repository = Create(fixture, inner, new PluginConfiguration { OptimizeResumeQueries = false });
        Assert.Equal(sentinel.Id, Assert.Single(repository.GetItems(fixture.Query()).Items).Id);
        var query = fixture.Query();
        query.IsFavorite = true;
        Assert.Equal(sentinel.Id, Assert.Single(repository.GetItems(query).Items).Id);
        inner.Verify(i => i.GetItems(It.IsAny<InternalItemsQuery>()), Times.Exactly(2));
    }

    [PostgresTestFact]
    public void Repository_DelegatesFolderAndRecoverableFailuresExactlyOnce()
    {
        using var fixture = new ResumeQueryTestFixture(database);
        fixture.AddItem(1);
        fixture.AddProgress(1, 1);
        var config = new PluginConfiguration();
        var options = PgsqlQueryOptions.Resolve(config);
        var failingFactory = new ThrowingContextFactory();
        var failedSelector = new PgResumeQuery(failingFactory, fixture.Core, fixture.Loader, options,
            NullLogger<PgResumeQuery>.Instance);
        var failedLoader = new PgResumeQuery(fixture.Factory, fixture.Core,
            new CachedItemLoader(failingFactory, fixture.Core, NullLogger<CachedItemLoader>.Instance),
            options, NullLogger<PgResumeQuery>.Instance);
        foreach (var selector in new[] { failedSelector, failedLoader })
        {
            var fallback = new Mock<IItemRepository>(MockBehavior.Strict);
            fallback.Setup(i => i.GetItems(It.IsAny<InternalItemsQuery>()))
                .Returns(new QueryResult<BaseItem>([new MediaBrowser.Controller.Entities.Movies.Movie { Id = fixture.Id(99) }]));
            var repository = Create(fixture, fallback, config, selector: selector);
            Assert.Equal(fixture.Id(99), Assert.Single(repository.GetItems(fixture.Query()).Items).Id);
            fallback.Verify(i => i.GetItems(It.IsAny<InternalItemsQuery>()), Times.Once);
        }

        fixture.AddItem(2, folder: true);
        fixture.AddProgress(2, 2);
        var core = new Mock<IItemRepository>(MockBehavior.Strict);
        core.Setup(i => i.GetItems(It.IsAny<InternalItemsQuery>())).Returns(new QueryResult<BaseItem>([]));
        Assert.Empty(Create(fixture, core, config).GetItems(fixture.Query()).Items);
        core.Verify(i => i.GetItems(It.IsAny<InternalItemsQuery>()), Times.Once);
    }

    private static CachingItemRepository Create(
        ResumeQueryTestFixture fixture,
        Mock<IItemRepository> inner,
        PluginConfiguration config,
        QueryRuntimeStats? stats = null,
        PgResumeQuery? selector = null) => new(
            inner.Object, new MemoryQueryResultCache(), new MemoryQueryCacheVersionStore(),
            fixture.Loader, null!, selector ?? fixture.Selector(config), PgsqlQueryOptions.Resolve(config),
            stats ?? new QueryRuntimeStats(), NullLogger<CachingItemRepository>.Instance);

    private sealed class ThrowingContextFactory : IDbContextFactory<JellyfinDbContext>
    {
        public JellyfinDbContext CreateDbContext() => throw new InvalidOperationException("Test database unavailable");
    }
}
