using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.Pgsql.Query;
using Jellyfin.Plugin.Pgsql.Taste;
using Jellyfin.Plugin.Pgsql.Tests.Infrastructure;
using MediaBrowser.Controller.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using Xunit;

namespace Jellyfin.Plugin.Pgsql.Tests.Taste;

[Collection(PostgresCollection.Name)]
public sealed class TasteRecommendationServiceTests
{
    private static readonly Guid TasteUserId = Guid.Parse("ffffffff-aaaa-bbbb-cccc-000000000001");
    private static readonly Guid ComedyFavorite1Id = Guid.Parse("ffffffff-aaaa-bbbb-cccc-000000000011");
    private static readonly Guid ComedyFavorite2Id = Guid.Parse("ffffffff-aaaa-bbbb-cccc-000000000012");
    private static readonly Guid ComedyFavorite3Id = Guid.Parse("ffffffff-aaaa-bbbb-cccc-000000000013");
    private static readonly Guid UnplayedComedyId = Guid.Parse("ffffffff-aaaa-bbbb-cccc-000000000014");
    private static readonly Guid UnplayedActionComedyId = Guid.Parse("ffffffff-aaaa-bbbb-cccc-000000000015");
    private static readonly Guid UnplayedActionId = Guid.Parse("ffffffff-aaaa-bbbb-cccc-000000000016");
    private static readonly Guid PlayedComedyId = Guid.Parse("ffffffff-aaaa-bbbb-cccc-000000000017");
    private static readonly Guid UnplayedComedySeriesId = Guid.Parse("ffffffff-aaaa-bbbb-cccc-000000000021");
    private static readonly Guid PlayedComedySeriesId = Guid.Parse("ffffffff-aaaa-bbbb-cccc-000000000022");
    private static readonly Guid ActionGenreId = Guid.Parse("ffffffff-aaaa-bbbb-cccc-0000000000a1");
    private static readonly Guid ComedyGenreId = Guid.Parse("ffffffff-aaaa-bbbb-cccc-0000000000a2");

    private static readonly string MovieType = typeof(MediaBrowser.Controller.Entities.Movies.Movie).FullName!;
    private static readonly string SeriesType = typeof(MediaBrowser.Controller.Entities.TV.Series).FullName!;
    private static readonly string EpisodeType = typeof(MediaBrowser.Controller.Entities.TV.Episode).FullName!;

    private readonly PostgresDatabaseFixture _fixture;

    public TasteRecommendationServiceTests(PostgresDatabaseFixture fixture)
    {
        _fixture = fixture;
    }

    [PostgresTestFact]
    public async Task ColdStart_NoProfile_ServeEmpty()
    {
        Assert.True(_fixture.IsAvailable, $"PostgreSQL fixture failed to initialize: {_fixture.InitializationError}");

        var factory = new TestDbContextFactory(_fixture.ConnectionString);
        await using var dbContext = await factory.CreateDbContextAsync().ConfigureAwait(false);
        await SeedCorpusAsync(dbContext).ConfigureAwait(false);

        var unknownUser = Guid.Parse("ffffffff-aaaa-bbbb-cccc-000000009999");
        var service = CreateService(factory, new FakeQueryResultCache());

        var items = await service.GetRecommendationsAsync(unknownUser, BaseItemKind.Movie, 24, default)
            .ConfigureAwait(false);

        Assert.Empty(items);
    }

    [PostgresTestFact]
    public async Task MaterializeThenServe_ReturnsStoredOrder_ExcludesPlayed()
    {
        Assert.True(_fixture.IsAvailable, $"PostgreSQL fixture failed to initialize: {_fixture.InitializationError}");

        var factory = new TestDbContextFactory(_fixture.ConnectionString);
        await using var dbContext = await factory.CreateDbContextAsync().ConfigureAwait(false);
        await SeedCorpusAsync(dbContext).ConfigureAwait(false);
        await RebuildProfileAsync(dbContext).ConfigureAwait(false);

        var cache = new FakeQueryResultCache();
        var service = CreateService(factory, cache);
        await service.RebuildUserFeedsAsync(TasteUserId, default).ConfigureAwait(false);

        var items = await service.GetRecommendationsAsync(TasteUserId, BaseItemKind.Movie, 24, default)
            .ConfigureAwait(false);

        Assert.NotEmpty(items);
        Assert.DoesNotContain(items, i => i.ItemId == PlayedComedyId);
        Assert.DoesNotContain(items, i => i.ItemId == ComedyFavorite1Id);
        Assert.Contains(items, i => i.ItemId == UnplayedComedyId || i.ItemId == UnplayedActionComedyId);
        Assert.True(items.SequenceEqual(items.OrderByDescending(i => i.Score).ThenBy(i => i.ItemId)));
    }

    [PostgresTestFact]
    public async Task Serve_FiltersPlayedAfterMaterialize_EvenOnCacheHit()
    {
        Assert.True(_fixture.IsAvailable, $"PostgreSQL fixture failed to initialize: {_fixture.InitializationError}");

        var factory = new TestDbContextFactory(_fixture.ConnectionString);
        await using var dbContext = await factory.CreateDbContextAsync().ConfigureAwait(false);
        await SeedCorpusAsync(dbContext).ConfigureAwait(false);
        await RebuildProfileAsync(dbContext).ConfigureAwait(false);

        var cache = new FakeQueryResultCache();
        var service = CreateService(factory, cache);
        await service.RebuildUserFeedsAsync(TasteUserId, default).ConfigureAwait(false);

        var before = await service.GetRecommendationsAsync(TasteUserId, BaseItemKind.Movie, 24, default)
            .ConfigureAwait(false);
        Assert.Contains(before, i => i.ItemId == UnplayedComedyId);

        // Populate cache
        Assert.True(cache.TryGetPayload(TasteRecommendationService.CacheKey(TasteUserId, BaseItemKind.Movie), out _));

        dbContext.UserData.Add(Played(TasteUserId, UnplayedComedyId));
        await dbContext.SaveChangesAsync().ConfigureAwait(false);

        var after = await service.GetRecommendationsAsync(TasteUserId, BaseItemKind.Movie, 24, default)
            .ConfigureAwait(false);
        Assert.DoesNotContain(after, i => i.ItemId == UnplayedComedyId);
    }

    [PostgresTestFact]
    public async Task Rebuild_InvalidatesCache()
    {
        Assert.True(_fixture.IsAvailable, $"PostgreSQL fixture failed to initialize: {_fixture.InitializationError}");

        var factory = new TestDbContextFactory(_fixture.ConnectionString);
        await using var dbContext = await factory.CreateDbContextAsync().ConfigureAwait(false);
        await SeedCorpusAsync(dbContext).ConfigureAwait(false);
        await RebuildProfileAsync(dbContext).ConfigureAwait(false);

        var cache = new FakeQueryResultCache();
        var service = CreateService(factory, cache);
        await service.RebuildUserFeedsAsync(TasteUserId, default).ConfigureAwait(false);
        _ = await service.GetRecommendationsAsync(TasteUserId, BaseItemKind.Movie, 24, default).ConfigureAwait(false);

        var key = TasteRecommendationService.CacheKey(TasteUserId, BaseItemKind.Movie);
        Assert.True(cache.TryGetPayload(key, out var first));

        await service.RebuildUserFeedsAsync(TasteUserId, default).ConfigureAwait(false);
        Assert.False(cache.TryGetPayload(key, out _));

        _ = await service.GetRecommendationsAsync(TasteUserId, BaseItemKind.Movie, 24, default).ConfigureAwait(false);
        Assert.True(cache.TryGetPayload(key, out var second));
        Assert.NotEmpty(first);
        Assert.NotEmpty(second);
    }

    [PostgresTestFact]
    public async Task Materialize_Series_ExcludesPlayed()
    {
        Assert.True(_fixture.IsAvailable, $"PostgreSQL fixture failed to initialize: {_fixture.InitializationError}");

        var factory = new TestDbContextFactory(_fixture.ConnectionString);
        await using var dbContext = await factory.CreateDbContextAsync().ConfigureAwait(false);
        await SeedCorpusAsync(dbContext).ConfigureAwait(false);
        await RebuildProfileAsync(dbContext).ConfigureAwait(false);

        var service = CreateService(factory, new FakeQueryResultCache());
        await service.RebuildUserFeedsAsync(TasteUserId, default).ConfigureAwait(false);

        var items = await service.GetRecommendationsAsync(TasteUserId, BaseItemKind.Series, 24, default)
            .ConfigureAwait(false);

        Assert.Contains(items, i => i.ItemId == UnplayedComedySeriesId);
        Assert.DoesNotContain(items, i => i.ItemId == PlayedComedySeriesId);
    }

    [PostgresTestFact]
    public async Task Serve_RecordsImpressions_AndDedupesWithin24Hours()
    {
        Assert.True(_fixture.IsAvailable, $"PostgreSQL fixture failed to initialize: {_fixture.InitializationError}");

        var factory = new TestDbContextFactory(_fixture.ConnectionString);
        await using var dbContext = await factory.CreateDbContextAsync().ConfigureAwait(false);
        await SeedCorpusAsync(dbContext).ConfigureAwait(false);
        await RebuildProfileAsync(dbContext).ConfigureAwait(false);

        await dbContext.UserTasteRecommendationImpressions
            .Where(i => i.UserId == TasteUserId)
            .ExecuteDeleteAsync()
            .ConfigureAwait(false);

        var service = CreateService(factory, new FakeQueryResultCache());
        await service.RebuildUserFeedsAsync(TasteUserId, default).ConfigureAwait(false);

        var first = await service.GetRecommendationsAsync(TasteUserId, BaseItemKind.Movie, 24, default)
            .ConfigureAwait(false);
        Assert.NotEmpty(first);

        var afterFirst = await dbContext.UserTasteRecommendationImpressions.AsNoTracking()
            .Where(i => i.UserId == TasteUserId)
            .CountAsync()
            .ConfigureAwait(false);
        Assert.Equal(first.Count, afterFirst);

        var second = await service.GetRecommendationsAsync(TasteUserId, BaseItemKind.Movie, 24, default)
            .ConfigureAwait(false);
        Assert.Equal(first.Select(i => i.ItemId), second.Select(i => i.ItemId));

        var afterSecond = await dbContext.UserTasteRecommendationImpressions.AsNoTracking()
            .Where(i => i.UserId == TasteUserId)
            .CountAsync()
            .ConfigureAwait(false);
        Assert.Equal(afterFirst, afterSecond);
    }

    [Fact]
    public void SampleFeed_SmallPool_IsDeterministicTopN()
    {
        var scored = Enumerable.Range(1, 5)
            .Select(i => (Id: Guid.Parse($"00000000-0000-0000-0000-{i:D12}"), Score: i * 10))
            .ToList();

        var a = TasteRecommendationService.SampleFeed(scored, limit: 24, poolSize: 200, new Random(1));
        var b = TasteRecommendationService.SampleFeed(scored, limit: 24, poolSize: 200, new Random(99));
        Assert.Equal(5, a.Count);
        Assert.Equal(a.Select(x => x.ItemId), b.Select(x => x.ItemId));
        Assert.Equal(50, a[0].Score);
    }

    [Fact]
    public void SampleFeed_LargePool_SameSeedSameSample_DifferentSeedCanDiffer()
    {
        var scored = Enumerable.Range(1, 80)
            .Select(i => (Id: Guid.Parse($"00000000-0000-0000-0000-{i:D12}"), Score: 10 + (i % 17)))
            .ToList();

        var seedA = TasteRecommendationService.CreateSeed(TasteUserId, BaseItemKind.Movie, new DateOnly(2026, 7, 17));
        var seedB = TasteRecommendationService.CreateSeed(TasteUserId, BaseItemKind.Movie, new DateOnly(2026, 7, 18));
        var sampleA1 = TasteRecommendationService.SampleFeed(scored, 24, 200, new Random(seedA));
        var sampleA2 = TasteRecommendationService.SampleFeed(scored, 24, 200, new Random(seedA));
        var sampleB = TasteRecommendationService.SampleFeed(scored, 24, 200, new Random(seedB));

        Assert.Equal(24, sampleA1.Count);
        Assert.Equal(sampleA1.Select(x => x.ItemId), sampleA2.Select(x => x.ItemId));
        Assert.NotEqual(sampleA1.Select(x => x.ItemId), sampleB.Select(x => x.ItemId));
    }

    [Fact]
    public void Payload_RoundTrips()
    {
        var items = new List<TasteMatchItem>
        {
            new(Guid.Parse("00000000-0000-0000-0000-000000000001"), "high", 120),
            new(Guid.Parse("00000000-0000-0000-0000-000000000002"), "mid", 80),
            new(Guid.Parse("00000000-0000-0000-0000-000000000003"), string.Empty, 40),
        };

        var bytes = TasteRecommendationPayload.Serialize(items);
        Assert.True(TasteRecommendationPayload.TryDeserialize(bytes, out var restored));
        Assert.Equal(3, restored.Count);
        Assert.Equal(items[0].ItemId, restored[0].ItemId);
        Assert.Equal("high", restored[0].Tier);
        Assert.Equal(120, restored[0].Score);
        Assert.Equal("mid", restored[1].Tier);
        Assert.Equal(string.Empty, restored[2].Tier);
    }

    [Fact]
    public void Constants_MatchPlanCaps()
    {
        Assert.Equal(24, TasteRecommendationService.DefaultLimit);
        Assert.Equal(48, TasteRecommendationService.MaxLimit);
        Assert.Equal(2000, TasteRecommendationService.CandidateCap);
        Assert.Equal(200, TasteRecommendationService.PoolSize);
        Assert.Equal(5, TasteRecommendationService.TopGenreCount);
    }

    private static async Task SeedCorpusAsync(JellyfinDbContext dbContext)
    {
        Guid[] ids =
        [
            ComedyFavorite1Id,
            ComedyFavorite2Id,
            ComedyFavorite3Id,
            UnplayedComedyId,
            UnplayedActionComedyId,
            UnplayedActionId,
            PlayedComedyId,
            UnplayedComedySeriesId,
            PlayedComedySeriesId
        ];

        await dbContext.UserData.Where(u => u.UserId == TasteUserId).ExecuteDeleteAsync().ConfigureAwait(false);
        await dbContext.UserTasteProfiles.Where(p => p.UserId == TasteUserId).ExecuteDeleteAsync().ConfigureAwait(false);
        await dbContext.UserTasteRecommendations.Where(r => r.UserId == TasteUserId).ExecuteDeleteAsync().ConfigureAwait(false);
        await dbContext.ItemValuesMap.Where(m => ids.Contains(m.ItemId)).ExecuteDeleteAsync().ConfigureAwait(false);
        await dbContext.BaseItems.Where(i => ids.Contains(i.Id)).ExecuteDeleteAsync().ConfigureAwait(false);

        if (!await dbContext.Users.AnyAsync(u => u.Id == TasteUserId).ConfigureAwait(false))
        {
            dbContext.Users.Add(new User("taste-rec-user", "default", "default") { Id = TasteUserId });
        }

        dbContext.BaseItems.AddRange(
            Movie(ComedyFavorite1Id, "Comedy One", "comedy one", 2016, "Comedy"),
            Movie(ComedyFavorite2Id, "Comedy Two", "comedy two", 2017, "Comedy"),
            Movie(ComedyFavorite3Id, "Comedy Three", "comedy three", 2019, "Comedy"),
            Movie(UnplayedComedyId, "Fresh Comedy", "fresh comedy", 2022, "Comedy"),
            Movie(UnplayedActionComedyId, "Action Comedy Mix", "action comedy mix", 2020, "Action|Comedy"),
            Movie(UnplayedActionId, "Straight Action", "straight action", 2021, "Action"),
            Movie(PlayedComedyId, "Watched Comedy", "watched comedy", 2018, "Comedy"),
            Series(UnplayedComedySeriesId, "Fresh Comedy Series", "fresh comedy series", 2020),
            Series(PlayedComedySeriesId, "Watched Comedy Series", "watched comedy series", 2019));
        await dbContext.SaveChangesAsync().ConfigureAwait(false);

        var actionId = await EnsureGenreAsync(dbContext, ActionGenreId, "Action", "action").ConfigureAwait(false);
        var comedyId = await EnsureGenreAsync(dbContext, ComedyGenreId, "Comedy", "comedy").ConfigureAwait(false);

        await LinkGenreAsync(dbContext, ComedyFavorite1Id, comedyId).ConfigureAwait(false);
        await LinkGenreAsync(dbContext, ComedyFavorite2Id, comedyId).ConfigureAwait(false);
        await LinkGenreAsync(dbContext, ComedyFavorite3Id, comedyId).ConfigureAwait(false);
        await LinkGenreAsync(dbContext, UnplayedComedyId, comedyId).ConfigureAwait(false);
        await LinkGenreAsync(dbContext, UnplayedActionComedyId, actionId).ConfigureAwait(false);
        await LinkGenreAsync(dbContext, UnplayedActionComedyId, comedyId).ConfigureAwait(false);
        await LinkGenreAsync(dbContext, UnplayedActionId, actionId).ConfigureAwait(false);
        await LinkGenreAsync(dbContext, PlayedComedyId, comedyId).ConfigureAwait(false);
        await LinkGenreAsync(dbContext, UnplayedComedySeriesId, comedyId).ConfigureAwait(false);
        await LinkGenreAsync(dbContext, PlayedComedySeriesId, comedyId).ConfigureAwait(false);

        dbContext.UserData.AddRange(
            Favorite(TasteUserId, ComedyFavorite1Id),
            Favorite(TasteUserId, ComedyFavorite2Id),
            Favorite(TasteUserId, ComedyFavorite3Id),
            Played(TasteUserId, PlayedComedyId),
            Played(TasteUserId, PlayedComedySeriesId));
        await dbContext.SaveChangesAsync().ConfigureAwait(false);
    }

    private static async Task RebuildProfileAsync(JellyfinDbContext dbContext)
    {
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
    }

    private static TasteRecommendationService CreateService(
        TestDbContextFactory factory,
        IQueryResultCache cache)
    {
        var tasteStore = new UserTasteProfileStore(factory, NullLogger<UserTasteProfileStore>.Instance);
        tasteStore.InvalidateAll();
        return new TasteRecommendationService(
            factory,
            tasteStore,
            CreateItemTypeLookup().Object,
            cache,
            NullLogger<TasteRecommendationService>.Instance);
    }

    private sealed class FakeQueryResultCache : IQueryResultCache
    {
        private readonly Dictionary<string, byte[]> _payloads = new(StringComparer.Ordinal);
        private readonly Dictionary<string, Guid[]> _ids = new(StringComparer.Ordinal);

        public bool TryGet(string key, out Guid[] ids)
            => _ids.TryGetValue(key, out ids!);

        public void Set(string key, Guid[] ids, TimeSpan timeToLive)
            => _ids[key] = ids;

        public bool TryGetPayload(string key, out byte[] payload)
            => _payloads.TryGetValue(key, out payload!);

        public void SetPayload(string key, byte[] payload, TimeSpan timeToLive)
            => _payloads[key] = payload;

        public void InvalidateAll()
        {
            _payloads.Clear();
            _ids.Clear();
        }

        public void Remove(string key)
        {
            _payloads.Remove(key);
            _ids.Remove(key);
        }
    }

    private static Mock<IItemTypeLookup> CreateItemTypeLookup()
    {
        var itemTypeLookup = new Mock<IItemTypeLookup>();
        itemTypeLookup.SetupGet(l => l.BaseItemKindNames).Returns(new Dictionary<BaseItemKind, string>
        {
            [BaseItemKind.Movie] = MovieType,
            [BaseItemKind.Series] = SeriesType,
            [BaseItemKind.Episode] = EpisodeType,
        });
        return itemTypeLookup;
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
}
