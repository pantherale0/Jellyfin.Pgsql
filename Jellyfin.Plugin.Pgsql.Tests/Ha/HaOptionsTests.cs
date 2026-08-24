using Jellyfin.Plugin.Pgsql.Ha;
using Xunit;

namespace Jellyfin.Plugin.Pgsql.Tests.Ha;

public sealed class HaOptionsTests
{
    [Fact]
    public void DefaultLockKeys_AreDistinct()
    {
        Assert.NotEqual(HaOptions.DefaultLockKey, HaOptions.MigrationLockKey);
        Assert.Equal(738462901, HaOptions.DefaultLockKey);
        Assert.Equal(738462902, HaOptions.MigrationLockKey);
    }
}
