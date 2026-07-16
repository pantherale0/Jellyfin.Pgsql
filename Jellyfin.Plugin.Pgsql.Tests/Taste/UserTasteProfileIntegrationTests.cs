using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.Pgsql.Similar;
using Jellyfin.Plugin.Pgsql.Taste;
using Jellyfin.Plugin.Pgsql.Tests.Infrastructure;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Model.Configuration;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using Xunit;

namespace Jellyfin.Plugin.Pgsql.Tests.Taste;

[Collection(PostgresCollection.Name)]
public sealed class UserTasteProfileIntegrationTests
{
    private static readonly Guid TasteUserId = Guid.Parse("eeeeeeee-aaaa-bbbb-cccc-000000000001");
    private static readonly Guid SeedActionId = Guid.Parse("eeeeeeee-aaaa-bbbb-cccc-000000000010");
    private static readonly Guid ComedyFavorite1Id = Guid.Parse("eeeeeeee-aaaa-bbbb-cccc-000000000011");
    private static readonly Guid ComedyFavorite2Id = Guid.Parse("eeeeeeee-aaaa-bbbb-cccc-000000000012");
    private static readonly Guid ComedyFavorite3Id = Guid.Parse("eeeeeeee-aaaa-bbbb-cccc-000000000013");
    private static readonly Guid ActionComedyId = Guid.Parse("eeeeeeee-aaaa-bbbb-cccc-000000000014");
    private static readonly Guid ActionOnlyId = Guid.Parse("eeeeeeee-aaaa-bbbb-cccc-000000000015");
    private static readonly Guid ActionGenreId = Guid.Parse("eeeeeeee-aaaa-bbbb-cccc-0000000000a1");
    private static readonly Guid ComedyGenreId = Guid.Parse("eeeeeeee-aaaa-bbbb-cccc-0000000000a2");

    private static readonly string MovieType = typeof(MediaBrowser.Controller.Entities.Movies.Movie).FullName!;
    private static readonly string SeriesType = typeof(MediaBrowser.Controller.Entities.TV.Series).FullName!;
    private static readonly string EpisodeType = typeof(MediaBrowser.Controller.Entities.TV.Episode).FullName!;

    private readonly PostgresDatabaseFixture _fixture;

    public UserTasteProfileIntegrationTests(PostgresDatabaseFixture fixture)
    {
        _fixture = fixture;
    }

    [PostgresTestFact]
    public async Task Rebuild_WritesProfile_AndTasteBoostsPreferredGenre()
    {
        Assert.True(_fixture.IsAvailable, $"PostgreSQL fixture failed to initialize: {_fixture.InitializationError}");

        var factory = new TestDbContextFactory(_fixture.ConnectionString);
        await using var dbContext = await factory.CreateDbContextAsync().ConfigureAwait(false);
        await SeedTasteCorpusAsync(dbContext).ConfigureAwait(false);

        var builder = new UserTasteProfileBuilder(NullLogger<UserTasteProfileBuilder>.Instance);
        var itemTypeLookup = CreateItemTypeLookup();
        var wrote = await builder.RebuildUserAsync(
                dbContext,
                TasteUserId,
                MovieType,
                SeriesType,
                EpisodeType,
                DateTime.UtcNow.AddDays(-730),
                minSamples: 3,
                default)
            .ConfigureAwait(false);
        Assert.True(wrote.Upserted);

        var profileRow = await dbContext.UserTasteProfiles
            .AsNoTracking()
            .SingleAsync(p => p.UserId == TasteUserId)
            .ConfigureAwait(false);
        Assert.True(profileRow.SampleCount >= 3);
        var payload = UserTasteProfileBuilder.DeserializeFeatures(profileRow.FeaturesJson);
        Assert.True(payload.Genres.ContainsKey("comedy") || payload.Genres.Keys.Any(k => k.Contains("comedy", StringComparison.OrdinalIgnoreCase)));

        var tasteStore = new UserTasteProfileStore(factory, NullLogger<UserTasteProfileStore>.Instance);
        tasteStore.InvalidateAll();
        var provider = CreateProvider(factory, tasteStore);

        var withoutUser = await provider.ComputeBatchScoresAsync([SeedActionId], default).ConfigureAwait(false);
        var withUser = await provider.ComputeBatchScoresAsync([SeedActionId], default, TasteUserId).ConfigureAwait(false);

        Assert.True(withoutUser.ContainsKey(SeedActionId));
        Assert.True(withUser.ContainsKey(SeedActionId));
        var cold = withoutUser[SeedActionId];
        var warm = withUser[SeedActionId];

        Assert.True(cold.ContainsKey(ActionComedyId));
        Assert.True(cold.ContainsKey(ActionOnlyId));
        Assert.Equal(cold[ActionComedyId], cold[ActionOnlyId]);

        Assert.True(warm[ActionComedyId] > warm[ActionOnlyId], "Comedy-affine user should prefer Action+Comedy after taste bonus");
        Assert.True(warm[ActionComedyId] > cold[ActionComedyId]);
        Assert.True(warm[ActionComedyId] - cold[ActionComedyId] <= MovieSimilarityWeights.MaxTasteBonus);
    }

    [PostgresTestFact]
    public async Task ColdStart_NoProfile_TasteDoesNotChangeScores()
    {
        Assert.True(_fixture.IsAvailable, $"PostgreSQL fixture failed to initialize: {_fixture.InitializationError}");

        var factory = new TestDbContextFactory(_fixture.ConnectionString);
        await using var dbContext = await factory.CreateDbContextAsync().ConfigureAwait(false);
        await SeedTasteCorpusAsync(dbContext).ConfigureAwait(false);

        var unknownUser = Guid.Parse("eeeeeeee-aaaa-bbbb-cccc-000000009999");
        await dbContext.UserTasteProfiles
            .Where(p => p.UserId == unknownUser)
            .ExecuteDeleteAsync()
            .ConfigureAwait(false);

        var tasteStore = new UserTasteProfileStore(factory, NullLogger<UserTasteProfileStore>.Instance);
        tasteStore.InvalidateAll();
        var provider = CreateProvider(factory, tasteStore);

        var withoutUser = await provider.ComputeBatchScoresAsync([SeedActionId], default).ConfigureAwait(false);
        var coldUser = await provider.ComputeBatchScoresAsync([SeedActionId], default, unknownUser).ConfigureAwait(false);

        Assert.Equal(withoutUser[SeedActionId][ActionComedyId], coldUser[SeedActionId][ActionComedyId]);
        Assert.Equal(withoutUser[SeedActionId][ActionOnlyId], coldUser[SeedActionId][ActionOnlyId]);
    }

    [PostgresTestFact]
    public async Task ShadowTrain_WritesEvalRow_WithoutChangingServeOrder()
    {
        Assert.True(_fixture.IsAvailable, $"PostgreSQL fixture failed to initialize: {_fixture.InitializationError}");

        var factory = new TestDbContextFactory(_fixture.ConnectionString);
        await using var dbContext = await factory.CreateDbContextAsync().ConfigureAwait(false);
        await SeedTasteCorpusAsync(dbContext).ConfigureAwait(false);

        var itemTypeLookup = CreateItemTypeLookup();
        var builder = new UserTasteProfileBuilder(NullLogger<UserTasteProfileBuilder>.Instance);
        await builder.RebuildAllAsync(dbContext, itemTypeLookup.Object, 730, 3, default).ConfigureAwait(false);

        // Pad training pairs with a second taste user preferring action.
        await SeedSecondUserHistoryAsync(dbContext).ConfigureAwait(false);
        await builder.RebuildAllAsync(dbContext, itemTypeLookup.Object, 730, 3, default).ConfigureAwait(false);

        var trainer = new TasteShadowNeuralTrainer(NullLogger<TasteShadowNeuralTrainer>.Instance);
        var modelDir = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "pgsql-taste-tests", Guid.NewGuid().ToString("N"));
        var beforeCount = await dbContext.TasteModelEvalRuns.CountAsync().ConfigureAwait(false);
        var run = await trainer.TrainAndEvaluateAsync(dbContext, itemTypeLookup.Object, modelDir, default)
            .ConfigureAwait(false);
        Assert.NotNull(run);
        var afterCount = await dbContext.TasteModelEvalRuns.CountAsync().ConfigureAwait(false);
        Assert.True(afterCount > beforeCount);

        var tasteStore = new UserTasteProfileStore(factory, NullLogger<UserTasteProfileStore>.Instance);
        tasteStore.InvalidateAll();
        var provider = CreateProvider(factory, tasteStore);

        var first = await provider.ComputeBatchScoresAsync([SeedActionId], default, TasteUserId).ConfigureAwait(false);
        var second = await provider.ComputeBatchScoresAsync([SeedActionId], default, TasteUserId).ConfigureAwait(false);

        Assert.Equal(first[SeedActionId][ActionComedyId], second[SeedActionId][ActionComedyId]);
        Assert.Equal(first[SeedActionId][ActionOnlyId], second[SeedActionId][ActionOnlyId]);
        Assert.True(first[SeedActionId][ActionComedyId] > first[SeedActionId][ActionOnlyId]);
    }

    [PostgresTestFact]
    public async Task Rebuild_EpisodePlays_RollUpToSeries_WithBingeCap()
    {
        Assert.True(_fixture.IsAvailable, $"PostgreSQL fixture failed to initialize: {_fixture.InitializationError}");

        var factory = new TestDbContextFactory(_fixture.ConnectionString);
        await using var dbContext = await factory.CreateDbContextAsync().ConfigureAwait(false);

        var seriesId = Guid.Parse("eeeeeeee-aaaa-bbbb-cccc-000000000101");
        // Use 110-117 so episode ids never collide with seriesId (...0101) or favoriteSeriesId (...0120).
        var episodeIds = Enumerable.Range(0, 8)
            .Select(i => Guid.Parse($"eeeeeeee-aaaa-bbbb-cccc-00000000011{i}"))
            .ToArray();
        var favoriteSeriesId = Guid.Parse("eeeeeeee-aaaa-bbbb-cccc-000000000120");
        var seriesComedyGenreId = Guid.Parse("eeeeeeee-aaaa-bbbb-cccc-0000000000b1");

        Guid[] cleanupIds = [seriesId, favoriteSeriesId, .. episodeIds];
        await dbContext.UserData.Where(u => u.UserId == TasteUserId).ExecuteDeleteAsync().ConfigureAwait(false);
        await dbContext.UserTasteProfiles.Where(p => p.UserId == TasteUserId).ExecuteDeleteAsync().ConfigureAwait(false);
        await dbContext.ItemValuesMap.Where(m => cleanupIds.Contains(m.ItemId)).ExecuteDeleteAsync().ConfigureAwait(false);
        await dbContext.BaseItems.Where(i => cleanupIds.Contains(i.Id)).ExecuteDeleteAsync().ConfigureAwait(false);

        if (!await dbContext.Users.AnyAsync(u => u.Id == TasteUserId).ConfigureAwait(false))
        {
            dbContext.Users.Add(new User("taste-user", "default", "default") { Id = TasteUserId });
        }

        dbContext.BaseItems.Add(Series(seriesId, "Binge Show", "binge show", 2015));
        dbContext.BaseItems.Add(Series(favoriteSeriesId, "Fav Show", "fav show", 2016));
        foreach (var (episodeId, index) in episodeIds.Select((id, i) => (id, i)))
        {
            dbContext.BaseItems.Add(Episode(episodeId, seriesId, $"Ep {index + 1}", $"ep {index + 1}", 2015));
        }

        await dbContext.SaveChangesAsync().ConfigureAwait(false);

        var comedyId = await EnsureGenreAsync(dbContext, seriesComedyGenreId, "Comedy", "comedy").ConfigureAwait(false);
        await LinkGenreAsync(dbContext, seriesId, comedyId).ConfigureAwait(false);
        await LinkGenreAsync(dbContext, favoriteSeriesId, comedyId).ConfigureAwait(false);

        foreach (var episodeId in episodeIds)
        {
            dbContext.UserData.Add(Played(TasteUserId, episodeId));
        }

        dbContext.UserData.Add(Favorite(TasteUserId, favoriteSeriesId));
        await dbContext.SaveChangesAsync().ConfigureAwait(false);

        var builder = new UserTasteProfileBuilder(NullLogger<UserTasteProfileBuilder>.Instance);
        var outcome = await builder.RebuildUserAsync(
                dbContext,
                TasteUserId,
                MovieType,
                SeriesType,
                EpisodeType,
                DateTime.UtcNow.AddDays(-730),
                minSamples: 1,
                default)
            .ConfigureAwait(false);

        Assert.True(outcome.Upserted);
        Assert.Equal(0, outcome.MovieSignalCount);
        Assert.Equal(2, outcome.SeriesSignalCount);
        Assert.Equal(2, outcome.MediaSignalCount);

        var profileRow = await dbContext.UserTasteProfiles
            .AsNoTracking()
            .SingleAsync(p => p.UserId == TasteUserId)
            .ConfigureAwait(false);
        var payload = UserTasteProfileBuilder.DeserializeFeatures(profileRow.FeaturesJson);
        Assert.Contains(payload.Genres.Keys, k => k.Contains("comedy", StringComparison.OrdinalIgnoreCase));
    }

    [PostgresTestFact]
    public async Task Match_EpisodeId_ReturnsTierKeyedByEpisode_WhenSeriesMatches()
    {
        Assert.True(_fixture.IsAvailable, $"PostgreSQL fixture failed to initialize: {_fixture.InitializationError}");

        var factory = new TestDbContextFactory(_fixture.ConnectionString);
        await using var dbContext = await factory.CreateDbContextAsync().ConfigureAwait(false);
        await SeedTasteCorpusAsync(dbContext).ConfigureAwait(false);

        var seriesId = Guid.Parse("eeeeeeee-aaaa-bbbb-cccc-000000000201");
        var episodeWithSeries = Guid.Parse("eeeeeeee-aaaa-bbbb-cccc-000000000202");
        var episodeWithoutSeries = Guid.Parse("eeeeeeee-aaaa-bbbb-cccc-000000000203");
        var matchGenreId = Guid.Parse("eeeeeeee-aaaa-bbbb-cccc-0000000000c1");

        Guid[] cleanupIds = [seriesId, episodeWithSeries, episodeWithoutSeries];
        await dbContext.ItemValuesMap.Where(m => cleanupIds.Contains(m.ItemId)).ExecuteDeleteAsync().ConfigureAwait(false);
        await dbContext.BaseItems.Where(i => cleanupIds.Contains(i.Id)).ExecuteDeleteAsync().ConfigureAwait(false);

        dbContext.BaseItems.Add(Series(seriesId, "Comedy Series", "comedy series", 2018));
        dbContext.BaseItems.Add(Episode(episodeWithSeries, seriesId, "E1", "e1", 2018));
        dbContext.BaseItems.Add(Episode(episodeWithoutSeries, seriesId: null, "Orphan", "orphan", 2018));
        await dbContext.SaveChangesAsync().ConfigureAwait(false);

        var comedyId = await EnsureGenreAsync(dbContext, matchGenreId, "Comedy", "comedy").ConfigureAwait(false);
        await LinkGenreAsync(dbContext, seriesId, comedyId).ConfigureAwait(false);

        var builder = new UserTasteProfileBuilder(NullLogger<UserTasteProfileBuilder>.Instance);
        await builder.RebuildUserAsync(
                dbContext,
                TasteUserId,
                MovieType,
                SeriesType,
                EpisodeType,
                DateTime.UtcNow.AddDays(-730),
                minSamples: 3,
                default)
            .ConfigureAwait(false);

        var tasteStore = new UserTasteProfileStore(factory, NullLogger<UserTasteProfileStore>.Instance);
        tasteStore.InvalidateAll();
        var matchService = new TasteMatchService(factory, tasteStore);

        var matches = await matchService.MatchAsync(
                TasteUserId,
                [episodeWithSeries, episodeWithoutSeries, ComedyFavorite1Id],
                default)
            .ConfigureAwait(false);

        Assert.Contains(matches, m => m.ItemId == episodeWithSeries);
        Assert.DoesNotContain(matches, m => m.ItemId == episodeWithoutSeries);
        Assert.Contains(matches, m => m.ItemId == ComedyFavorite1Id);
    }

    private static async Task SeedTasteCorpusAsync(JellyfinDbContext dbContext)
    {
        Guid[] ids =
        [
            SeedActionId,
            ComedyFavorite1Id,
            ComedyFavorite2Id,
            ComedyFavorite3Id,
            ActionComedyId,
            ActionOnlyId
        ];

        await dbContext.UserData.Where(u => u.UserId == TasteUserId).ExecuteDeleteAsync().ConfigureAwait(false);
        await dbContext.UserTasteProfiles.Where(p => p.UserId == TasteUserId).ExecuteDeleteAsync().ConfigureAwait(false);
        await dbContext.ItemValuesMap.Where(m => ids.Contains(m.ItemId)).ExecuteDeleteAsync().ConfigureAwait(false);
        await dbContext.BaseItems.Where(i => ids.Contains(i.Id)).ExecuteDeleteAsync().ConfigureAwait(false);

        if (!await dbContext.Users.AnyAsync(u => u.Id == TasteUserId).ConfigureAwait(false))
        {
            dbContext.Users.Add(new User("taste-user", "default", "default") { Id = TasteUserId });
        }

        dbContext.BaseItems.AddRange(
            Movie(SeedActionId, "Seed Action", "seed action", 2018, "Action"),
            Movie(ComedyFavorite1Id, "Comedy One", "comedy one", 2016, "Comedy"),
            Movie(ComedyFavorite2Id, "Comedy Two", "comedy two", 2017, "Comedy"),
            Movie(ComedyFavorite3Id, "Comedy Three", "comedy three", 2019, "Comedy"),
            Movie(ActionComedyId, "Action Comedy Mix", "action comedy mix", 2020, "Action|Comedy"),
            Movie(ActionOnlyId, "Straight Action", "straight action", 2021, "Action"));
        await dbContext.SaveChangesAsync().ConfigureAwait(false);

        var actionId = await EnsureGenreAsync(dbContext, ActionGenreId, "Action", "action").ConfigureAwait(false);
        var comedyId = await EnsureGenreAsync(dbContext, ComedyGenreId, "Comedy", "comedy").ConfigureAwait(false);

        await LinkGenreAsync(dbContext, SeedActionId, actionId).ConfigureAwait(false);
        await LinkGenreAsync(dbContext, ActionComedyId, actionId).ConfigureAwait(false);
        await LinkGenreAsync(dbContext, ActionComedyId, comedyId).ConfigureAwait(false);
        await LinkGenreAsync(dbContext, ActionOnlyId, actionId).ConfigureAwait(false);
        await LinkGenreAsync(dbContext, ComedyFavorite1Id, comedyId).ConfigureAwait(false);
        await LinkGenreAsync(dbContext, ComedyFavorite2Id, comedyId).ConfigureAwait(false);
        await LinkGenreAsync(dbContext, ComedyFavorite3Id, comedyId).ConfigureAwait(false);

        dbContext.UserData.AddRange(
            Favorite(TasteUserId, ComedyFavorite1Id),
            Favorite(TasteUserId, ComedyFavorite2Id),
            Favorite(TasteUserId, ComedyFavorite3Id));
        await dbContext.SaveChangesAsync().ConfigureAwait(false);
    }

    private static async Task SeedSecondUserHistoryAsync(JellyfinDbContext dbContext)
    {
        var userId = Guid.Parse("eeeeeeee-aaaa-bbbb-cccc-000000000002");
        if (!await dbContext.Users.AnyAsync(u => u.Id == userId).ConfigureAwait(false))
        {
            dbContext.Users.Add(new User("taste-user-2", "default", "default") { Id = userId });
        }

        await dbContext.UserData.Where(u => u.UserId == userId).ExecuteDeleteAsync().ConfigureAwait(false);
        dbContext.UserData.AddRange(
            Favorite(userId, SeedActionId),
            Favorite(userId, ActionOnlyId),
            Favorite(userId, ActionComedyId));
        await dbContext.SaveChangesAsync().ConfigureAwait(false);
    }

    private static UserData Favorite(Guid userId, Guid itemId)
        => new()
        {
            UserId = userId,
            ItemId = itemId,
            CustomDataKey = itemId.ToString("N"),
            IsFavorite = true,
            Played = true,
            PlayCount = 2,
            LastPlayedDate = DateTime.UtcNow.AddDays(-10),
            Item = null!,
            User = null!,
        };

    private static async Task<Guid> EnsureGenreAsync(JellyfinDbContext dbContext, Guid preferredId, string value, string clean)
    {
        var existing = await dbContext.ItemValues
            .FirstOrDefaultAsync(v => v.Type == ItemValueType.Genre && v.Value == value)
            .ConfigureAwait(false);
        if (existing is not null)
        {
            return existing.ItemValueId;
        }

        dbContext.ItemValues.Add(new ItemValue
        {
            ItemValueId = preferredId,
            Type = ItemValueType.Genre,
            Value = value,
            CleanValue = clean,
        });
        await dbContext.SaveChangesAsync().ConfigureAwait(false);
        return preferredId;
    }

    private static async Task LinkGenreAsync(JellyfinDbContext dbContext, Guid itemId, Guid genreId)
    {
        if (await dbContext.ItemValuesMap.AnyAsync(m => m.ItemId == itemId && m.ItemValueId == genreId).ConfigureAwait(false))
        {
            return;
        }

        var item = await dbContext.BaseItems.SingleAsync(i => i.Id == itemId).ConfigureAwait(false);
        var value = await dbContext.ItemValues.SingleAsync(v => v.ItemValueId == genreId).ConfigureAwait(false);
        dbContext.ItemValuesMap.Add(new ItemValueMap
        {
            ItemId = itemId,
            ItemValueId = genreId,
            Item = item,
            ItemValue = value,
        });
        await dbContext.SaveChangesAsync().ConfigureAwait(false);
    }

    private static BaseItemEntity Movie(Guid id, string name, string clean, int year, string genres)
        => new()
        {
            Id = id,
            Type = MovieType,
            Name = name,
            CleanName = clean,
            ProductionYear = year,
            Genres = genres,
            SortName = clean,
            IsFolder = false,
            IsVirtualItem = false,
            CommunityRating = 7.5f,
        };

    private static BaseItemEntity Series(Guid id, string name, string clean, int year)
        => new()
        {
            Id = id,
            Type = SeriesType,
            Name = name,
            CleanName = clean,
            ProductionYear = year,
            SortName = clean,
            IsFolder = true,
            IsVirtualItem = false,
            CommunityRating = 7.8f,
        };

    private static BaseItemEntity Episode(Guid id, Guid? seriesId, string name, string clean, int year)
        => new()
        {
            Id = id,
            Type = EpisodeType,
            Name = name,
            CleanName = clean,
            ProductionYear = year,
            SortName = clean,
            SeriesId = seriesId,
            IsFolder = false,
            IsVirtualItem = false,
            CommunityRating = 7.0f,
        };

    private static UserData Played(Guid userId, Guid itemId)
        => new()
        {
            UserId = userId,
            ItemId = itemId,
            CustomDataKey = itemId.ToString("N"),
            IsFavorite = false,
            Played = true,
            PlayCount = 1,
            LastPlayedDate = DateTime.UtcNow.AddDays(-2),
            Item = null!,
            User = null!,
        };

    private static Mock<IItemTypeLookup> CreateItemTypeLookup()
    {
        var itemTypeLookup = new Mock<IItemTypeLookup>();
        itemTypeLookup.SetupGet(l => l.BaseItemKindNames).Returns(new Dictionary<BaseItemKind, string>
        {
            [BaseItemKind.Movie] = MovieType,
            [BaseItemKind.Series] = SeriesType,
            [BaseItemKind.Episode] = EpisodeType,
            [BaseItemKind.Trailer] = typeof(MediaBrowser.Controller.Entities.Trailer).FullName!,
            [BaseItemKind.BoxSet] = typeof(MediaBrowser.Controller.Entities.Movies.BoxSet).FullName!,
        });
        return itemTypeLookup;
    }

    private static PostgresMovieSimilarItemsProvider CreateProvider(
        TestDbContextFactory factory,
        UserTasteProfileStore tasteStore)
    {
        var itemTypeLookup = CreateItemTypeLookup();
        var config = new Mock<IServerConfigurationManager>();
        config.SetupGet(c => c.Configuration).Returns(new ServerConfiguration
        {
            EnableExternalContentInSuggestions = false
        });

        return new PostgresMovieSimilarItemsProvider(
            factory,
            new Mock<IItemQueryHelpers>(MockBehavior.Strict).Object,
            itemTypeLookup.Object,
            config.Object,
            tasteStore,
            NullLogger<PostgresMovieSimilarItemsProvider>.Instance);
    }
}
