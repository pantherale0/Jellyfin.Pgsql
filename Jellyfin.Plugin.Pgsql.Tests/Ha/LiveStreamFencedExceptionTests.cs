using System;
using MediaBrowser.Common.Extensions;
using MediaBrowser.Model.Dlna;
using Xunit;

namespace Jellyfin.Plugin.Pgsql.Tests.Ha;

public sealed class LiveStreamFencedExceptionTests
{
    [Fact]
    public void Default_UsesStableCodeAndFriendlyMessage()
    {
        var ex = new LiveStreamFencedException();
        Assert.Equal(PlaybackErrorCode.LiveStreamFenced, ex.ErrorCode);
        Assert.Equal("LiveStreamFenced", ex.ErrorCodeString);
        Assert.Contains("Restart playback", ex.Message, StringComparison.Ordinal);
    }
}
