using Jellyfin.Plugin.Pgsql.Query;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.Pgsql.Api;

/// <summary>
/// Exposes runtime stats for the PostgreSQL plugin dashboard page.
/// </summary>
[ApiController]
[Route("Pgsql/Stats")]
public sealed class PgsqlStatsController : ControllerBase
{
    private readonly QueryRuntimeStats _stats;

    /// <summary>
    /// Initializes a new instance of the <see cref="PgsqlStatsController"/> class.
    /// </summary>
    /// <param name="stats">The runtime stats collector.</param>
    public PgsqlStatsController(QueryRuntimeStats stats)
    {
        _stats = stats;
    }

    /// <summary>
    /// Gets plugin cache and optimization runtime stats.
    /// </summary>
    /// <returns>The stats payload.</returns>
    [HttpGet]
    public ActionResult<PgsqlStatsResponse> Get()
    {
        var options = PgsqlQueryOptions.Current;
        var snapshot = _stats.Snapshot();
        return Ok(new PgsqlStatsResponse
        {
            StartedAtUtc = snapshot.StartedAtUtc,
            CacheActive = options.CacheActive,
            CacheBackend = options.CacheBackend.ToString(),
            LatestTtlSeconds = (int)options.LatestTtl.TotalSeconds,
            ResumeTtlSeconds = (int)options.ResumeTtl.TotalSeconds,
            OptimizeMoviesLatest = options.OptimizeMoviesLatest,
            OptimizeTvLatest = options.OptimizeTvLatest,
            OptimizeMusicLatest = options.OptimizeMusicLatest,
            LatestCacheHits = snapshot.LatestCacheHits,
            LatestCacheMisses = snapshot.LatestCacheMisses,
            ResumeCacheHits = snapshot.ResumeCacheHits,
            ResumeCacheMisses = snapshot.ResumeCacheMisses,
            RedisGetErrors = snapshot.RedisGetErrors,
            RedisSetErrors = snapshot.RedisSetErrors,
            OptimizedLatestRuns = snapshot.OptimizedLatestRuns,
            OptimizedLatestFailures = snapshot.OptimizedLatestFailures,
        });
    }
}
