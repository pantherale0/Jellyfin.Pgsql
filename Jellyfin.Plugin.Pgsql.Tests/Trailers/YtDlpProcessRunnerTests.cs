using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.Pgsql.Trailers;
using Xunit;

namespace Jellyfin.Plugin.Pgsql.Tests.Trailers;

public sealed class YtDlpProcessRunnerTests
{
    [Fact]
    public async Task ResolveAsync_ThrowsGenericExceptionWhenExecutableIsMissing()
    {
        var runner = new YtDlpProcessRunner();
        await Assert.ThrowsAsync<YtDlpException>(() => runner.ResolveAsync(
            "/definitely/missing/yt-dlp",
            "dQw4w9WgXcQ",
            CancellationToken.None));
    }

    [Fact]
    public async Task ResolveAsync_ParsesBoundedMachineReadableOutput()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        var path = Path.Combine(Path.GetTempPath(), $"fake-yt-dlp-{Guid.NewGuid():N}");
        try
        {
            await File.WriteAllTextAsync(
                path,
                "#!/bin/sh\nprintf '\"https://media.example/trailer.mp4\"\\n{\"User-Agent\":\"test-agent\"}\\n'\n");
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);

            var result = await new YtDlpProcessRunner().ResolveAsync(path, "dQw4w9WgXcQ", CancellationToken.None);

            Assert.Equal("https://media.example/trailer.mp4", result.Url);
            Assert.Equal("test-agent", result.Headers["User-Agent"]);
        }
        finally
        {
            File.Delete(path);
        }
    }
}
