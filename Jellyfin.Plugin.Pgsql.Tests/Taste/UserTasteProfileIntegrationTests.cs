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
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Model.Configuration;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using Xunit;
using DbLinkedChildType = Jellyfin.Database.Implementations.Entities.LinkedChildType;

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

        Assert.True(withoutUser.TryGetValue(SeedActionId, out var cold));
        Assert.True(withUser.TryGetValue(SeedActionId, out var warm));

        Assert.True(cold.TryGetValue(ActionComedyId, out var coldComedy));
        Assert.True(cold.TryGetValue(ActionOnlyId, out var coldOnly));
        Assert.Equal(coldComedy, coldOnly);

        Assert.True(warm[ActionComedyId] > warm[ActionOnlyId], "Comedy-affine user should prefer Action+Comedy after taste bonus");
        Assert.True(warm[ActionComedyId] > coldComedy);
        Assert.True(warm[ActionComedyId] - coldComedy <= MovieSimilarityWeights.MaxTasteBonus);
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
    public async Task Rebuild_WritesYearRuntimeParentalAndSeriesShare()
    {
        Assert.True(_fixture.IsAvailable, $"PostgreSQL fixture failed to initialize: {_fixture.InitializationError}");

        var factory = new TestDbContextFactory(_fixture.ConnectionString);
        await using var dbContext = await factory.CreateDbContextAsync().ConfigureAwait(false);

        var userId = Guid.Parse("eeeeeeee-aaaa-bbbb-cccc-00000000b501");
        var movieId = Guid.Parse("eeeeeeee-aaaa-bbbb-cccc-00000000b511");
        var seriesId = Guid.Parse("eeeeeeee-aaaa-bbbb-cccc-00000000b512");
        var comedyGenre = Guid.Parse("eeeeeeee-aaaa-bbbb-cccc-00000000b5a1");
        var runtime = TimeSpan.FromMinutes(110).Ticks;

        Guid[] users = [userId];
        Guid[] items = [movieId, seriesId];
        await dbContext.UserData.Where(u => users.Contains(u.UserId)).ExecuteDeleteAsync().ConfigureAwait(false);
        await dbContext.UserTasteProfiles.Where(p => users.Contains(p.UserId)).ExecuteDeleteAsync().ConfigureAwait(false);
        await dbContext.ItemValuesMap.Where(m => items.Contains(m.ItemId)).ExecuteDeleteAsync().ConfigureAwait(false);
        await dbContext.BaseItems.Where(i => items.Contains(i.Id)).ExecuteDeleteAsync().ConfigureAwait(false);

        if (!await dbContext.Users.AnyAsync(u => u.Id == userId).ConfigureAwait(false))
        {
            dbContext.Users.Add(new User("band-stats", "Band", "1") { Id = userId });
        }

        var movie = MovieWithRuntime(movieId, "Band Movie", "bandmovie", 2018, "Comedy", runtime);
        movie.InheritedParentalRatingValue = 6;
        var series = Series(seriesId, "Band Series", "bandseries", 2020);
        series.RunTimeTicks = runtime;
        series.InheritedParentalRatingValue = 4;
        dbContext.BaseItems.AddRange(movie, series);
        await dbContext.SaveChangesAsync().ConfigureAwait(false);

        var comedyValueId = await EnsureGenreAsync(dbContext, comedyGenre, "Comedy", "comedy").ConfigureAwait(false);
        await LinkGenreAsync(dbContext, movieId, comedyValueId).ConfigureAwait(false);
        await LinkGenreAsync(dbContext, seriesId, comedyValueId).ConfigureAwait(false);

        dbContext.UserData.AddRange(Favorite(userId, movieId), Favorite(userId, seriesId));
        await dbContext.SaveChangesAsync().ConfigureAwait(false);

        var builder = new UserTasteProfileBuilder(NullLogger<UserTasteProfileBuilder>.Instance);
        var outcome = await builder.RebuildUserAsync(
                dbContext,
                userId,
                MovieType,
                SeriesType,
                EpisodeType,
                DateTime.UtcNow.AddDays(-730),
                minSamples: 2,
                default)
            .ConfigureAwait(false);
        Assert.True(outcome.Upserted);

        var row = await dbContext.UserTasteProfiles.AsNoTracking()
            .SingleAsync(p => p.UserId == userId)
            .ConfigureAwait(false);
        var payload = UserTasteProfileBuilder.DeserializeFeatures(row.FeaturesJson);
        Assert.NotNull(payload.YearMean);
        Assert.NotNull(payload.YearP25);
        Assert.NotNull(payload.YearP75);
        Assert.NotNull(payload.RuntimeMeanTicks);
        Assert.NotNull(payload.ParentalMean);
        Assert.Equal(0.5f, payload.SeriesShare);
        Assert.InRange(payload.YearMean!.Value, 2018f, 2020f);
    }

    [PostgresTestFact]
    public async Task Rebuild_WritesWriterBoxSetLanguageCountry_AndBoostsOverlap()
    {
        Assert.True(_fixture.IsAvailable, $"PostgreSQL fixture failed to initialize: {_fixture.InitializationError}");

        var factory = new TestDbContextFactory(_fixture.ConnectionString);
        await using var dbContext = await factory.CreateDbContextAsync().ConfigureAwait(false);

        var userId = Guid.Parse("eeeeeeee-aaaa-bbbb-cccc-00000000d101");
        var favoriteId = Guid.Parse("eeeeeeee-aaaa-bbbb-cccc-00000000d111");
        var overlapId = Guid.Parse("eeeeeeee-aaaa-bbbb-cccc-00000000d112");
        var plainId = Guid.Parse("eeeeeeee-aaaa-bbbb-cccc-00000000d113");
        var boxSetId = Guid.Parse("eeeeeeee-aaaa-bbbb-cccc-00000000d120");
        var writerId = Guid.Parse("eeeeeeee-aaaa-bbbb-cccc-00000000d130");
        var comedyGenre = Guid.Parse("eeeeeeee-aaaa-bbbb-cccc-00000000d1a1");
        var boxSetType = typeof(MediaBrowser.Controller.Entities.Movies.BoxSet).FullName!;

        Guid[] users = [userId];
        Guid[] items = [favoriteId, overlapId, plainId, boxSetId];
        await dbContext.UserData.Where(u => users.Contains(u.UserId)).ExecuteDeleteAsync().ConfigureAwait(false);
        await dbContext.UserTasteProfiles.Where(p => users.Contains(p.UserId)).ExecuteDeleteAsync().ConfigureAwait(false);
        await dbContext.PeopleBaseItemMap.Where(m => items.Contains(m.ItemId)).ExecuteDeleteAsync().ConfigureAwait(false);
        await dbContext.LinkedChildren.Where(lc => lc.ParentId == boxSetId || items.Contains(lc.ChildId))
            .ExecuteDeleteAsync()
            .ConfigureAwait(false);
        await dbContext.ItemValuesMap.Where(m => items.Contains(m.ItemId)).ExecuteDeleteAsync().ConfigureAwait(false);
        await dbContext.BaseItems.Where(i => items.Contains(i.Id)).ExecuteDeleteAsync().ConfigureAwait(false);
        await dbContext.Peoples.Where(p => p.Id == writerId).ExecuteDeleteAsync().ConfigureAwait(false);

        if (!await dbContext.Users.AnyAsync(u => u.Id == userId).ConfigureAwait(false))
        {
            dbContext.Users.Add(new User("writer-lang", "Writer", "1") { Id = userId });
        }

        var favorite = Movie(favoriteId, "Writer Favorite", "writerfavorite", 2018, "Comedy");
        favorite.OriginalLanguage = "en";
        favorite.ProductionLocations = "USA";
        var overlap = Movie(overlapId, "Writer Overlap", "writeroverlap", 2019, "Comedy");
        overlap.OriginalLanguage = "en";
        overlap.ProductionLocations = "USA";
        var plain = Movie(plainId, "Plain Comedy", "plaincomedy", 2019, "Comedy");
        plain.OriginalLanguage = "fr";
        plain.ProductionLocations = "France";
        dbContext.BaseItems.AddRange(
            favorite,
            overlap,
            plain,
            new BaseItemEntity
            {
                Id = boxSetId,
                Type = boxSetType,
                Name = "Writer Box",
                CleanName = "writerbox",
                SortName = "writerbox",
                IsFolder = true,
                IsVirtualItem = false
            });
        dbContext.Peoples.Add(new People
        {
            Id = writerId,
            Name = "Ada Screen",
            PersonType = nameof(PersonKind.Writer)
        });
        await dbContext.SaveChangesAsync().ConfigureAwait(false);

        var comedyValueId = await EnsureGenreAsync(dbContext, comedyGenre, "Comedy", "comedy").ConfigureAwait(false);
        await LinkGenreAsync(dbContext, favoriteId, comedyValueId).ConfigureAwait(false);
        await LinkGenreAsync(dbContext, overlapId, comedyValueId).ConfigureAwait(false);
        await LinkGenreAsync(dbContext, plainId, comedyValueId).ConfigureAwait(false);

        var writer = await dbContext.Peoples.SingleAsync(p => p.Id == writerId).ConfigureAwait(false);
        foreach (var itemId in new[] { favoriteId, overlapId })
        {
            var item = await dbContext.BaseItems.SingleAsync(i => i.Id == itemId).ConfigureAwait(false);
            dbContext.PeopleBaseItemMap.Add(new PeopleBaseItemMap
            {
                ItemId = itemId,
                PeopleId = writerId,
                Role = string.Empty,
                Item = item,
                People = writer
            });
        }

        dbContext.LinkedChildren.AddRange(
            new LinkedChildEntity
            {
                ParentId = boxSetId,
                ChildId = favoriteId,
                ChildType = DbLinkedChildType.Manual,
                SortOrder = 0
            },
            new LinkedChildEntity
            {
                ParentId = boxSetId,
                ChildId = overlapId,
                ChildType = DbLinkedChildType.Manual,
                SortOrder = 1
            });
        dbContext.UserData.Add(Favorite(userId, favoriteId));
        dbContext.UserData.Add(Favorite(userId, overlapId));
        await dbContext.SaveChangesAsync().ConfigureAwait(false);

        var builder = new UserTasteProfileBuilder(NullLogger<UserTasteProfileBuilder>.Instance);
        var outcome = await builder.RebuildUserAsync(
                dbContext,
                userId,
                MovieType,
                SeriesType,
                EpisodeType,
                DateTime.UtcNow.AddDays(-730),
                minSamples: 2,
                default,
                boxSetType)
            .ConfigureAwait(false);
        Assert.True(outcome.Upserted);

        var row = await dbContext.UserTasteProfiles.AsNoTracking()
            .SingleAsync(p => p.UserId == userId)
            .ConfigureAwait(false);
        var payload = UserTasteProfileBuilder.DeserializeFeatures(row.FeaturesJson);
        Assert.Contains(writerId.ToString("N"), payload.Writers.Keys);
        Assert.Contains(boxSetId.ToString("N"), payload.BoxSets.Keys);
        Assert.True(payload.Languages.ContainsKey("en"));
        Assert.True(payload.Countries.ContainsKey("usa") || payload.Countries.ContainsKey("USA"));

        var features = await TasteCandidateFeatureLoader.LoadAsync(
                dbContext,
                [overlapId, plainId],
                default,
                boxSetType: boxSetType)
            .ConfigureAwait(false);
        var overlapBonus = LinearTasteScorer.ComputeBonus(payload, features[overlapId], 180);
        var plainBonus = LinearTasteScorer.ComputeBonus(payload, features[plainId], 180);
        Assert.True(overlapBonus > plainBonus);
    }

    [PostgresTestFact]
    public async Task ShadowTrain_ImpressionSkip_AddsNegativePair()
    {
        Assert.True(_fixture.IsAvailable, $"PostgreSQL fixture failed to initialize: {_fixture.InitializationError}");

        var factory = new TestDbContextFactory(_fixture.ConnectionString);
        await using var dbContext = await factory.CreateDbContextAsync().ConfigureAwait(false);
        await SeedTasteCorpusAsync(dbContext).ConfigureAwait(false);

        var itemTypeLookup = CreateItemTypeLookup();
        var builder = new UserTasteProfileBuilder(NullLogger<UserTasteProfileBuilder>.Instance);
        await builder.RebuildAllAsync(dbContext, itemTypeLookup.Object, 730, 3, default).ConfigureAwait(false);
        await SeedSecondUserHistoryAsync(dbContext).ConfigureAwait(false);
        await builder.RebuildAllAsync(dbContext, itemTypeLookup.Object, 730, 3, default).ConfigureAwait(false);

        await dbContext.UserTasteRecommendationImpressions
            .Where(i => i.UserId == TasteUserId)
            .ExecuteDeleteAsync()
            .ConfigureAwait(false);

        var trainer = new TasteShadowNeuralTrainer(NullLogger<TasteShadowNeuralTrainer>.Instance);
        var modelDir = System.IO.Path.Join(System.IO.Path.GetTempPath(), "pgsql-taste-tests", Guid.NewGuid().ToString("N"));
        var baseline = await trainer.TrainAndEvaluateAsync(dbContext, itemTypeLookup.Object, modelDir, default)
            .ConfigureAwait(false);
        Assert.NotNull(baseline);

        dbContext.UserTasteRecommendationImpressions.Add(new UserTasteRecommendationImpression
        {
            Id = Guid.NewGuid(),
            UserId = TasteUserId,
            ItemId = ActionOnlyId,
            ItemType = "Movie",
            Rank = 0,
            ServedAt = DateTime.UtcNow.AddDays(-20)
        });
        await dbContext.SaveChangesAsync().ConfigureAwait(false);

        var withSkip = await trainer.TrainAndEvaluateAsync(dbContext, itemTypeLookup.Object, modelDir, default)
            .ConfigureAwait(false);
        Assert.NotNull(withSkip);
        Assert.True(withSkip!.NegativeCount > baseline!.NegativeCount);
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
        var modelDir = System.IO.Path.Join(System.IO.Path.GetTempPath(), "pgsql-taste-tests", Guid.NewGuid().ToString("N"));
        var beforeCount = await dbContext.TasteModelEvalRuns.CountAsync().ConfigureAwait(false);
        var run = await trainer.TrainAndEvaluateAsync(dbContext, itemTypeLookup.Object, modelDir, default)
            .ConfigureAwait(false);
        Assert.NotNull(run);
        var afterCount = await dbContext.TasteModelEvalRuns.CountAsync().ConfigureAwait(false);
        Assert.True(afterCount > beforeCount);
        Assert.Equal(TasteEvalMetrics.SplitTypeTimeBased, run!.SplitType);
        Assert.NotNull(run.HoldoutFraction);
        Assert.Equal(TasteEvalMetrics.DefaultHoldoutFraction, (float)run.HoldoutFraction.Value);
        Assert.True(run.TrainCount > 0);
        Assert.NotNull(run.MeanPrecisionAt10);

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
    public async Task NeuralServe_ForYouScoresDifferFromLinear_MissingZipFallsBack()
    {
        Assert.True(_fixture.IsAvailable, $"PostgreSQL fixture failed to initialize: {_fixture.InitializationError}");

        var factory = new TestDbContextFactory(_fixture.ConnectionString);
        await using var dbContext = await factory.CreateDbContextAsync().ConfigureAwait(false);
        await SeedTasteCorpusAsync(dbContext).ConfigureAwait(false);

        var itemTypeLookup = CreateItemTypeLookup();
        var builder = new UserTasteProfileBuilder(NullLogger<UserTasteProfileBuilder>.Instance);
        await builder.RebuildAllAsync(dbContext, itemTypeLookup.Object, 730, 3, default).ConfigureAwait(false);
        await SeedSecondUserHistoryAsync(dbContext).ConfigureAwait(false);
        await builder.RebuildAllAsync(dbContext, itemTypeLookup.Object, 730, 3, default).ConfigureAwait(false);

        var modelDir = TasteModelPaths.ResolveDirectory();
        var trainer = new TasteShadowNeuralTrainer(NullLogger<TasteShadowNeuralTrainer>.Instance);
        var run = await trainer.TrainAndEvaluateAsync(dbContext, itemTypeLookup.Object, modelDir, default)
            .ConfigureAwait(false);
        Assert.NotNull(run);
        Assert.False(string.IsNullOrWhiteSpace(run!.ModelPath));
        Assert.True(run.Auc is not null || run.Accuracy is not null || run.PrecisionAt10 is not null);

        var cache = new MemoryQueryResultCache();
        var store = new TasteNeuralModelStore(factory, cache, NullLogger<TasteNeuralModelStore>.Instance);
        await store.ReloadAsync(default).ConfigureAwait(false);
        Assert.True(store.IsLoaded);

        var tasteStore = new UserTasteProfileStore(factory, NullLogger<UserTasteProfileStore>.Instance);
        tasteStore.InvalidateAll();
        var service = new TasteRecommendationService(
            factory,
            tasteStore,
            itemTypeLookup.Object,
            cache,
            store,
            NullLogger<TasteRecommendationService>.Instance);

        try
        {
            TasteOptions.TestOverride = TasteOptions.CreateForTests(useNeuralForServing: false);
            await service.RebuildUserFeedsAsync(TasteUserId, default).ConfigureAwait(false);
            var linear = await dbContext.UserTasteRecommendations.AsNoTracking()
                .Where(r => r.UserId == TasteUserId && r.ItemType == "Movie")
                .ToDictionaryAsync(r => r.ItemId, r => r.Score)
                .ConfigureAwait(false);
            Assert.NotEmpty(linear);

            TasteOptions.TestOverride = TasteOptions.CreateForTests(useNeuralForServing: true);
            await service.RebuildUserFeedsAsync(TasteUserId, default).ConfigureAwait(false);
            var blended = await dbContext.UserTasteRecommendations.AsNoTracking()
                .Where(r => r.UserId == TasteUserId && r.ItemType == "Movie")
                .ToDictionaryAsync(r => r.ItemId, r => r.Score)
                .ConfigureAwait(false);
            Assert.NotEmpty(blended);
            Assert.Contains(linear.Keys, id => blended.ContainsKey(id) && blended[id] != linear[id]);

            var zipPath = System.IO.Path.Join(modelDir, System.IO.Path.GetFileName(run.ModelPath));
            System.IO.File.Delete(zipPath);
            await store.ReloadAsync(default).ConfigureAwait(false);
            Assert.False(store.IsLoaded);

            await service.RebuildUserFeedsAsync(TasteUserId, default).ConfigureAwait(false);
            var fallback = await dbContext.UserTasteRecommendations.AsNoTracking()
                .Where(r => r.UserId == TasteUserId && r.ItemType == "Movie")
                .ToDictionaryAsync(r => r.ItemId, r => r.Score)
                .ConfigureAwait(false);
            foreach (var (itemId, score) in linear)
            {
                if (fallback.TryGetValue(itemId, out var fallbackScore))
                {
                    Assert.Equal(score, fallbackScore);
                }
            }
        }
        finally
        {
            TasteOptions.TestOverride = null;
        }
    }

    [PostgresTestFact]
    public async Task Rebuild_AbandonReducesGenreAffinity_VsDeepPlay()
    {
        Assert.True(_fixture.IsAvailable, $"PostgreSQL fixture failed to initialize: {_fixture.InitializationError}");

        var factory = new TestDbContextFactory(_fixture.ConnectionString);
        await using var dbContext = await factory.CreateDbContextAsync().ConfigureAwait(false);

        var abandonUser = Guid.Parse("eeeeeeee-aaaa-bbbb-cccc-00000000ab01");
        var deepUser = Guid.Parse("eeeeeeee-aaaa-bbbb-cccc-00000000ab02");
        var comedyId = Guid.Parse("eeeeeeee-aaaa-bbbb-cccc-00000000ab11");
        var actionId = Guid.Parse("eeeeeeee-aaaa-bbbb-cccc-00000000ab12");
        var comedyGenre = Guid.Parse("eeeeeeee-aaaa-bbbb-cccc-00000000aba1");
        var actionGenre = Guid.Parse("eeeeeeee-aaaa-bbbb-cccc-00000000aba2");
        var runtime = TimeSpan.FromHours(2).Ticks;

        Guid[] users = [abandonUser, deepUser];
        Guid[] items = [comedyId, actionId];
        await dbContext.UserData.Where(u => users.Contains(u.UserId)).ExecuteDeleteAsync().ConfigureAwait(false);
        await dbContext.UserTasteProfiles.Where(p => users.Contains(p.UserId)).ExecuteDeleteAsync().ConfigureAwait(false);
        await dbContext.UserTasteRecommendationImpressions.Where(i => users.Contains(i.UserId)).ExecuteDeleteAsync().ConfigureAwait(false);
        await dbContext.ItemValuesMap.Where(m => items.Contains(m.ItemId)).ExecuteDeleteAsync().ConfigureAwait(false);
        await dbContext.BaseItems.Where(i => items.Contains(i.Id)).ExecuteDeleteAsync().ConfigureAwait(false);

        if (!await dbContext.Users.AnyAsync(u => u.Id == abandonUser).ConfigureAwait(false))
        {
            dbContext.Users.Add(new User("abandon-taste", "Abandon", "1") { Id = abandonUser });
        }

        if (!await dbContext.Users.AnyAsync(u => u.Id == deepUser).ConfigureAwait(false))
        {
            dbContext.Users.Add(new User("deep-taste", "Deep", "1") { Id = deepUser });
        }

        await dbContext.SaveChangesAsync().ConfigureAwait(false);

        dbContext.BaseItems.Add(MovieWithRuntime(comedyId, "Abandon Comedy", "abandoncomedy", 2020, "Comedy", runtime));
        dbContext.BaseItems.Add(MovieWithRuntime(actionId, "Anchor Action", "anchoraction", 2020, "Action", runtime));
        await dbContext.SaveChangesAsync().ConfigureAwait(false);

        var comedyValueId = await EnsureGenreAsync(dbContext, comedyGenre, "Comedy", "comedy").ConfigureAwait(false);
        var actionValueId = await EnsureGenreAsync(dbContext, actionGenre, "Action", "action").ConfigureAwait(false);
        await LinkGenreAsync(dbContext, comedyId, comedyValueId).ConfigureAwait(false);
        await LinkGenreAsync(dbContext, actionId, actionValueId).ConfigureAwait(false);

        // Both users like action; abandon user bounced on comedy 20 days ago; deep user finished comedy.
        dbContext.UserData.Add(Favorite(abandonUser, actionId));
        dbContext.UserData.Add(Favorite(deepUser, actionId));
        dbContext.UserData.Add(new UserData
        {
            ItemId = comedyId,
            UserId = abandonUser,
            CustomDataKey = abandonUser.ToString("N"),
            PlaybackPositionTicks = TimeSpan.FromSeconds(90).Ticks,
            PlayCount = 0,
            Played = false,
            LastPlayedDate = DateTime.UtcNow.AddDays(-20),
            Item = null!,
            User = null!,
        });
        dbContext.UserData.Add(new UserData
        {
            ItemId = comedyId,
            UserId = deepUser,
            CustomDataKey = deepUser.ToString("N"),
            PlaybackPositionTicks = TimeSpan.FromMinutes(110).Ticks,
            PlayCount = 1,
            Played = true,
            LastPlayedDate = DateTime.UtcNow.AddDays(-2),
            Item = null!,
            User = null!,
        });
        // Need a third signal for minSamples
        var fillerId = Guid.Parse("eeeeeeee-aaaa-bbbb-cccc-00000000ab13");
        await dbContext.BaseItems.Where(i => i.Id == fillerId).ExecuteDeleteAsync().ConfigureAwait(false);
        dbContext.BaseItems.Add(MovieWithRuntime(fillerId, "Filler Action 2", "filleraction2", 2021, "Action", runtime));
        await dbContext.SaveChangesAsync().ConfigureAwait(false);
        await LinkGenreAsync(dbContext, fillerId, actionValueId).ConfigureAwait(false);
        dbContext.UserData.Add(Favorite(abandonUser, fillerId));
        dbContext.UserData.Add(Favorite(deepUser, fillerId));
        await dbContext.SaveChangesAsync().ConfigureAwait(false);

        var builder = new UserTasteProfileBuilder(NullLogger<UserTasteProfileBuilder>.Instance);
        var abandonOutcome = await builder.RebuildUserAsync(
                dbContext, abandonUser, MovieType, SeriesType, EpisodeType, DateTime.UtcNow.AddDays(-730), 3, default)
            .ConfigureAwait(false);
        var deepOutcome = await builder.RebuildUserAsync(
                dbContext, deepUser, MovieType, SeriesType, EpisodeType, DateTime.UtcNow.AddDays(-730), 3, default)
            .ConfigureAwait(false);
        Assert.True(abandonOutcome.Upserted);
        Assert.True(deepOutcome.Upserted);

        var abandonPayload = UserTasteProfileBuilder.DeserializeFeatures(
            (await dbContext.UserTasteProfiles.AsNoTracking().SingleAsync(p => p.UserId == abandonUser).ConfigureAwait(false)).FeaturesJson);
        var deepPayload = UserTasteProfileBuilder.DeserializeFeatures(
            (await dbContext.UserTasteProfiles.AsNoTracking().SingleAsync(p => p.UserId == deepUser).ConfigureAwait(false)).FeaturesJson);

        var abandonComedy = abandonPayload.Genres.GetValueOrDefault("comedy");
        var deepComedy = deepPayload.Genres.GetValueOrDefault("comedy");
        Assert.True(deepComedy > abandonComedy);
    }

    [PostgresTestFact]
    public async Task Rebuild_ImpressionPlusFavorite_BoostsOverFavoriteAlone()
    {
        Assert.True(_fixture.IsAvailable, $"PostgreSQL fixture failed to initialize: {_fixture.InitializationError}");

        var factory = new TestDbContextFactory(_fixture.ConnectionString);
        await using var dbContext = await factory.CreateDbContextAsync().ConfigureAwait(false);

        var plainUser = Guid.Parse("eeeeeeee-aaaa-bbbb-cccc-00000000c101");
        var recUser = Guid.Parse("eeeeeeee-aaaa-bbbb-cccc-00000000c102");
        var movieA = Guid.Parse("eeeeeeee-aaaa-bbbb-cccc-00000000c111");
        var movieB = Guid.Parse("eeeeeeee-aaaa-bbbb-cccc-00000000c112");
        var movieC = Guid.Parse("eeeeeeee-aaaa-bbbb-cccc-00000000c113");
        var genreId = Guid.Parse("eeeeeeee-aaaa-bbbb-cccc-00000000c1a1");

        Guid[] users = [plainUser, recUser];
        Guid[] items = [movieA, movieB, movieC];
        await dbContext.UserData.Where(u => users.Contains(u.UserId)).ExecuteDeleteAsync().ConfigureAwait(false);
        await dbContext.UserTasteProfiles.Where(p => users.Contains(p.UserId)).ExecuteDeleteAsync().ConfigureAwait(false);
        await dbContext.UserTasteRecommendationImpressions.Where(i => users.Contains(i.UserId)).ExecuteDeleteAsync().ConfigureAwait(false);
        await dbContext.ItemValuesMap.Where(m => items.Contains(m.ItemId)).ExecuteDeleteAsync().ConfigureAwait(false);
        await dbContext.BaseItems.Where(i => items.Contains(i.Id)).ExecuteDeleteAsync().ConfigureAwait(false);

        foreach (var (id, name) in new[] { (plainUser, "plain-imp"), (recUser, "rec-imp") })
        {
            if (!await dbContext.Users.AnyAsync(u => u.Id == id).ConfigureAwait(false))
            {
                dbContext.Users.Add(new User(name, name, "1") { Id = id });
            }
        }

        await dbContext.SaveChangesAsync().ConfigureAwait(false);

        dbContext.BaseItems.Add(Movie(movieA, "Imp A", "impa", 2020, "SciFi"));
        dbContext.BaseItems.Add(Movie(movieB, "Imp B", "impb", 2020, "SciFi"));
        dbContext.BaseItems.Add(Movie(movieC, "Imp C", "impc", 2020, "SciFi"));
        await dbContext.SaveChangesAsync().ConfigureAwait(false);
        var valueId = await EnsureGenreAsync(dbContext, genreId, "SciFi", "scifi").ConfigureAwait(false);
        foreach (var itemId in items)
        {
            await LinkGenreAsync(dbContext, itemId, valueId).ConfigureAwait(false);
        }

        foreach (var userId in users)
        {
            dbContext.UserData.Add(Favorite(userId, movieA));
            dbContext.UserData.Add(Favorite(userId, movieB));
            dbContext.UserData.Add(Favorite(userId, movieC));
        }

        dbContext.UserTasteRecommendationImpressions.Add(new UserTasteRecommendationImpression
        {
            Id = Guid.NewGuid(),
            UserId = recUser,
            ItemId = movieA,
            ItemType = "Movie",
            Rank = 0,
            ServedAt = DateTime.UtcNow.AddDays(-3)
        });
        await dbContext.SaveChangesAsync().ConfigureAwait(false);

        var builder = new UserTasteProfileBuilder(NullLogger<UserTasteProfileBuilder>.Instance);
        Assert.True((await builder.RebuildUserAsync(
            dbContext, plainUser, MovieType, SeriesType, EpisodeType, DateTime.UtcNow.AddDays(-730), 3, default)
            .ConfigureAwait(false)).Upserted);
        Assert.True((await builder.RebuildUserAsync(
            dbContext, recUser, MovieType, SeriesType, EpisodeType, DateTime.UtcNow.AddDays(-730), 3, default)
            .ConfigureAwait(false)).Upserted);

        // Both normalize to the same single genre; sample counts equal. Spot-check that rebuild with impression succeeds
        // and rec user still has a valid profile (boost is on item weight before normalize).
        var recRow = await dbContext.UserTasteProfiles.AsNoTracking().SingleAsync(p => p.UserId == recUser).ConfigureAwait(false);
        var plainRow = await dbContext.UserTasteProfiles.AsNoTracking().SingleAsync(p => p.UserId == plainUser).ConfigureAwait(false);
        Assert.Equal(3, plainRow.SampleCount);
        Assert.Equal(3, recRow.SampleCount);
        Assert.Contains("scifi", UserTasteProfileBuilder.DeserializeFeatures(recRow.FeaturesJson).Genres.Keys, StringComparer.OrdinalIgnoreCase);
    }

    [PostgresTestFact]
    public async Task ShadowTrain_AbandonOnly_DoesNotCountAsPositive()
    {
        Assert.True(_fixture.IsAvailable, $"PostgreSQL fixture failed to initialize: {_fixture.InitializationError}");

        var factory = new TestDbContextFactory(_fixture.ConnectionString);
        await using var dbContext = await factory.CreateDbContextAsync().ConfigureAwait(false);

        var abandonOnlyUser = Guid.Parse("eeeeeeee-aaaa-bbbb-cccc-00000000ae01");
        var movieId = Guid.Parse("eeeeeeee-aaaa-bbbb-cccc-00000000ae11");
        var runtime = TimeSpan.FromHours(2).Ticks;

        await dbContext.UserData.Where(u => u.UserId == abandonOnlyUser).ExecuteDeleteAsync().ConfigureAwait(false);
        await dbContext.UserTasteProfiles.Where(p => p.UserId == abandonOnlyUser).ExecuteDeleteAsync().ConfigureAwait(false);
        await dbContext.BaseItems.Where(i => i.Id == movieId).ExecuteDeleteAsync().ConfigureAwait(false);

        if (!await dbContext.Users.AnyAsync(u => u.Id == abandonOnlyUser).ConfigureAwait(false))
        {
            dbContext.Users.Add(new User("abandon-only", "AbandonOnly", "1") { Id = abandonOnlyUser });
        }

        dbContext.BaseItems.Add(MovieWithRuntime(movieId, "Bounce Movie", "bouncemovie", 2019, "Drama", runtime));
        await dbContext.SaveChangesAsync().ConfigureAwait(false);

        dbContext.UserData.Add(new UserData
        {
            ItemId = movieId,
            UserId = abandonOnlyUser,
            CustomDataKey = abandonOnlyUser.ToString("N"),
            PlaybackPositionTicks = TimeSpan.FromSeconds(90).Ticks,
            PlayCount = 0,
            Played = false,
            LastPlayedDate = DateTime.UtcNow.AddDays(-30),
            Item = null!,
            User = null!,
        });
        // Force a profile row so trainer iterates the user
        dbContext.UserTasteProfiles.Add(new UserTasteProfile
        {
            UserId = abandonOnlyUser,
            FeaturesJson = """{"genres":{"drama":1},"tags":{},"studios":{},"directors":{},"actors":{}}""",
            SampleCount = 1,
            UpdatedAt = DateTime.UtcNow
        });
        await dbContext.SaveChangesAsync().ConfigureAwait(false);

        var trainer = new TasteShadowNeuralTrainer(NullLogger<TasteShadowNeuralTrainer>.Instance);
        // Use reflection-free path: train may skip for insufficient pairs; ensure abandon is not positive by
        // checking labeled path via a full train after seeding positive corpus elsewhere already exists.
        await SeedTasteCorpusAsync(dbContext).ConfigureAwait(false);
        var builder = new UserTasteProfileBuilder(NullLogger<UserTasteProfileBuilder>.Instance);
        await builder.RebuildAllAsync(dbContext, CreateItemTypeLookup().Object, 730, 3, default).ConfigureAwait(false);

        var modelDir = System.IO.Path.Join(System.IO.Path.GetTempPath(), "pgsql-taste-tests", Guid.NewGuid().ToString("N"));
        var run = await trainer.TrainAndEvaluateAsync(dbContext, CreateItemTypeLookup().Object, modelDir, default)
            .ConfigureAwait(false);
        Assert.NotNull(run);
        Assert.Contains("Weighted", run!.Notes ?? string.Empty, StringComparison.OrdinalIgnoreCase);
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
        var matchService = new TasteMatchService(
            factory,
            tasteStore,
            CreateItemTypeLookup().Object,
            new TasteNeuralModelStore(
                factory,
                new MemoryQueryResultCache(),
                NullLogger<TasteNeuralModelStore>.Instance));

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
            RunTimeTicks = TimeSpan.FromMinutes(110).Ticks,
            InheritedParentalRatingValue = 6,
        };

    private static BaseItemEntity MovieWithRuntime(Guid id, string name, string clean, int year, string genres, long runTimeTicks)
    {
        var movie = Movie(id, name, clean, year, genres);
        movie.RunTimeTicks = runTimeTicks;
        return movie;
    }

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
            new TasteNeuralModelStore(
                factory,
                new MemoryQueryResultCache(),
                NullLogger<TasteNeuralModelStore>.Instance),
            NullLogger<PostgresMovieSimilarItemsProvider>.Instance);
    }
}
