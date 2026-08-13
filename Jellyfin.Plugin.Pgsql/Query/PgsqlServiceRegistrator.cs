using System;
using System.IO;
using Jellyfin.Database.Implementations;
using Jellyfin.Plugin.Pgsql.Admin;
using Jellyfin.Plugin.Pgsql.Admin.EmbyImport;
using Jellyfin.Plugin.Pgsql.PlaybackReportingImport;
using Jellyfin.Plugin.Pgsql.Taste;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Plugins;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using StackExchange.Redis;

namespace Jellyfin.Plugin.Pgsql.Query;

/// <summary>
/// Registers the query cache decorator and PostgreSQL query optimisers with the server DI
/// container. Runs after the core registrations, so the <see cref="IItemRepository"/> binding
/// added here takes precedence over the core one while the core repository stays available
/// for delegation.
/// </summary>
public sealed class PgsqlServiceRegistrator : IPluginServiceRegistrator
{
    /// <inheritdoc/>
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        serviceCollection.AddSingleton<UserTasteProfileStore>();
        serviceCollection.AddSingleton<UserTasteProfileBuilder>();
        serviceCollection.AddSingleton<TasteShadowNeuralTrainer>();
        serviceCollection.AddSingleton<TastePersonaGenerator>();
        serviceCollection.AddSingleton<TasteMatchService>();
        serviceCollection.AddSingleton<UserMergeService>();
        serviceCollection.AddSingleton<EmbyImportSessionStore>();
        serviceCollection.AddSingleton<EmbySqliteReader>();
        serviceCollection.AddSingleton<EmbyUserDataMatcher>();
        serviceCollection.AddSingleton<EmbyUserDataImportService>();

        var coreRepositoryType = CoreItemRepositoryAccessor.FindCoreRepositoryType(serviceCollection);
        if (coreRepositoryType is null)
        {
            // Server layout changed; keep the core repository untouched, but still wire taste feeds.
            serviceCollection.AddSingleton<IQueryResultCache>(_ => new MemoryQueryResultCache());
            serviceCollection.AddSingleton<IQueryCacheVersionStore>(_ => new MemoryQueryCacheVersionStore());
            serviceCollection.AddSingleton<TasteNeuralModelStore>();
            serviceCollection.AddSingleton<TasteRecommendationService>();
            return;
        }

        serviceCollection.AddSingleton<QueryRuntimeStats>();
        serviceCollection.AddSingleton<IQueryCacheVersionStore>(CreateVersionStore);
        serviceCollection.AddSingleton<IQueryResultCache>(CreateCache);
        serviceCollection.AddSingleton<TasteNeuralModelStore>();
        serviceCollection.AddSingleton<TasteRecommendationService>();

        serviceCollection.AddSingleton(sp => new CachedItemLoader(
            sp.GetRequiredService<IDbContextFactory<JellyfinDbContext>>(),
            sp.GetRequiredService<IItemQueryHelpers>(),
            sp.GetRequiredService<ILoggerFactory>().CreateLogger<CachedItemLoader>()));

        serviceCollection.AddSingleton(sp => new PgLatestMoviesQuery(sp.GetRequiredService<CachedItemLoader>()));

        serviceCollection.AddSingleton(sp => new PgLatestTvShowsQuery(
            sp.GetRequiredService<IItemQueryHelpers>(),
            sp.GetRequiredService<IItemTypeLookup>()));

        serviceCollection.AddSingleton(sp => new PgLatestMusicQuery(
            sp.GetRequiredService<CachedItemLoader>(),
            sp.GetRequiredService<IItemTypeLookup>()));

        serviceCollection.AddSingleton(sp => new PgLatestQueryService(
            sp.GetRequiredService<IDbContextFactory<JellyfinDbContext>>(),
            sp.GetRequiredService<IItemQueryHelpers>(),
            sp.GetRequiredService<PgLatestMoviesQuery>(),
            sp.GetRequiredService<PgLatestTvShowsQuery>(),
            sp.GetRequiredService<PgLatestMusicQuery>(),
            sp.GetRequiredService<QueryRuntimeStats>(),
            sp.GetRequiredService<ILoggerFactory>().CreateLogger<PgLatestQueryService>()));

        serviceCollection.AddSingleton(sp => new PgNextUpQuery(
            sp.GetRequiredService<IDbContextFactory<JellyfinDbContext>>(),
            sp.GetRequiredService<IItemQueryHelpers>(),
            sp.GetRequiredService<IItemTypeLookup>(),
            sp.GetRequiredService<CachedItemLoader>(),
            sp.GetRequiredService<QueryRuntimeStats>(),
            sp.GetRequiredService<ILoggerFactory>().CreateLogger<PgNextUpQuery>()));

        serviceCollection.AddSingleton<IItemRepository>(sp => new CachingItemRepository(
            (IItemRepository)sp.GetRequiredService(coreRepositoryType),
            sp.GetRequiredService<IQueryResultCache>(),
            sp.GetRequiredService<IQueryCacheVersionStore>(),
            sp.GetRequiredService<CachedItemLoader>(),
            sp.GetRequiredService<PgLatestQueryService>(),
            sp.GetRequiredService<QueryRuntimeStats>(),
            sp.GetRequiredService<ILoggerFactory>().CreateLogger<CachingItemRepository>()));

        serviceCollection.AddSingleton<INextUpService>(sp => new CachingNextUpService(
            CoreNextUpServiceAccessor.Create(sp),
            sp.GetRequiredService<IQueryResultCache>(),
            sp.GetRequiredService<IQueryCacheVersionStore>(),
            sp.GetRequiredService<CachedItemLoader>(),
            sp.GetRequiredService<PgNextUpQuery>(),
            sp.GetRequiredService<QueryRuntimeStats>(),
            sp.GetRequiredService<ILoggerFactory>().CreateLogger<CachingNextUpService>()));

        serviceCollection.AddHostedService<QueryCacheInvalidationService>();

        serviceCollection.AddSingleton<PlaybackReportingImporter>();
        serviceCollection.AddSingleton<IPlaybackReportingImporter>(sp => sp.GetRequiredService<PlaybackReportingImporter>());
        serviceCollection.AddHostedService<PlaybackReportingMigrationService>();
    }

    private static IQueryCacheVersionStore CreateVersionStore(IServiceProvider serviceProvider)
    {
        var options = PgsqlQueryOptions.Current;
        var logger = serviceProvider.GetRequiredService<ILoggerFactory>().CreateLogger<RedisQueryCacheVersionStore>();

        if (options.CacheBackend == QueryCacheBackend.Redis
            && !string.IsNullOrWhiteSpace(options.RedisConnectionString))
        {
            try
            {
                return new RedisQueryCacheVersionStore(options.RedisConnectionString, logger);
            }
            catch (Exception ex) when (ex is RedisException or IOException or TimeoutException or ArgumentException)
            {
                logger.LogWarning(ex, "Failed to initialize Redis query cache versions; using memory versions");
            }
        }

        return new MemoryQueryCacheVersionStore();
    }

    private static IQueryResultCache CreateCache(IServiceProvider serviceProvider)
    {
        var options = PgsqlQueryOptions.Current;
        var logger = serviceProvider.GetRequiredService<ILoggerFactory>().CreateLogger<RedisQueryResultCache>();

        if (options.CacheBackend == QueryCacheBackend.Redis)
        {
            if (!string.IsNullOrWhiteSpace(options.RedisConnectionString))
            {
                try
                {
                    logger.LogInformation("PostgreSQL plugin query cache using Redis backend with memory fallback");
                    return new FallbackQueryResultCache(
                        new RedisQueryResultCache(
                            options.RedisConnectionString,
                            logger,
                            serviceProvider.GetRequiredService<QueryRuntimeStats>()),
                        new MemoryQueryResultCache());
                }
                catch (Exception ex) when (ex is RedisException or IOException or TimeoutException or ArgumentException)
                {
                    // Redis must never take down Jellyfin; degrade to in-process cache.
                    logger.LogWarning(ex, "Failed to initialize Redis query cache; falling back to memory backend");
                    return new MemoryQueryResultCache();
                }
            }

            logger.LogInformation("Redis cache backend selected but no connection string configured; using memory backend");
        }

        return new MemoryQueryResultCache();
    }
}
