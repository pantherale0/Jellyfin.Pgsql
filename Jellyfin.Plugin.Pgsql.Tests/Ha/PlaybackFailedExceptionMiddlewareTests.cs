using MediaBrowser.Common.Extensions;
using MediaBrowser.Model.Dlna;
using Xunit;

namespace Jellyfin.Plugin.Pgsql.Tests.Ha;

public sealed class PlaybackFailedExceptionTests
{
    [Theory]
    [InlineData(PlaybackErrorCode.TranscodeFailed, "TranscodeFailed")]
    [InlineData(PlaybackErrorCode.TranscodeNotAllowed, "TranscodeNotAllowed")]
    [InlineData(PlaybackErrorCode.LiveStreamFenced, "LiveStreamFenced")]
    [InlineData(PlaybackErrorCode.StreamUnavailable, "StreamUnavailable")]
    public void ErrorCodeString_MatchesEnumName(PlaybackErrorCode errorCode, string expected)
    {
        var ex = new PlaybackFailedException(errorCode);
        Assert.Equal(expected, ex.ErrorCodeString);
        Assert.Equal("X-Playback-Error-Code", PlaybackFailedException.ErrorCodeHeaderName);
        Assert.False(string.IsNullOrWhiteSpace(ex.Message));
    }

    [Fact]
    public void LiveStreamFencedException_InheritsPlaybackFailedException()
    {
        PlaybackFailedException ex = new LiveStreamFencedException();
        Assert.Equal(PlaybackErrorCode.LiveStreamFenced, ex.ErrorCode);
    }
}
