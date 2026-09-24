using Jellyfin.Plugin.Pgsql.Query;
using Xunit;

namespace Jellyfin.Plugin.Pgsql.Tests.Query;

public class RedisConnectionHubTests
{
    [Theory]
    [InlineData(null, 250)]
    [InlineData("invalid", 250)]
    [InlineData("25", 50)]
    [InlineData("400", 400)]
    [InlineData("10000", 5000)]
    public void ResolveOperationTimeoutMilliseconds_UsesBoundedValue(string? value, int expected)
    {
        Assert.Equal(expected, RedisConnectionHub.ResolveOperationTimeoutMilliseconds(value));
    }
}
