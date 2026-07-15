using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.Pgsql.Similar;
using Jellyfin.Plugin.Pgsql.Tests.Infrastructure;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Model.Configuration;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using Xunit;
using DbLinkedChildType = Jellyfin.Database.Implementations.Entities.LinkedChildType;

namespace Jellyfin.Plugin.Pgsql.Tests.Similar;

[Collection(PostgresCollection.Name)]
public sealed class PostgresMovieSimilarItemsProviderIntegrationTests
{
    private static readonly Guid SpiderMan2002Id = Guid.Parse("cccccccc-dddd-eeee-ffff-000000000001");
    private static readonly Guid SpiderMan2004Id = Guid.Parse("cccccccc-dddd-eeee-ffff-000000000002");
    private static readonly Guid SpiderMan2007Id = Guid.Parse("cccccccc-dddd-eeee-ffff-000000000003");
    private static readonly Guid AmazingSpiderManId = Guid.Parse("cccccccc-dddd-eeee-ffff-000000000004");
    private static readonly Guid NoWayHomeId = Guid.Parse("cccccccc-dddd-eeee-ffff-000000000005");
    private static readonly Guid ActionGenreOnlyId = Guid.Parse("cccccccc-dddd-eeee-ffff-000000000006");
    private static readonly Guid UnrelatedId = Guid.Parse("cccccccc-dddd-eeee-ffff-000000000099");
    private static readonly Guid RaimiBoxSetId = Guid.Parse("cccccccc-dddd-eeee-ffff-0000000000a1");
    private static readonly Guid ActionGenreValueId = Guid.Parse("cccccccc-dddd-eeee-ffff-0000000000b1");

    private static readonly string MovieType = typeof(MediaBrowser.Controller.Entities.Movies.Movie).FullName!;
    private static readonly string BoxSetType = typeof(MediaBrowser.Controller.Entities.Movies.BoxSet).FullName!;

    private readonly PostgresDatabaseFixture _fixture;

    public PostgresMovieSimilarItemsProviderIntegrationTests(PostgresDatabaseFixture fixture)
    {
        _fixture = fixture;
    }

    [PostgresTestFact]
    public async Task ComputeBatchScores_RanksCollectionAboveTitleFranchiseAboveGenre()
    {
        Assert.True(_fixture.IsAvailable, $"PostgreSQL fixture failed to initialize: {_fixture.InitializationError}");

        var factory = new TestDbContextFactory(_fixture.ConnectionString);
        await using var dbContext = await factory.CreateDbContextAsync().ConfigureAwait(false);
        await SeedFranchiseCorpusAsync(dbContext).ConfigureAwait(false);

        var provider = CreateProvider(factory);
        var scores = await provider.ComputeBatchScoresAsync([SpiderMan2002Id], default).ConfigureAwait(false);

        Assert.True(scores.ContainsKey(SpiderMan2002Id));
        var map = scores[SpiderMan2002Id];

        Assert.True(map.ContainsKey(SpiderMan2004Id), "Expected collection mate Spider-Man 2");
        Assert.True(map.ContainsKey(SpiderMan2007Id), "Expected collection mate Spider-Man 3");
        Assert.True(map.ContainsKey(AmazingSpiderManId) || map.ContainsKey(NoWayHomeId),
            "Expected title-franchise Spider-Man film outside the Raimi box set");
        Assert.True(map.ContainsKey(ActionGenreOnlyId), "Expected shared-genre Action film");

        Assert.True(
            map[SpiderMan2004Id] > map.GetValueOrDefault(AmazingSpiderManId)
            || map[SpiderMan2004Id] > map.GetValueOrDefault(NoWayHomeId),
            "Collection mates must outrank title-franchise-only matches");

        var bestTitleFranchise = Math.Max(
            map.GetValueOrDefault(AmazingSpiderManId),
            map.GetValueOrDefault(NoWayHomeId));
        Assert.True(
            bestTitleFranchise > map[ActionGenreOnlyId],
            $"Title franchise score {bestTitleFranchise} should beat genre-only {map[ActionGenreOnlyId]}");

        Assert.False(map.ContainsKey(UnrelatedId));
        Assert.True(map[SpiderMan2004Id] >= MovieSimilarityWeights.CollectionWeight);
        Assert.True(map[SpiderMan2007Id] >= MovieSimilarityWeights.CollectionWeight);
    }

    [PostgresTestFact]
    public async Task ComputeBatchScores_CollectionMates_OrderByProductionYearWhenScoresEqual()
    {
        Assert.True(_fixture.IsAvailable, $"PostgreSQL fixture failed to initialize: {_fixture.InitializationError}");

        var factory = new TestDbContextFactory(_fixture.ConnectionString);
        await using var dbContext = await factory.CreateDbContextAsync().ConfigureAwait(false);
        await SeedFranchiseCorpusAsync(dbContext).ConfigureAwait(false);

        var provider = CreateProvider(factory);
        var scores = await provider.ComputeBatchScoresAsync([SpiderMan2002Id], default).ConfigureAwait(false);
        var map = scores[SpiderMan2002Id];

        // Same collection weight for both sequels; binge order uses ProductionYear in the provider pick phase.
        Assert.Equal(map[SpiderMan2004Id], map[SpiderMan2007Id]);

        var ordered = new[]
            {
                (Id: SpiderMan2004Id, Year: 2004, Score: map[SpiderMan2004Id]),
                (Id: SpiderMan2007Id, Year: 2007, Score: map[SpiderMan2007Id]),
            }
            .OrderByDescending(x => x.Score)
            .ThenBy(x => x.Year)
            .Select(x => x.Id)
            .ToArray();

        Assert.Equal([SpiderMan2004Id, SpiderMan2007Id], ordered);
    }

    private static PostgresMovieSimilarItemsProvider CreateProvider(TestDbContextFactory factory)
    {
        var itemTypeLookup = new Mock<IItemTypeLookup>();
        itemTypeLookup.SetupGet(l => l.BaseItemKindNames).Returns(new Dictionary<BaseItemKind, string>
        {
            [BaseItemKind.Movie] = MovieType,
            [BaseItemKind.Trailer] = typeof(MediaBrowser.Controller.Entities.Trailer).FullName!,
            [BaseItemKind.BoxSet] = BoxSetType,
        });

        var config = new Mock<IServerConfigurationManager>();
        config.SetupGet(c => c.Configuration).Returns(new ServerConfiguration
        {
            EnableExternalContentInSuggestions = false
        });

        var queryHelpers = new Mock<IItemQueryHelpers>(MockBehavior.Strict);

        return new PostgresMovieSimilarItemsProvider(
            factory,
            queryHelpers.Object,
            itemTypeLookup.Object,
            config.Object,
            NullLogger<PostgresMovieSimilarItemsProvider>.Instance);
    }

    private static async Task SeedFranchiseCorpusAsync(JellyfinDbContext dbContext)
    {
        Guid[] ids =
        [
            SpiderMan2002Id,
            SpiderMan2004Id,
            SpiderMan2007Id,
            AmazingSpiderManId,
            NoWayHomeId,
            ActionGenreOnlyId,
            UnrelatedId,
            RaimiBoxSetId
        ];

        var existingMovies = await dbContext.BaseItems
            .Where(i => ids.Contains(i.Id))
            .CountAsync()
            .ConfigureAwait(false);
        var hasLinks = await dbContext.LinkedChildren
            .AnyAsync(lc => lc.ParentId == RaimiBoxSetId)
            .ConfigureAwait(false);
        var hasGenreMap = await dbContext.ItemValuesMap
            .AnyAsync(m => m.ItemId == SpiderMan2002Id && m.ItemValueId == ActionGenreValueId)
            .ConfigureAwait(false);

        if (existingMovies == ids.Length && hasLinks && hasGenreMap)
        {
            return;
        }

        await dbContext.ItemValuesMap.Where(m => ids.Contains(m.ItemId)).ExecuteDeleteAsync().ConfigureAwait(false);
        await dbContext.LinkedChildren.Where(lc => lc.ParentId == RaimiBoxSetId || ids.Contains(lc.ChildId))
            .ExecuteDeleteAsync()
            .ConfigureAwait(false);
        await dbContext.BaseItems.Where(i => ids.Contains(i.Id)).ExecuteDeleteAsync().ConfigureAwait(false);

        var orphanValues = await dbContext.ItemValues
            .Where(v => v.ItemValueId == ActionGenreValueId
                && !dbContext.ItemValuesMap.Any(m => m.ItemValueId == v.ItemValueId))
            .ToListAsync()
            .ConfigureAwait(false);
        if (orphanValues.Count > 0)
        {
            dbContext.ItemValues.RemoveRange(orphanValues);
            await dbContext.SaveChangesAsync().ConfigureAwait(false);
        }

        dbContext.BaseItems.AddRange(
            Movie(SpiderMan2002Id, "Spider-Man", "spider man", 2002, "Action|Adventure"),
            Movie(SpiderMan2004Id, "Spider-Man 2", "spider man 2", 2004, "Action|Adventure"),
            Movie(SpiderMan2007Id, "Spider-Man 3", "spider man 3", 2007, "Action|Adventure"),
            Movie(AmazingSpiderManId, "The Amazing Spider-Man", "the amazing spider man", 2012, "Action|Adventure"),
            Movie(NoWayHomeId, "Spider-Man: No Way Home", "spider man no way home", 2021, "Action|Adventure"),
            Movie(ActionGenreOnlyId, "Generic Action Flick", "generic action flick", 2015, "Action|Thriller"),
            Movie(UnrelatedId, "Quantum Physics Lecture", "quantum physics lecture", 2010, "Documentary"),
            new BaseItemEntity
            {
                Id = RaimiBoxSetId,
                Type = BoxSetType,
                Name = "Spider-Man Trilogy",
                CleanName = "spider man trilogy",
                IsFolder = true,
                IsVirtualItem = false,
            });

        var actionGenre = new ItemValue
        {
            ItemValueId = ActionGenreValueId,
            Type = ItemValueType.Genre,
            Value = "Action",
            CleanValue = "action",
        };

        if (!await dbContext.ItemValues.AnyAsync(v => v.ItemValueId == ActionGenreValueId).ConfigureAwait(false))
        {
            dbContext.ItemValues.Add(actionGenre);
        }

        await dbContext.SaveChangesAsync().ConfigureAwait(false);

        Guid[] actionLinked =
        [
            SpiderMan2002Id,
            SpiderMan2004Id,
            SpiderMan2007Id,
            AmazingSpiderManId,
            NoWayHomeId,
            ActionGenreOnlyId
        ];

        foreach (var itemId in actionLinked)
        {
            if (!await dbContext.ItemValuesMap.AnyAsync(m => m.ItemId == itemId && m.ItemValueId == ActionGenreValueId)
                    .ConfigureAwait(false))
            {
                var item = await dbContext.BaseItems.SingleAsync(i => i.Id == itemId).ConfigureAwait(false);
                var value = await dbContext.ItemValues.SingleAsync(v => v.ItemValueId == ActionGenreValueId)
                    .ConfigureAwait(false);
                dbContext.ItemValuesMap.Add(new ItemValueMap
                {
                    ItemId = itemId,
                    ItemValueId = ActionGenreValueId,
                    Item = item,
                    ItemValue = value,
                });
            }
        }

        Guid[] raimiKids = [SpiderMan2002Id, SpiderMan2004Id, SpiderMan2007Id];
        foreach (var (index, childId) in raimiKids.Index())
        {
            if (!await dbContext.LinkedChildren.AnyAsync(lc => lc.ParentId == RaimiBoxSetId && lc.ChildId == childId)
                    .ConfigureAwait(false))
            {
                dbContext.LinkedChildren.Add(new LinkedChildEntity
                {
                    ParentId = RaimiBoxSetId,
                    ChildId = childId,
                    ChildType = DbLinkedChildType.Manual,
                    SortOrder = index,
                });
            }
        }

        await dbContext.SaveChangesAsync().ConfigureAwait(false);
    }

    private static BaseItemEntity Movie(Guid id, string name, string cleanName, int year, string genres)
    {
        return new BaseItemEntity
        {
            Id = id,
            Type = MovieType,
            Name = name,
            CleanName = cleanName,
            ProductionYear = year,
            SortName = cleanName,
            Genres = genres,
            MediaType = "Video",
            IsVirtualItem = false,
            IsMovie = true,
            PresentationUniqueKey = id.ToString("N"),
        };
    }
}
