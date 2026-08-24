using Jellyfin.Plugin.Pgsql.Admin.EmbyImport;
using MediaBrowser.Controller;
using Xunit;

namespace Jellyfin.Plugin.Pgsql.Tests.Ha;

public sealed class HaContractTests
{
    [Fact]
    public void LeadershipStartsFailClosedUntilAcquire()
    {
        var args = new LeadershipChangedEventArgs(isLeader: false, epoch: 0);
        Assert.False(args.IsLeader);
        Assert.Equal(0, args.Epoch);

        var promoted = new LeadershipChangedEventArgs(true, 1);
        Assert.True(promoted.IsLeader);
        Assert.Equal(1, promoted.Epoch);
    }

    [Fact]
    public void EmbyImportOnStandby_IsConflict()
    {
        var ex = new EmbyImportException("This instance is not the HA leader.", true);
        Assert.True(ex.IsConflict);

        var invalid = new EmbyImportException("library.db and users.db sizes must be greater than zero.");
        Assert.False(invalid.IsConflict);
    }
}
