using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.Pgsql.Trailers;
using MediaBrowser.Controller.MediaEncoding;
using Microsoft.AspNetCore.Http;
using Moq;
using Xunit;

namespace Jellyfin.Plugin.Pgsql.Tests.Trailers;

public sealed class FfmpegTrailerRemuxerTests
{
    [Fact]
    public async Task RelayAsync_StreamsFfmpegOutputAsMp4()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        var path = Path.Combine(Path.GetTempPath(), $"fake-ffmpeg-{Guid.NewGuid():N}");
        try
        {
            await File.WriteAllTextAsync(path, "#!/bin/sh\nprintf 'fragmented-mp4'\n");
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            var mediaEncoder = new Mock<IMediaEncoder>();
            mediaEncoder.SetupGet(encoder => encoder.EncoderPath).Returns(path);
            var remuxer = new FfmpegTrailerRemuxer(mediaEncoder.Object);
            var context = new DefaultHttpContext();
            context.Response.Body = new MemoryStream();
            var resolution = new YtDlpResolution(
                "https://media.example/video.mp4",
                new Dictionary<string, string>(),
                "https://media.example/audio.m4a",
                new Dictionary<string, string>());

            await remuxer.RelayAsync(resolution, context, CancellationToken.None);

            Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
            Assert.Equal("video/mp4", context.Response.ContentType);
            Assert.Equal("fragmented-mp4", Encoding.UTF8.GetString(((MemoryStream)context.Response.Body).ToArray()));
        }
        finally
        {
            File.Delete(path);
        }
    }
}
