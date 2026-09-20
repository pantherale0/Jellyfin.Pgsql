using System;
using Jellyfin.Database.Implementations;
using Jellyfin.Plugin.Pgsql.Admin;
using Jellyfin.Plugin.Pgsql.Admin.EmbyImport;
using Jellyfin.Plugin.Pgsql.Ha;
using Jellyfin.Plugin.Pgsql.PlaybackReportingImport;
using Jellyfin.Plugin.Pgsql.Similar;
using Jellyfin.Plugin.Pgsql.Taste;
using Jellyfin.Plugin.Pgsql.Trailers;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Controller.Plugins;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

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
        serviceCollection.AddSingleton<IYtDlpProcessRunner, YtDlpProcessRunner>();
        serviceCollection.AddSingleton<ITrailerRemuxer, FfmpegTrailerRemuxer>();
        serviceCollection.AddSingleton<YtDlpTrailerService>();

        serviceCollection.AddSingleton<RedisConnectionAccessor>();
        RegisterHa(serviceCollection);

        var coreRepositoryType = CoreItemRepositoryAccessor.FindCoreRepositoryType(serviceCollection);
        if (coreRepositoryType is null)
        {
            // Server layout changed; keep the core repository untouched, but still wire taste feeds.
            serviceCollection.AddSingleton<IQueryResultCache>(_ => new MemoryQueryResultCache());
            serviceCollection.AddSingleton<IQueryCacheVersionStore>(_ => new MemoryQueryCacheVersionStore());
            serviceCollection.AddSingleton<TasteNeuralModelStore>();
            serviceCollection.AddSingleton<TasteRecommendationService>();
            serviceCollection.AddSingleton<PostgresMovieSimilarItemsProvider>();
            serviceCollection.AddSingleton<TasteBecauseYouService>();
            return;
        }

        serviceCollection.AddSingleton<QueryRuntimeStats>();
        serviceCollection.AddSingleton<IQueryCacheVersionStore>(CreateVersionStore);
        serviceCollection.AddSingleton<IQueryResultCache>(CreateCache);
        serviceCollection.AddSingleton<TasteNeuralModelStore>();
        serviceCollection.AddSingleton<TasteRecommendationService>();
        serviceCollection.AddSingleton<PostgresMovieSimilarItemsProvider>();
        serviceCollection.AddSingleton<TasteBecauseYouService>();

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
        var hub = serviceProvider.GetRequiredService<RedisConnectionAccessor>().Hub;

        if (options.CacheBackend == QueryCacheBackend.Redis && hub is not null)
        {
            logger.LogInformation("PostgreSQL plugin query cache versions using shared Redis hub");
            return new RedisQueryCacheVersionStore(hub, logger);
        }

        return new MemoryQueryCacheVersionStore();
    }

    private static IQueryResultCache CreateCache(IServiceProvider serviceProvider)
    {
        var options = PgsqlQueryOptions.Current;
        var logger = serviceProvider.GetRequiredService<ILoggerFactory>().CreateLogger<RedisQueryResultCache>();
        var hub = serviceProvider.GetRequiredService<RedisConnectionAccessor>().Hub;

        if (options.CacheBackend == QueryCacheBackend.Redis)
        {
            if (hub is not null)
            {
                logger.LogInformation("PostgreSQL plugin query cache using Redis backend with memory fallback");
                return new FallbackQueryResultCache(
                    new RedisQueryResultCache(
                        hub,
                        logger,
                        serviceProvider.GetRequiredService<QueryRuntimeStats>()),
                    new MemoryQueryResultCache());
            }

            logger.LogInformation("Redis cache backend selected but Redis hub unavailable; using memory backend");
        }

        return new MemoryQueryResultCache();
    }

    private static void RegisterHa(IServiceCollection serviceCollection)
    {
        if (!HaOptions.Current.Enabled)
        {
            return;
        }

        serviceCollection.AddSingleton<PostgresInstanceLeadership>();
        serviceCollection.AddSingleton<IInstanceLeadership>(sp => sp.GetRequiredService<PostgresInstanceLeadership>());
        serviceCollection.AddHostedService<LeadershipHostedService>();

        serviceCollection.AddSingleton<IPlaybackProgressCache>(sp =>
        {
            var logger = sp.GetRequiredService<ILoggerFactory>().CreateLogger<RedisPlaybackProgressCache>();
            var hub = sp.GetRequiredService<RedisConnectionAccessor>().Hub;
            if (hub is null)
            {
                logger.LogInformation("HA enabled but Redis hub unavailable; continuing without progress overlay");
                return new NoOpPlaybackProgressCache();
            }

            return new RedisPlaybackProgressCache(hub, logger);
        });
    }
}
