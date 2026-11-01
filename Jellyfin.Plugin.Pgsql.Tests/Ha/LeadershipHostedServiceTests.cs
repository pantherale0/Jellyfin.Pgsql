using System;
using System.Threading.Tasks;
using Jellyfin.Plugin.Pgsql.Ha;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.MediaEncoding;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using Xunit;

namespace Jellyfin.Plugin.Pgsql.Tests.Ha;

public sealed class LeadershipHostedServiceTests
{
    [Fact]
    public async Task ApplyDemotionAsync_ContinuesAfterLibraryStopFails()
    {
        var libraryMonitor = new Mock<ILibraryMonitor>();
        libraryMonitor.Setup(monitor => monitor.Stop()).Throws(new InvalidOperationException("Monitor stop failed."));

        var scheduledTask = new Mock<IScheduledTaskWorker>();
        scheduledTask.SetupGet(task => task.State).Returns(TaskState.Running);

        var taskManager = new Mock<ITaskManager>();
        taskManager.SetupGet(manager => manager.ScheduledTasks).Returns(new[] { scheduledTask.Object });

        var transcodeManager = new Mock<ITranscodeManager>();
        transcodeManager.Setup(manager => manager.KillAllTranscodingJobs()).Returns(Task.CompletedTask);
        var mediaSourceManager = new Mock<IMediaSourceManager>();
        var liveStream = new Mock<ILiveStream>();
        liveStream.SetupGet(stream => stream.MediaSource).Returns(new MediaSourceInfo { LiveStreamId = "live-stream-1" });
        liveStream.SetupGet(stream => stream.ConsumerCount).Returns(1);
        mediaSourceManager.Setup(manager => manager.GetOpenLiveStreams()).Returns(new[] { liveStream.Object });
        mediaSourceManager.Setup(manager => manager.CloseLiveStream("live-stream-1")).Returns(Task.CompletedTask);

        await LeadershipHostedService.ApplyDemotionAsync(
            libraryMonitor.Object,
            taskManager.Object,
            transcodeManager.Object,
            mediaSourceManager.Object,
            NullLogger<LeadershipHostedService>.Instance).ConfigureAwait(false);

        taskManager.Verify(manager => manager.Cancel(scheduledTask.Object), Times.Once);
        transcodeManager.Verify(manager => manager.KillAllTranscodingJobs(), Times.Once);
        mediaSourceManager.Verify(manager => manager.CloseLiveStream("live-stream-1"), Times.Once);
    }

    [Fact]
    public async Task ApplyDemotionAsync_ContinuesAfterTaskCancellationFails()
    {
        var libraryMonitor = new Mock<ILibraryMonitor>();
        var firstTask = new Mock<IScheduledTaskWorker>();
        firstTask.SetupGet(task => task.State).Returns(TaskState.Running);
        var secondTask = new Mock<IScheduledTaskWorker>();
        secondTask.SetupGet(task => task.State).Returns(TaskState.Running);
        var idleTask = new Mock<IScheduledTaskWorker>();
        idleTask.SetupGet(task => task.State).Returns(TaskState.Idle);

        var taskManager = new Mock<ITaskManager>();
        taskManager.SetupGet(manager => manager.ScheduledTasks).Returns(new[]
        {
            firstTask.Object,
            secondTask.Object,
            idleTask.Object
        });
        taskManager
            .Setup(manager => manager.Cancel(firstTask.Object))
            .Throws(new InvalidOperationException("Task cancellation failed."));

        var transcodeManager = new Mock<ITranscodeManager>();
        transcodeManager.Setup(manager => manager.KillAllTranscodingJobs()).Returns(Task.CompletedTask);
        var mediaSourceManager = new Mock<IMediaSourceManager>();
        var liveStream = new Mock<ILiveStream>();
        liveStream.SetupGet(stream => stream.MediaSource).Returns(new MediaSourceInfo { LiveStreamId = "live-stream-2" });
        liveStream.SetupGet(stream => stream.ConsumerCount).Returns(1);
        mediaSourceManager.Setup(manager => manager.GetOpenLiveStreams()).Returns(new[] { liveStream.Object });
        mediaSourceManager.Setup(manager => manager.CloseLiveStream("live-stream-2")).Returns(Task.CompletedTask);

        await LeadershipHostedService.ApplyDemotionAsync(
            libraryMonitor.Object,
            taskManager.Object,
            transcodeManager.Object,
            mediaSourceManager.Object,
            NullLogger<LeadershipHostedService>.Instance).ConfigureAwait(false);

        taskManager.Verify(manager => manager.Cancel(firstTask.Object), Times.Once);
        taskManager.Verify(manager => manager.Cancel(secondTask.Object), Times.Once);
        taskManager.Verify(manager => manager.Cancel(idleTask.Object), Times.Never);
        transcodeManager.Verify(manager => manager.KillAllTranscodingJobs(), Times.Once);
        mediaSourceManager.Verify(manager => manager.CloseLiveStream("live-stream-2"), Times.Once);
    }

    [Fact]
    public async Task ApplyDemotionAsync_ContinuesAfterConsumerCloseFails()
    {
        var libraryMonitor = new Mock<ILibraryMonitor>();
        var taskManager = new Mock<ITaskManager>();
        var transcodeManager = new Mock<ITranscodeManager>();
        transcodeManager.Setup(manager => manager.KillAllTranscodingJobs()).Returns(Task.CompletedTask);

        var mediaSourceManager = new Mock<IMediaSourceManager>();
        var liveStream = new Mock<ILiveStream>();
        liveStream.SetupGet(stream => stream.MediaSource).Returns(new MediaSourceInfo { LiveStreamId = "live-stream-3" });
        liveStream.SetupGet(stream => stream.ConsumerCount).Returns(2);
        mediaSourceManager.Setup(manager => manager.GetOpenLiveStreams()).Returns(new[] { liveStream.Object });

        var closeAttempts = 0;
        mediaSourceManager
            .Setup(manager => manager.CloseLiveStream("live-stream-3"))
            .Returns(() =>
            {
                closeAttempts++;
                return closeAttempts == 1
                    ? Task.FromException(new InvalidOperationException("Consumer close failed."))
                    : Task.CompletedTask;
            });

        await LeadershipHostedService.ApplyDemotionAsync(
            libraryMonitor.Object,
            taskManager.Object,
            transcodeManager.Object,
            mediaSourceManager.Object,
            NullLogger<LeadershipHostedService>.Instance).ConfigureAwait(false);

        mediaSourceManager.Verify(manager => manager.CloseLiveStream("live-stream-3"), Times.Exactly(2));
        Assert.Equal(2, closeAttempts);
    }
}
