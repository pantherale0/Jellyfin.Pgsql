using System;
using Jellyfin.Plugin.Pgsql.Api;
using MediaBrowser.Controller;
using Xunit;

namespace Jellyfin.Plugin.Pgsql.Tests.Ha;

public sealed class HaStatsTests
{
    [Fact]
    public void SingleInstance_ReportsSingleWithoutHeartbeat()
    {
        var response = new PgsqlStatsResponse();
        PgsqlStatsController.DescribeHa(response, new FakeLeadership(haEnabled: false, isLeader: true, epoch: 1), TimeSpan.FromSeconds(5), "node-a");

        Assert.False(response.HaEnabled);
        Assert.Equal("single", response.HaRole);
        Assert.Equal(1, response.LeaderEpoch);
        Assert.Null(response.HaHeartbeatSeconds);
        Assert.Null(response.LeaderSinceUtc);
        Assert.Equal("node-a", response.InstanceName);
    }

    [Fact]
    public void HaLeader_ReportsLeaderEpochAndHeartbeat()
    {
        var response = new PgsqlStatsResponse();
        PgsqlStatsController.DescribeHa(response, new FakeLeadership(haEnabled: true, isLeader: true, epoch: 3), TimeSpan.FromSeconds(7), "node-b");

        Assert.True(response.HaEnabled);
        Assert.Equal("leader", response.HaRole);
        Assert.Equal(3, response.LeaderEpoch);
        Assert.Equal(7, response.HaHeartbeatSeconds);
        Assert.Equal("node-b", response.InstanceName);
    }

    [Fact]
    public void HaStandby_ReportsStandbyWithoutLeaderSince()
    {
        var response = new PgsqlStatsResponse();
        PgsqlStatsController.DescribeHa(response, new FakeLeadership(haEnabled: true, isLeader: false, epoch: 2), TimeSpan.FromSeconds(5), "node-c");

        Assert.True(response.HaEnabled);
        Assert.Equal("standby", response.HaRole);
        Assert.Equal(2, response.LeaderEpoch);
        Assert.Null(response.LeaderSinceUtc);
        Assert.Equal(5, response.HaHeartbeatSeconds);
    }

    [Fact]
    public void DefaultResponse_IsSingleInstance()
    {
        var response = new PgsqlStatsResponse();
        Assert.False(response.HaEnabled);
        Assert.Equal("single", response.HaRole);
    }

    private sealed class FakeLeadership : IInstanceLeadership
    {
        public FakeLeadership(bool haEnabled, bool isLeader, long epoch)
        {
            IsHaEnabled = haEnabled;
            IsLeader = isLeader;
            Epoch = epoch;
        }

        public event EventHandler<LeadershipChangedEventArgs>? LeadershipChanged
        {
            add { }
            remove { }
        }

        public bool IsHaEnabled { get; }

        public bool IsLeader { get; }

        public long Epoch { get; }
    }
}
