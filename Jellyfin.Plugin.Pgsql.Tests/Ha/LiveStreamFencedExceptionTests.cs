using System;
using MediaBrowser.Common.Extensions;
using Xunit;

namespace Jellyfin.Plugin.Pgsql.Tests.Ha;

public sealed class LiveStreamFencedExceptionTests
{
    [Fact]
    public void Default_UsesStableCodeAndGremlinMessage()
    {
        var ex = new LiveStreamFencedException();
        Assert.Equal("LiveStreamFenced", LiveStreamFencedException.ErrorCode);
        Assert.Contains("gremlins", ex.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("Restart playback", ex.Message, StringComparison.Ordinal);
    }
}
