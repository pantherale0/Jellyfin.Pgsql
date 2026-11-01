using System;
using System.Text;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.Pgsql.Configuration;
using Jellyfin.Plugin.Pgsql.Query;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Model.Querying;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using Xunit;

namespace Jellyfin.Plugin.Pgsql.Tests.Query;

public sealed class CachingItemRepositoryTests
{
    [Fact]
    public void GetItems_CorruptBrowsePayload_FallsBackAndReplacesPayload()
    {
        var user = new User("browse-cache-test", "auth", "reset");
        var filter = new InternalItemsQuery(user)
        {
            IsResumable = false,
            Limit = 10,
            TopParentIds = [Guid.NewGuid()],
        };
        var item = new MediaBrowser.Controller.Entities.Movies.Movie { Id = Guid.NewGuid() };
        var expectedResult = new QueryResult<BaseItem>(0, 1, [item]);
        var inner = new Mock<IItemRepository>(MockBehavior.Strict);
        inner.Setup(repository => repository.GetItems(filter)).Returns(expectedResult);

        var invalidPayload = Encoding.UTF8.GetBytes("{ invalid json");
        var cache = new RecordingQueryResultCache(invalidPayload);
        var repository = new CachingItemRepository(
            inner.Object,
            cache,
            new MemoryQueryCacheVersionStore(),
            null!,
            null!,
            null!,
            PgsqlQueryOptions.Resolve(new PluginConfiguration
            {
                CacheBackend = "Memory",
                EnableQueryCache = true,
                BrowseCacheTtlSeconds = 60,
            }),
            new QueryRuntimeStats(),
            NullLogger<CachingItemRepository>.Instance);

        var result = repository.GetItems(filter);

        Assert.Same(expectedResult, result);
        Assert.Same(item, Assert.Single(result.Items));
        inner.Verify(repository => repository.GetItems(filter), Times.Once);
        Assert.Equal(1, cache.TryGetPayloadCount);
        Assert.Equal(1, cache.SetPayloadCount);
        Assert.Equal(cache.PayloadLookupKey, cache.PayloadStoredKey);
        Assert.NotNull(cache.StoredPayload);
        Assert.NotEqual(invalidPayload, cache.StoredPayload);

        using var payload = JsonDocument.Parse(cache.StoredPayload!);
        Assert.Equal(1, payload.RootElement.GetProperty("totalRecordCount").GetInt32());
        Assert.Equal(item.Id.ToString(), payload.RootElement.GetProperty("ids")[0].GetString());
    }

    private sealed class RecordingQueryResultCache(byte[] initialPayload) : IQueryResultCache
    {
        public int TryGetPayloadCount { get; private set; }

        public int SetPayloadCount { get; private set; }

        public string? PayloadLookupKey { get; private set; }

        public string? PayloadStoredKey { get; private set; }

        public byte[]? StoredPayload { get; private set; }

        public bool TryGet(string key, out Guid[] ids)
        {
            ids = [];
            return false;
        }

        public void Set(string key, Guid[] ids, TimeSpan timeToLive)
        {
        }

        public bool TryGetPayload(string key, out byte[] payload)
        {
            TryGetPayloadCount++;
            PayloadLookupKey = key;
            payload = initialPayload;
            return true;
        }

        public void SetPayload(string key, byte[] payload, TimeSpan timeToLive)
        {
            SetPayloadCount++;
            PayloadStoredKey = key;
            StoredPayload = payload;
        }

        public void InvalidateAll()
        {
        }

        public void Remove(string key)
        {
        }
    }
}
