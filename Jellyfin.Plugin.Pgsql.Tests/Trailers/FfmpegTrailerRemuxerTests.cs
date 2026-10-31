using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.Pgsql.Trailers;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.MediaEncoding;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using Xunit;

namespace Jellyfin.Plugin.Pgsql.Tests.Trailers;

public sealed class FfmpegTrailerRemuxerTests
{
    private static readonly string FfmpegPath = Environment.GetEnvironmentVariable("PGSQL_TEST_FFMPEG") ?? "/usr/bin/ffmpeg";

    [Fact]
    public async Task RelayAsync_ServesFinalizedMp4WithRangesAndReusesPreparedFile()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        var directory = Path.Combine(Path.GetTempPath(), $"trailer-test-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, "fake-ffmpeg");
        try
        {
            await File.WriteAllTextAsync(path, "#!/bin/sh\nfor last; do :; done\ncase \"$last\" in /*.mp4) ;; *) exit 1 ;; esac\nprintf 'complete-mp4' > \"$last\"\nprintf x >> \"$0.calls\"\n");
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            var mediaEncoder = new Mock<IMediaEncoder>();
            mediaEncoder.SetupGet(encoder => encoder.EncoderPath).Returns(path);
            var appPaths = new Mock<IApplicationPaths>();
            appPaths.SetupGet(paths => paths.CachePath).Returns(directory);
            await using var remuxer = new FfmpegTrailerRemuxer(mediaEncoder.Object, appPaths.Object, NullLogger<FfmpegTrailerRemuxer>.Instance);
            using var services = new ServiceCollection().AddLogging().BuildServiceProvider();
            var context = CreateContext(services);
            var orphan = Path.Combine(directory, "pgsql-trailers", Guid.NewGuid().ToString("N"));
            var recent = Path.Combine(directory, "pgsql-trailers", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(orphan);
            Directory.CreateDirectory(recent);
            await File.WriteAllTextAsync(Path.Combine(orphan, "leftover.mp4"), "stale");
            Directory.SetLastWriteTimeUtc(orphan, DateTime.UtcNow.AddHours(-1));
            var resolution = new YtDlpResolution(
                "https://media.example/video.mp4",
                new Dictionary<string, string>(),
                "https://media.example/audio.m4a",
                new Dictionary<string, string>());

            await remuxer.RelayAsync(resolution, context, CancellationToken.None);

            Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
            Assert.Equal("video/mp4", context.Response.ContentType);
            Assert.Equal(12, context.Response.ContentLength);
            Assert.Equal("bytes", context.Response.Headers.AcceptRanges.ToString());
            Assert.Equal("complete-mp4", Encoding.UTF8.GetString(((MemoryStream)context.Response.Body).ToArray()));
            Assert.False(Directory.Exists(orphan));
            Assert.True(Directory.Exists(recent));

            var rangeContext = CreateContext(services);
            rangeContext.Request.Headers.Range = "bytes=2-5";
            await remuxer.RelayAsync(resolution, rangeContext, CancellationToken.None);
            Assert.Equal(StatusCodes.Status206PartialContent, rangeContext.Response.StatusCode);
            Assert.Equal("bytes 2-5/12", rangeContext.Response.Headers.ContentRange.ToString());
            Assert.Equal("mple", Encoding.UTF8.GetString(((MemoryStream)rangeContext.Response.Body).ToArray()));

            var invalidRange = CreateContext(services);
            invalidRange.Request.Headers.Range = "bytes=99-";
            await remuxer.RelayAsync(resolution, invalidRange, CancellationToken.None);
            Assert.Equal(StatusCodes.Status416RangeNotSatisfiable, invalidRange.Response.StatusCode);
            Assert.Equal("bytes */12", invalidRange.Response.Headers.ContentRange.ToString());
            Assert.Empty(((MemoryStream)invalidRange.Response.Body).ToArray());

            var head = CreateContext(services);
            head.Request.Method = HttpMethods.Head;
            await remuxer.RelayAsync(resolution, head, CancellationToken.None);
            Assert.Equal(12, head.Response.ContentLength);
            Assert.Empty(((MemoryStream)head.Response.Body).ToArray());
            Assert.Equal("x", await File.ReadAllTextAsync(path + ".calls"));

            var conditional = CreateContext(services);
            conditional.Request.Headers.IfNoneMatch = context.Response.Headers.ETag;
            await remuxer.RelayAsync(resolution, conditional, CancellationToken.None);
            Assert.Equal(StatusCodes.Status304NotModified, conditional.Response.StatusCode);

            for (var index = 0; index < 9; index++)
            {
                await remuxer.RelayAsync(resolution with { Url = resolution.Url + "?video=" + index }, CreateContext(services), CancellationToken.None);
            }

            Assert.Equal(8, Directory.GetFiles(directory, "*.mp4", SearchOption.AllDirectories).Length);
            await remuxer.DisposeAsync();
            Assert.Empty(Directory.GetFiles(directory, "*.mp4", SearchOption.AllDirectories));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RelayAsync_FailedOrCancelledPreparationRemovesPartialFileAndCanRetry(bool cancel)
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        var directory = Path.Combine(Path.GetTempPath(), $"failed-trailer-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        var executable = Path.Combine(directory, "fake-ffmpeg");
        try
        {
            await File.WriteAllTextAsync(executable, "#!/bin/sh\nfor last; do :; done\nprintf partial > \"$last\"\nprintf started > \"$0.started\"\n" + (cancel ? "sleep 30\n" : "exit 9\n"));
            File.SetUnixFileMode(executable, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            var encoder = new Mock<IMediaEncoder>();
            encoder.SetupGet(value => value.EncoderPath).Returns(executable);
            var paths = new Mock<IApplicationPaths>();
            paths.SetupGet(value => value.CachePath).Returns(directory);
            using var services = new ServiceCollection().AddLogging().BuildServiceProvider();
            var context = CreateContext(services);
            var resolution = new YtDlpResolution("https://example.test/video", new Dictionary<string, string>(), "https://example.test/audio");
            await using (var remuxer = new FfmpegTrailerRemuxer(encoder.Object, paths.Object, NullLogger<FfmpegTrailerRemuxer>.Instance))
            {
                using var cancellation = new CancellationTokenSource();
                var attempt = remuxer.RelayAsync(resolution, context, cancellation.Token);
                if (cancel)
                {
                    using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                    while (!File.Exists(executable + ".started"))
                    {
                        await Task.Delay(10, deadline.Token);
                    }

                    cancellation.Cancel();
                    await Assert.ThrowsAnyAsync<OperationCanceledException>(() => attempt);
                }
                else
                {
                    await Assert.ThrowsAsync<YtDlpException>(() => attempt);
                }

                Assert.Empty(((MemoryStream)context.Response.Body).ToArray());
                Assert.Empty(Directory.GetFiles(directory, "*.mp4", SearchOption.AllDirectories));
                await File.WriteAllTextAsync(executable, "#!/bin/sh\nfor last; do :; done\nprintf complete > \"$last\"\n");
                var retry = CreateContext(services);
                await remuxer.RelayAsync(resolution, retry, CancellationToken.None);
                Assert.Equal("complete", Encoding.UTF8.GetString(((MemoryStream)retry.Response.Body).ToArray()));
            }

            Assert.Empty(Directory.GetFiles(directory, "*.mp4", SearchOption.AllDirectories));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [RealFfmpegFact]
    public async Task RelayAsync_RealAdaptiveTracksHaveFixedDurationInInitialMp4Metadata()
    {
        var directory = Path.Combine(Path.GetTempPath(), $"real-trailer-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        try
        {
            var video = Path.Combine(directory, "video.mp4");
            var audio = Path.Combine(directory, "audio.m4a");
            await RunFfmpegAsync("-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10", "-t", "8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", video);
            await RunFfmpegAsync("-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "8", "-c:a", "aac", "-vn", audio);
            var encoder = new Mock<IMediaEncoder>();
            encoder.SetupGet(value => value.EncoderPath).Returns(FfmpegPath);
            var appPaths = new Mock<IApplicationPaths>();
            appPaths.SetupGet(value => value.CachePath).Returns(directory);
            using var services = new ServiceCollection().AddLogging().BuildServiceProvider();
            await using var remuxer = new FfmpegTrailerRemuxer(encoder.Object, appPaths.Object, NullLogger<FfmpegTrailerRemuxer>.Instance);
            var resolution = new YtDlpResolution(video, new Dictionary<string, string>(), audio, new Dictionary<string, string>());
            var context = CreateContext(services);

            await remuxer.RelayAsync(resolution, context, CancellationToken.None);

            var bytes = ((MemoryStream)context.Response.Body).ToArray();
            var atoms = ReadAtoms(bytes, 0, bytes.Length);
            Assert.DoesNotContain(atoms, atom => atom.Type == "moof");
            var movie = Assert.Single(atoms, atom => atom.Type == "moov");
            var media = Assert.Single(atoms, atom => atom.Type == "mdat");
            Assert.True(movie.Offset < media.Offset, "The fixed-duration metadata must precede media bytes.");
            var header = Assert.Single(ReadAtoms(bytes, movie.Offset + 8, movie.Offset + movie.Size), atom => atom.Type == "mvhd");
            Assert.Equal(0, bytes[header.Offset + 8]);
            var timescale = BinaryPrimitives.ReadUInt32BigEndian(bytes.AsSpan(header.Offset + 20, 4));
            var duration = BinaryPrimitives.ReadUInt32BigEndian(bytes.AsSpan(header.Offset + 24, 4));
            Assert.InRange((double)duration / timescale, 7.9, 8.1);
            Assert.Equal(bytes.Length, context.Response.ContentLength);

            var range = CreateContext(services);
            range.Request.Headers.Range = "bytes=0-4095";
            await remuxer.RelayAsync(resolution, range, CancellationToken.None);
            Assert.Equal(StatusCodes.Status206PartialContent, range.Response.StatusCode);
            Assert.Equal(bytes.AsSpan(0, 4096).ToArray(), ((MemoryStream)range.Response.Body).ToArray());

            var output = Environment.GetEnvironmentVariable("PGSQL_TEST_TRAILER_OUTPUT");
            if (!string.IsNullOrEmpty(output))
            {
                await File.WriteAllBytesAsync(output, bytes);
            }
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static List<(string Type, int Offset, int Size)> ReadAtoms(byte[] bytes, int start, int end)
    {
        var atoms = new List<(string Type, int Offset, int Size)>();
        for (var offset = start; offset + 8 <= end;)
        {
            var size = checked((int)BinaryPrimitives.ReadUInt32BigEndian(bytes.AsSpan(offset, 4)));
            Assert.InRange(size, 8, end - offset);
            atoms.Add((Encoding.ASCII.GetString(bytes, offset + 4, 4), offset, size));
            offset += size;
        }

        return atoms;
    }

    private static async Task RunFfmpegAsync(params string[] arguments)
    {
        var info = new ProcessStartInfo(FfmpegPath) { RedirectStandardError = true, UseShellExecute = false };
        foreach (var argument in new[] { "-hide_banner", "-loglevel", "error", "-nostdin", "-y" })
        {
            info.ArgumentList.Add(argument);
        }

        foreach (var argument in arguments)
        {
            info.ArgumentList.Add(argument);
        }

        using var process = Process.Start(info) ?? throw new InvalidOperationException("ffmpeg did not start.");
        var errors = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        Assert.True(process.ExitCode == 0, await errors);
    }

    private sealed class RealFfmpegFactAttribute : FactAttribute
    {
        public RealFfmpegFactAttribute()
        {
            if (!File.Exists(FfmpegPath))
            {
                Skip = "Set PGSQL_TEST_FFMPEG to run the real ffmpeg regression.";
            }
        }
    }

    private static DefaultHttpContext CreateContext(IServiceProvider services)
    {
        var context = new DefaultHttpContext { RequestServices = services };
        context.Request.Method = HttpMethods.Get;
        context.Response.Body = new MemoryStream();
        return context;
    }
}
