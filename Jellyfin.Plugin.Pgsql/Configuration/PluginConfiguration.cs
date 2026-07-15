using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.Pgsql.Configuration;

/// <summary>
/// Plugin configuration for PostgreSQL database provider.
/// </summary>
/// <remarks>
/// Database connection settings are handled via environment variables. The properties here
/// tune the optional query result cache and PostgreSQL-specific query optimisations; each
/// can be overridden by an environment variable (see the plugin configuration page).
/// </remarks>
public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>
    /// Gets or sets a value indicating whether query result caching (Latest/Resume) is enabled.
    /// Overridden by <c>Pgsql_CACHE_ENABLED</c>.
    /// </summary>
    public bool EnableQueryCache { get; set; } = true;

    /// <summary>
    /// Gets or sets the cache backend: <c>Redis</c>, <c>Memory</c> or <c>Off</c>.
    /// Overridden by <c>Pgsql_CACHE_BACKEND</c>.
    /// </summary>
    public string CacheBackend { get; set; } = "Redis";

    /// <summary>
    /// Gets or sets the Redis connection string (StackExchange.Redis format).
    /// Overridden by <c>REDIS_CONNECTION_STRING</c>. When empty, the memory backend is used.
    /// </summary>
    public string RedisConnectionString { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the time-to-live in seconds for cached Latest results.
    /// Overridden by <c>Pgsql_CACHE_LATEST_TTL</c>.
    /// </summary>
    public int LatestCacheTtlSeconds { get; set; } = 120;

    /// <summary>
    /// Gets or sets the time-to-live in seconds for cached Resume results. Zero disables Resume caching.
    /// Overridden by <c>Pgsql_CACHE_RESUME_TTL</c>.
    /// </summary>
    public int ResumeCacheTtlSeconds { get; set; } = 30;

    /// <summary>
    /// Gets or sets the time-to-live in seconds for cached NextUp batch results. Zero disables NextUp caching.
    /// Overridden by <c>Pgsql_CACHE_NEXTUP_TTL</c>.
    /// </summary>
    public int NextUpCacheTtlSeconds { get; set; } = 45;

    /// <summary>
    /// Gets or sets a value indicating whether PostgreSQL-optimised Latest queries are enabled.
    /// Overridden by <c>Pgsql_PG_OPTIMIZE_LATEST</c> (per-type overrides:
    /// <c>Pgsql_PG_OPTIMIZE_MOVIES_LATEST</c>, <c>Pgsql_PG_OPTIMIZE_TV_LATEST</c>, <c>Pgsql_PG_OPTIMIZE_MUSIC_LATEST</c>).
    /// </summary>
    public bool OptimizeLatestQueries { get; set; } = true;

    /// <summary>
    /// Gets or sets a value indicating whether PostgreSQL-optimised NextUp batch queries are enabled.
    /// Overridden by <c>Pgsql_PG_OPTIMIZE_NEXTUP</c>.
    /// </summary>
    public bool OptimizeNextUpQueries { get; set; } = true;

    /// <summary>
    /// Gets or sets a value indicating whether user taste profiles are built and applied to movie suggestions.
    /// Overridden by <c>Pgsql_TASTE_ENABLED</c>.
    /// </summary>
    public bool EnableTasteProfiles { get; set; } = true;

    /// <summary>
    /// Gets or sets a value indicating whether the scheduled task trains a shadow ML model for offline evaluation.
    /// Overridden by <c>Pgsql_TASTE_SHADOW_TRAIN</c>.
    /// </summary>
    public bool EnableNeuralShadowTraining { get; set; } = true;

    /// <summary>
    /// Gets or sets a value indicating whether neural model scores may affect live rankings.
    /// Defaults to false so shadow training collects metrics without changing suggestions.
    /// Overridden by <c>Pgsql_TASTE_NEURAL_SERVE</c>.
    /// </summary>
    public bool UseNeuralForServing { get; set; }

    /// <summary>
    /// Gets or sets how many days of watch/favorite history to include when building taste profiles.
    /// Overridden by <c>Pgsql_TASTE_LOOKBACK_DAYS</c>.
    /// </summary>
    public int TasteLookbackDays { get; set; } = 730;

    /// <summary>
    /// Gets or sets the minimum positive history signals required before applying a taste bonus.
    /// Overridden by <c>Pgsql_TASTE_MIN_SAMPLES</c>.
    /// </summary>
    public int TasteMinSamples { get; set; } = 3;

    /// <summary>
    /// Gets or sets the absolute maximum linear taste bonus applied during similarity re-ranking.
    /// Overridden by <c>Pgsql_TASTE_MAX_BONUS</c>.
    /// </summary>
    public int MaxTasteBonus { get; set; } = 180;
}
