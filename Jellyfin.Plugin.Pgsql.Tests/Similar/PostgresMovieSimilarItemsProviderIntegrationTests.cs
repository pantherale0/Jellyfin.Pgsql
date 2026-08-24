using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.Pgsql.Query;
using Jellyfin.Plugin.Pgsql.Similar;
using Jellyfin.Plugin.Pgsql.Taste;
using Jellyfin.Plugin.Pgsql.Tests.Infrastructure;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
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
    private static readonly Guid BecauseYouUserId = Guid.Parse("cccccccc-dddd-eeee-ffff-0000000000aa");

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

        Assert.True(scores.TryGetValue(SpiderMan2002Id, out var map));

        Assert.True(map.TryGetValue(SpiderMan2004Id, out var spiderMan2004Score), "Expected collection mate Spider-Man 2");
        Assert.True(map.TryGetValue(SpiderMan2007Id, out var spiderMan2007Score), "Expected collection mate Spider-Man 3");
        Assert.True(map.TryGetValue(AmazingSpiderManId, out _) || map.TryGetValue(NoWayHomeId, out _),
            "Expected title-franchise Spider-Man film outside the Raimi box set");
        Assert.True(map.TryGetValue(ActionGenreOnlyId, out var actionGenreOnlyScore), "Expected shared-genre Action film");

        Assert.True(
            spiderMan2004Score > map.GetValueOrDefault(AmazingSpiderManId)
            || spiderMan2004Score > map.GetValueOrDefault(NoWayHomeId),
            "Collection mates must outrank title-franchise-only matches");

        var bestTitleFranchise = Math.Max(
            map.GetValueOrDefault(AmazingSpiderManId),
            map.GetValueOrDefault(NoWayHomeId));
        Assert.True(
            bestTitleFranchise > actionGenreOnlyScore,
            $"Title franchise score {bestTitleFranchise} should beat genre-only {actionGenreOnlyScore}");

        Assert.False(map.ContainsKey(UnrelatedId));
        Assert.True(spiderMan2004Score >= MovieSimilarityWeights.CollectionWeight);
        Assert.True(spiderMan2007Score >= MovieSimilarityWeights.CollectionWeight);
    }

    [PostgresTestFact]
    public async Task RebuildBecauseYou_WritesCappedUnplayedSimilarsPerSource()
    {
        Assert.True(_fixture.IsAvailable, $"PostgreSQL fixture failed to initialize: {_fixture.InitializationError}");

        var factory = new TestDbContextFactory(_fixture.ConnectionString);
        await using var dbContext = await factory.CreateDbContextAsync().ConfigureAwait(false);
        await SeedFranchiseCorpusAsync(dbContext).ConfigureAwait(false);
        await SeedBecauseYouUserAsync(dbContext).ConfigureAwait(false);

        var previous = TasteOptions.TestOverride;
        TasteOptions.TestOverride = TasteOptions.CreateForTests(useNeuralForServing: false);
        try
        {
            var service = CreateBecauseYouService(factory);
            await service.RebuildUserAsync(BecauseYouUserId, default).ConfigureAwait(false);
        }
        finally
        {
            TasteOptions.TestOverride = previous;
        }

        var rows = await dbContext.UserTasteBecauseYouRecommendations.AsNoTracking()
            .Where(r => r.UserId == BecauseYouUserId)
            .OrderBy(r => r.SourceItemId)
            .ThenBy(r => r.Rank)
            .ToListAsync()
            .ConfigureAwait(false);

        Assert.Contains(rows, r => r.SourceItemId == SpiderMan2002Id && r.SourceKind == BecauseYouSourceKinds.RecentlyPlayed);
        Assert.Contains(rows, r => r.SourceItemId == AmazingSpiderManId && r.SourceKind == BecauseYouSourceKinds.Liked);
        Assert.DoesNotContain(rows, r => r.ItemId == SpiderMan2002Id);
        Assert.All(rows.GroupBy(r => r.SourceItemId), g => Assert.True(g.Count() <= PostgresMovieSimilarItemsProvider.BecauseYouPerSourceLimit));
        Assert.Contains(rows, r => r.SourceItemId == SpiderMan2002Id && r.ItemId == SpiderMan2004Id);
    }

    [PostgresTestFact]
    public async Task GetBatchSimilarItems_ServesStoredRows_WithoutLiveScoring()
    {
        Assert.True(_fixture.IsAvailable, $"PostgreSQL fixture failed to initialize: {_fixture.InitializationError}");

        var factory = new TestDbContextFactory(_fixture.ConnectionString);
        await using var dbContext = await factory.CreateDbContextAsync().ConfigureAwait(false);
        await SeedFranchiseCorpusAsync(dbContext).ConfigureAwait(false);
        await SeedBecauseYouUserAsync(dbContext).ConfigureAwait(false);

        await dbContext.UserTasteBecauseYouRecommendations.Where(r => r.UserId == BecauseYouUserId)
            .ExecuteDeleteAsync()
            .ConfigureAwait(false);
        dbContext.UserTasteBecauseYouRecommendations.AddRange(
            Stored(BecauseYouUserId, SpiderMan2002Id, 0, ActionGenreOnlyId, 10),
            Stored(BecauseYouUserId, SpiderMan2002Id, 1, UnrelatedId, 5));
        await dbContext.SaveChangesAsync().ConfigureAwait(false);

        var provider = CreateProvider(factory, looseQueryHelpers: true);
        var user = await dbContext.Users.AsNoTracking().SingleAsync(u => u.Id == BecauseYouUserId).ConfigureAwait(false);
        var source = new Movie { Id = SpiderMan2002Id, Name = "Spider-Man" };
        var result = await provider.GetBatchSimilarItemsAsync(
                [source],
                new SimilarItemsQuery { User = user, Limit = 8 },
                default)
            .ConfigureAwait(false);

        Assert.True(result.TryGetValue(SpiderMan2002Id, out var items));
        Assert.Equal([ActionGenreOnlyId, UnrelatedId], items.Select(i => i.Id).ToArray());
    }

    [PostgresTestFact]
    public async Task ComputeBatchScores_CacheMiss_DoesNotRequireNeuralModel()
    {
        Assert.True(_fixture.IsAvailable, $"PostgreSQL fixture failed to initialize: {_fixture.InitializationError}");

        var factory = new TestDbContextFactory(_fixture.ConnectionString);
        await using var dbContext = await factory.CreateDbContextAsync().ConfigureAwait(false);
        await SeedFranchiseCorpusAsync(dbContext).ConfigureAwait(false);

        var previous = TasteOptions.TestOverride;
        TasteOptions.TestOverride = TasteOptions.CreateForTests(useNeuralForServing: true);
        try
        {
            var provider = CreateProvider(factory);
            var scores = await provider.ComputeBatchScoresAsync(
                    [SpiderMan2002Id],
                    default,
                    BecauseYouUserId,
                    useNeural: false)
                .ConfigureAwait(false);

            Assert.True(scores.TryGetValue(SpiderMan2002Id, out var map));
            Assert.True(map.ContainsKey(SpiderMan2004Id));
        }
        finally
        {
            TasteOptions.TestOverride = previous;
        }
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

    private static PostgresMovieSimilarItemsProvider CreateProvider(TestDbContextFactory factory, bool looseQueryHelpers = false)
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

        var queryHelpers = looseQueryHelpers
            ? CreateLooseQueryHelpers()
            : new Mock<IItemQueryHelpers>(MockBehavior.Strict);
        var tasteStore = new UserTasteProfileStore(factory, NullLogger<UserTasteProfileStore>.Instance);

        return new PostgresMovieSimilarItemsProvider(
            factory,
            queryHelpers.Object,
            itemTypeLookup.Object,
            config.Object,
            tasteStore,
            new TasteNeuralModelStore(
                factory,
                new MemoryQueryResultCache(),
                NullLogger<TasteNeuralModelStore>.Instance),
            NullLogger<PostgresMovieSimilarItemsProvider>.Instance);
    }

    private static Mock<IItemQueryHelpers> CreateLooseQueryHelpers()
    {
        var queryHelpers = new Mock<IItemQueryHelpers>(MockBehavior.Loose);
        queryHelpers.Setup(h => h.PrepareFilterQuery(It.IsAny<InternalItemsQuery>()));
        queryHelpers
            .Setup(h => h.PrepareItemQuery(It.IsAny<JellyfinDbContext>(), It.IsAny<InternalItemsQuery>()))
            .Returns((JellyfinDbContext ctx, InternalItemsQuery _) => ctx.BaseItems.AsNoTracking());
        queryHelpers
            .Setup(h => h.TranslateQuery(
                It.IsAny<IQueryable<BaseItemEntity>>(),
                It.IsAny<JellyfinDbContext>(),
                It.IsAny<InternalItemsQuery>()))
            .Returns((IQueryable<BaseItemEntity> q, JellyfinDbContext _, InternalItemsQuery _) => q);
        queryHelpers
            .Setup(h => h.ApplyNavigations(It.IsAny<IQueryable<BaseItemEntity>>(), It.IsAny<InternalItemsQuery>()))
            .Returns((IQueryable<BaseItemEntity> q, InternalItemsQuery _) => q);
        queryHelpers
            .Setup(h => h.DeserializeBaseItem(It.IsAny<BaseItemEntity>(), It.IsAny<bool>()))
            .Returns((BaseItemEntity entity, bool _) => new Movie { Id = entity.Id, Name = entity.Name });
        return queryHelpers;
    }

    private static TasteBecauseYouService CreateBecauseYouService(TestDbContextFactory factory)
    {
        var itemTypeLookup = new Mock<IItemTypeLookup>();
        itemTypeLookup.SetupGet(l => l.BaseItemKindNames).Returns(new Dictionary<BaseItemKind, string>
        {
            [BaseItemKind.Movie] = MovieType,
            [BaseItemKind.Trailer] = typeof(MediaBrowser.Controller.Entities.Trailer).FullName!,
            [BaseItemKind.BoxSet] = BoxSetType,
        });

        return new TasteBecauseYouService(
            factory,
            CreateProvider(factory),
            itemTypeLookup.Object,
            NullLogger<TasteBecauseYouService>.Instance);
    }

    private static async Task SeedBecauseYouUserAsync(JellyfinDbContext dbContext)
    {
        await dbContext.UserTasteBecauseYouRecommendations.Where(r => r.UserId == BecauseYouUserId)
            .ExecuteDeleteAsync()
            .ConfigureAwait(false);
        await dbContext.UserData.Where(u => u.UserId == BecauseYouUserId).ExecuteDeleteAsync().ConfigureAwait(false);

        if (!await dbContext.Users.AnyAsync(u => u.Id == BecauseYouUserId).ConfigureAwait(false))
        {
            dbContext.Users.Add(new User("because-you-user", "default", "default") { Id = BecauseYouUserId });
            await dbContext.SaveChangesAsync().ConfigureAwait(false);
        }

        dbContext.UserData.AddRange(
            new UserData
            {
                UserId = BecauseYouUserId,
                ItemId = SpiderMan2002Id,
                CustomDataKey = SpiderMan2002Id.ToString("N"),
                Played = true,
                PlayCount = 1,
                LastPlayedDate = DateTime.UtcNow.AddDays(-1),
                Item = null!,
                User = null!,
            },
            new UserData
            {
                UserId = BecauseYouUserId,
                ItemId = AmazingSpiderManId,
                CustomDataKey = AmazingSpiderManId.ToString("N"),
                IsFavorite = true,
                Played = false,
                PlayCount = 0,
                Item = null!,
                User = null!,
            });
        await dbContext.SaveChangesAsync().ConfigureAwait(false);
    }

    private static UserTasteBecauseYouRecommendation Stored(
        Guid userId,
        Guid sourceId,
        int rank,
        Guid itemId,
        int score)
        => new()
        {
            UserId = userId,
            SourceItemId = sourceId,
            Rank = rank,
            SourceKind = BecauseYouSourceKinds.RecentlyPlayed,
            ItemId = itemId,
            Score = score,
            UpdatedAt = DateTime.UtcNow
        };

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
            .AnyAsync(m => m.ItemId == SpiderMan2002Id
                && dbContext.ItemValues.Any(v => v.ItemValueId == m.ItemValueId
                    && v.Type == ItemValueType.Genre
                    && v.Value == "Action"))
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

        await dbContext.SaveChangesAsync().ConfigureAwait(false);

        var actionGenre = await dbContext.ItemValues
            .FirstOrDefaultAsync(v => v.Type == ItemValueType.Genre && v.Value == "Action")
            .ConfigureAwait(false);
        if (actionGenre is null)
        {
            actionGenre = new ItemValue
            {
                ItemValueId = ActionGenreValueId,
                Type = ItemValueType.Genre,
                Value = "Action",
                CleanValue = "action",
            };
            dbContext.ItemValues.Add(actionGenre);
            await dbContext.SaveChangesAsync().ConfigureAwait(false);
        }

        var actionGenreId = actionGenre.ItemValueId;

        Guid[] actionLinked =
        [
            SpiderMan2002Id,
            SpiderMan2004Id,
            SpiderMan2007Id,
            AmazingSpiderManId,
            NoWayHomeId,
            ActionGenreOnlyId
        ];

        var existingActionLinks = await dbContext.ItemValuesMap
            .Where(m => actionLinked.Contains(m.ItemId) && m.ItemValueId == actionGenreId)
            .Select(m => m.ItemId)
            .ToListAsync()
            .ConfigureAwait(false);

        foreach (var itemId in actionLinked.Where(id => !existingActionLinks.Contains(id)))
        {
            var item = await dbContext.BaseItems.SingleAsync(i => i.Id == itemId).ConfigureAwait(false);
            var value = await dbContext.ItemValues.SingleAsync(v => v.ItemValueId == actionGenreId)
                .ConfigureAwait(false);
            dbContext.ItemValuesMap.Add(new ItemValueMap
            {
                ItemId = itemId,
                ItemValueId = actionGenreId,
                Item = item,
                ItemValue = value,
            });
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
