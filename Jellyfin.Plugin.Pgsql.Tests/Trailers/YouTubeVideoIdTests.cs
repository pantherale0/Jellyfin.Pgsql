using Jellyfin.Plugin.Pgsql.Trailers;
using Xunit;

namespace Jellyfin.Plugin.Pgsql.Tests.Trailers;

public sealed class YouTubeVideoIdTests
{
    [Theory]
    [InlineData("dQw4w9WgXcQ")]
    [InlineData("abc_DEF-123")]
    public void IsValid_AcceptsStrictVideoIds(string value)
        => Assert.True(YouTubeVideoId.IsValid(value));

    [Theory]
    [InlineData("")]
    [InlineData("short")]
    [InlineData("dQw4w9WgXcQ?list=bad")]
    [InlineData("dQw4w9WgXc/")]
    public void IsValid_RejectsInvalidVideoIds(string value)
        => Assert.False(YouTubeVideoId.IsValid(value));
}
