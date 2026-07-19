using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Model.Session;
using MediaBrowser.Model.Tasks;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Pgsql.Playback;

/// <summary>
/// Rebuilds <see cref="PlaybackActivityDaily"/> rollups used by Overview KPIs.
/// </summary>
public sealed class RebuildPlaybackActivityDailyTask : IScheduledTask, IConfigurableScheduledTask
{
    private readonly IDbContextFactory<JellyfinDbContext> _dbProvider;
    private readonly ILogger<RebuildPlaybackActivityDailyTask> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="RebuildPlaybackActivityDailyTask"/> class.
    /// </summary>
    /// <param name="dbProvider">Database context factory.</param>
    /// <param name="logger">Logger.</param>
    public RebuildPlaybackActivityDailyTask(
        IDbContextFactory<JellyfinDbContext> dbProvider,
        ILogger<RebuildPlaybackActivityDailyTask> logger)
    {
        _dbProvider = dbProvider;
        _logger = logger;
    }

    /// <inheritdoc />
    public string Name => "Rebuild playback activity daily rollups";

    /// <inheritdoc />
    public string Key => "RebuildPlaybackActivityDaily";

    /// <inheritdoc />
    public string Description =>
        "Aggregates PlaybackActivity into per-day totals for Overview KPI queries.";

    /// <inheritdoc />
    public string Category => "Library";

    /// <inheritdoc />
    public bool IsHidden => false;

    /// <inheritdoc />
    public bool IsEnabled => true;

    /// <inheritdoc />
    public bool IsLogged => true;

    /// <inheritdoc />
    public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
    {
        yield return new TaskTriggerInfo
        {
            Type = TaskTriggerInfoType.IntervalTrigger,
            IntervalTicks = TimeSpan.FromHours(24).Ticks
        };
    }

    /// <inheritdoc />
    public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
    {
        progress.Report(0);
        await using var dbContext = await _dbProvider.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);

        var directPlay = (int)PlayMethod.DirectPlay;
        var directStream = (int)PlayMethod.DirectStream;
        var transcode = (int)PlayMethod.Transcode;

        var rows = await dbContext.PlaybackActivity.AsNoTracking()
            .GroupBy(p => p.DatePlayed.Date)
            .Select(g => new PlaybackActivityDaily
            {
                Date = DateTime.SpecifyKind(g.Key, DateTimeKind.Utc),
                PlayCount = g.Count(),
                TotalTicks = g.Sum(p => p.PlayedTicks),
                UniqueUsers = g.Select(p => p.UserId).Distinct().Count(),
                DirectPlayCount = g.Count(p => p.PlayMethod == directPlay),
                DirectStreamCount = g.Count(p => p.PlayMethod == directStream),
                TranscodeCount = g.Count(p => p.PlayMethod == transcode)
            })
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        progress.Report(40);

        await dbContext.PlaybackActivityDaily.ExecuteDeleteAsync(cancellationToken).ConfigureAwait(false);
        if (rows.Count > 0)
        {
            dbContext.PlaybackActivityDaily.AddRange(rows);
            await dbContext.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        }

        progress.Report(100);
        var rowCount = rows.Count;
        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation("Rebuilt {Count} PlaybackActivityDaily rows", rowCount);
        }
    }
}
