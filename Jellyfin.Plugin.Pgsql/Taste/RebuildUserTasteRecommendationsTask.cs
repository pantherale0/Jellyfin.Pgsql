using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Pgsql.Taste;

/// <summary>
/// Scheduled materialization of per-user For You recommendation feeds.
/// </summary>
public sealed class RebuildUserTasteRecommendationsTask : IScheduledTask, IConfigurableScheduledTask
{
    private readonly TasteRecommendationService _recommendationService;
    private readonly ILogger<RebuildUserTasteRecommendationsTask> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="RebuildUserTasteRecommendationsTask"/> class.
    /// </summary>
    /// <param name="recommendationService">Recommendation service.</param>
    /// <param name="logger">Logger.</param>
    public RebuildUserTasteRecommendationsTask(
        TasteRecommendationService recommendationService,
        ILogger<RebuildUserTasteRecommendationsTask> logger)
    {
        _recommendationService = recommendationService;
        _logger = logger;
    }

    /// <inheritdoc />
    public string Name => "Rebuild user taste recommendations";

    /// <inheritdoc />
    public string Key => "RebuildUserTasteRecommendations";

    /// <inheritdoc />
    public string Description =>
        "Builds personalized For You Movie and Series home feeds from taste profiles using weighted sampling for variety.";

    /// <inheritdoc />
    public string Category => "Library";

    /// <inheritdoc />
    public bool IsHidden => false;

    /// <inheritdoc />
    public bool IsEnabled => TasteOptions.Current.EnableTasteProfiles;

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
        var options = TasteOptions.Current;
        if (!options.EnableTasteProfiles)
        {
            _logger.LogInformation("Taste profiles disabled; skipping recommendation rebuild task");
            progress.Report(100);
            return;
        }

        progress.Report(1);
        var count = await _recommendationService
            .RebuildAllFeedsAsync(progress, cancellationToken)
            .ConfigureAwait(false);
        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation("Taste recommendation rebuild finished (users={Count})", count);
        }

        progress.Report(100);
    }
}
