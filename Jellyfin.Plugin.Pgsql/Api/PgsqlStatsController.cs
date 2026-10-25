using System;
using Jellyfin.Plugin.Pgsql.Ha;
using Jellyfin.Plugin.Pgsql.Query;
using MediaBrowser.Controller;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.Pgsql.Api;

/// <summary>
/// Exposes runtime stats for the PostgreSQL plugin dashboard page.
/// </summary>
[ApiController]
[Authorize(Roles = AdministratorRole)]
[Route("Pgsql/Stats")]
public sealed class PgsqlStatsController : ControllerBase
{
    private const string AdministratorRole = "Administrator";

    private readonly QueryRuntimeStats _stats;
    private readonly RedisConnectionAccessor _redis;
    private readonly IInstanceLeadership _leadership;

    /// <summary>
    /// Initializes a new instance of the <see cref="PgsqlStatsController"/> class.
    /// </summary>
    /// <param name="stats">The runtime stats collector.</param>
    /// <param name="redis">Optional shared Redis hub accessor.</param>
    /// <param name="leadership">Instance leadership (HA or the single-instance default).</param>
    public PgsqlStatsController(QueryRuntimeStats stats, RedisConnectionAccessor redis, IInstanceLeadership leadership)
    {
        _stats = stats;
        _redis = redis;
        _leadership = leadership;
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
        var hub = _redis.Hub;
        var response = new PgsqlStatsResponse
        {
            StartedAtUtc = snapshot.StartedAtUtc,
            CacheActive = options.CacheActive,
            CacheBackend = options.CacheBackend.ToString(),
            LatestTtlSeconds = (int)options.LatestTtl.TotalSeconds,
            ResumeTtlSeconds = (int)options.ResumeTtl.TotalSeconds,
            NextUpTtlSeconds = (int)options.NextUpTtl.TotalSeconds,
            BrowseTtlSeconds = (int)options.BrowseTtl.TotalSeconds,
            OptimizeMoviesLatest = options.OptimizeMoviesLatest,
            OptimizeTvLatest = options.OptimizeTvLatest,
            OptimizeMusicLatest = options.OptimizeMusicLatest,
            OptimizeNextUp = options.OptimizeNextUp,
            LatestCacheHits = snapshot.LatestCacheHits,
            LatestCacheMisses = snapshot.LatestCacheMisses,
            ResumeCacheHits = snapshot.ResumeCacheHits,
            ResumeCacheMisses = snapshot.ResumeCacheMisses,
            NextUpCacheHits = snapshot.NextUpCacheHits,
            NextUpCacheMisses = snapshot.NextUpCacheMisses,
            BrowseCacheHits = snapshot.BrowseCacheHits,
            BrowseCacheMisses = snapshot.BrowseCacheMisses,
            RedisAvailability = hub?.Status.ToString() ?? "Disabled",
            RedisConnected = hub?.Connection.IsConnected ?? false,
            RedisGetErrors = snapshot.RedisGetErrors,
            RedisSetErrors = snapshot.RedisSetErrors,
            OptimizedLatestRuns = snapshot.OptimizedLatestRuns,
            OptimizedLatestFailures = snapshot.OptimizedLatestFailures,
            OptimizedNextUpRuns = snapshot.OptimizedNextUpRuns,
            OptimizedNextUpFailures = snapshot.OptimizedNextUpFailures,
        };

        DescribeHa(response, _leadership, HaOptions.Current.Heartbeat, Environment.MachineName);
        return Ok(response);
    }

    /// <summary>
    /// Fills the HA block of a stats response from the current leadership state.
    /// </summary>
    /// <param name="response">The response to fill.</param>
    /// <param name="leadership">Instance leadership.</param>
    /// <param name="heartbeat">Configured HA heartbeat interval.</param>
    /// <param name="instanceName">Host name of this instance.</param>
    internal static void DescribeHa(PgsqlStatsResponse response, IInstanceLeadership leadership, TimeSpan heartbeat, string instanceName)
    {
        response.InstanceName = instanceName;
        response.LeaderEpoch = leadership.Epoch;
        if (!leadership.IsHaEnabled)
        {
            response.HaEnabled = false;
            response.HaRole = "single";
            response.LeaderSinceUtc = null;
            response.HaHeartbeatSeconds = null;
            return;
        }

        response.HaEnabled = true;
        response.HaRole = leadership.IsLeader ? "leader" : "standby";
        response.LeaderSinceUtc = leadership.IsLeader && leadership is PostgresInstanceLeadership postgres
            ? postgres.LeaderSinceUtc
            : null;
        response.HaHeartbeatSeconds = (int)heartbeat.TotalSeconds;
    }
}
