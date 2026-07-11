using System;
using Jellyfin.Database.Implementations;
using Jellyfin.Plugin.Pgsql.PlaybackReportingImport;
using MediaBrowser.Controller;
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
        var coreRepositoryType = CoreItemRepositoryAccessor.FindCoreRepositoryType(serviceCollection);
        if (coreRepositoryType is null)
        {
            // Server layout changed; keep the core repository untouched.
            return;
        }

        serviceCollection.AddSingleton<QueryRuntimeStats>();
        serviceCollection.AddSingleton<IQueryResultCache>(CreateCache);

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

        serviceCollection.AddSingleton<IItemRepository>(sp => new CachingItemRepository(
            (IItemRepository)sp.GetRequiredService(coreRepositoryType),
            sp.GetRequiredService<IQueryResultCache>(),
            sp.GetRequiredService<CachedItemLoader>(),
            sp.GetRequiredService<PgLatestQueryService>(),
            sp.GetRequiredService<QueryRuntimeStats>(),
            sp.GetRequiredService<ILoggerFactory>().CreateLogger<CachingItemRepository>()));

        serviceCollection.AddSingleton<INextUpService>(sp => new CachingNextUpService(
            CoreNextUpServiceAccessor.Create(sp),
            sp.GetRequiredService<CachedItemLoader>(),
            sp.GetRequiredService<ILoggerFactory>().CreateLogger<CachingNextUpService>()));

        serviceCollection.AddSingleton<PlaybackReportingImporter>();
        serviceCollection.AddSingleton<IPlaybackReportingImporter>(sp => sp.GetRequiredService<PlaybackReportingImporter>());
        serviceCollection.AddHostedService<PlaybackReportingMigrationService>();
    }

    private static IQueryResultCache CreateCache(IServiceProvider serviceProvider)
    {
        var options = PgsqlQueryOptions.Current;
        var logger = serviceProvider.GetRequiredService<ILoggerFactory>().CreateLogger<RedisQueryResultCache>();

        if (options.CacheBackend == QueryCacheBackend.Redis)
        {
            if (!string.IsNullOrWhiteSpace(options.RedisConnectionString))
            {
                logger.LogInformation("PostgreSQL plugin query cache using Redis backend");
                return new RedisQueryResultCache(options.RedisConnectionString, logger, serviceProvider.GetRequiredService<QueryRuntimeStats>());
            }

            logger.LogInformation("Redis cache backend selected but no connection string configured; using memory backend");
        }

        return new MemoryQueryResultCache();
    }
}
