using System;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.MediaEncoding;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Pgsql.Ha;

/// <summary>
/// Runs the leadership heartbeat and starts/stops writer-only work on promote/demote.
/// </summary>
internal sealed class LeadershipHostedService : IHostedService, IDisposable
{
    private readonly PostgresInstanceLeadership _leadership;
    private readonly ILibraryMonitor _libraryMonitor;
    private readonly ITaskManager _taskManager;
    private readonly ITranscodeManager _transcodeManager;
    private readonly IMediaSourceManager _mediaSourceManager;
    private readonly ILogger<LeadershipHostedService> _logger;
    private readonly CancellationTokenSource _cts = new();
    private Task? _loop;

    /// <summary>
    /// Initializes a new instance of the <see cref="LeadershipHostedService"/> class.
    /// </summary>
    /// <param name="leadership">PostgreSQL leadership.</param>
    /// <param name="libraryMonitor">Library file monitor.</param>
    /// <param name="taskManager">Scheduled task manager.</param>
    /// <param name="transcodeManager">Transcode manager.</param>
    /// <param name="mediaSourceManager">Media source manager.</param>
    /// <param name="logger">The logger.</param>
    public LeadershipHostedService(
        PostgresInstanceLeadership leadership,
        ILibraryMonitor libraryMonitor,
        ITaskManager taskManager,
        ITranscodeManager transcodeManager,
        IMediaSourceManager mediaSourceManager,
        ILogger<LeadershipHostedService> logger)
    {
        _leadership = leadership;
        _libraryMonitor = libraryMonitor;
        _taskManager = taskManager;
        _transcodeManager = transcodeManager;
        _mediaSourceManager = mediaSourceManager;
        _logger = logger;
    }

    /// <inheritdoc />
    public Task StartAsync(CancellationToken cancellationToken)
    {
        _leadership.LeadershipChanged += OnLeadershipChanged;
        _loop = RunAsync(_cts.Token);
        return Task.CompletedTask;
    }

    /// <inheritdoc />
    public async Task StopAsync(CancellationToken cancellationToken)
    {
        await _cts.CancelAsync().ConfigureAwait(false);
        if (_loop is not null)
        {
            try
            {
                await _loop.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
            }
        }

        _leadership.LeadershipChanged -= OnLeadershipChanged;
        await ApplyDemotionAsync().ConfigureAwait(false);
        await _leadership.ResignAsync().ConfigureAwait(false);
    }

    /// <inheritdoc />
    public void Dispose()
    {
        _cts.Dispose();
    }

    private async Task RunAsync(CancellationToken cancellationToken)
    {
        var heartbeat = HaOptions.Current.Heartbeat;
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                await _leadership.TickAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "HA leadership tick failed");
            }

            try
            {
                await Task.Delay(heartbeat, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }
        }
    }

    private void OnLeadershipChanged(object? sender, LeadershipChangedEventArgs e)
    {
        if (e.IsLeader)
        {
            if (_logger.IsEnabled(LogLevel.Information))
            {
                var epoch = e.Epoch;
                _logger.LogInformation("HA promote: starting writer-only work (epoch {Epoch})", epoch);
            }

            _libraryMonitor.Start();
            return;
        }

        if (_logger.IsEnabled(LogLevel.Warning))
        {
            var epoch = e.Epoch;
            _logger.LogWarning("HA demote: stopping writer-only work (epoch {Epoch})", epoch);
        }

        _ = ApplyDemotionAsync();
    }

    private async Task ApplyDemotionAsync()
    {
        try
        {
            _libraryMonitor.Stop();

            foreach (var task in _taskManager.ScheduledTasks)
            {
                if (task.State == TaskState.Running)
                {
                    _taskManager.Cancel(task);
                }
            }

            await _transcodeManager.KillAllTranscodingJobs().ConfigureAwait(false);

            foreach (var stream in _mediaSourceManager.GetOpenLiveStreams())
            {
                var liveStreamId = stream.MediaSource?.LiveStreamId;
                if (string.IsNullOrEmpty(liveStreamId))
                {
                    continue;
                }

                // CloseLiveStream decrements ConsumerCount; drain every consumer so the tuner is released.
                var remaining = Math.Max(1, stream.ConsumerCount);
                for (var i = 0; i < remaining; i++)
                {
                    await _mediaSourceManager.CloseLiveStream(liveStreamId).ConfigureAwait(false);
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error while demoting HA leader");
        }
    }
}
