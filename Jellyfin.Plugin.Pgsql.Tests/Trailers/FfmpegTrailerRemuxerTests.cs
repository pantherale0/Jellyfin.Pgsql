using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
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
    private static readonly string FfmpegPath = Environment.GetEnvironmentVariable("PGSQL_TEST_FFMPEG") ?? "/usr/bin/ffmpeg";

    [Fact]
    public async Task RelayAsync_PatchesDurationAndWritesBeforeFfmpegFinishes()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        var directory = Path.Combine(Path.GetTempPath(), $"streaming-trailer-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        var executable = Path.Combine(directory, "fake-ffmpeg");
        var finished = executable + ".finished";
        var initialization = Convert.ToBase64String(CreateInitializationSegment());
        try
        {
            var script = $"#!/bin/sh\nfor last; do :; done\nif [ \"$last\" = \"pipe:1\" ]; then\n printf '%s' '{initialization}' | base64 -d\n sleep 2\n printf fragment\n touch '{finished}'\nelse\n printf '%s' '{initialization}' | base64 -d > \"$last\"\n sleep 2\n printf fragment >> \"$last\"\n touch '{finished}'\nfi\n";
            await File.WriteAllTextAsync(executable, script);
            File.SetUnixFileMode(executable, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            var encoder = new Mock<IMediaEncoder>();
            encoder.SetupGet(value => value.EncoderPath).Returns(executable);
            var remuxer = new FfmpegTrailerRemuxer(encoder.Object);
            var context = CreateContext();
            var body = new WriteSignalStream();
            context.Response.Body = body;
            var relay = remuxer.RelayAsync(AdaptiveResolution(4.2), context, CancellationToken.None);

            var firstWrite = await Task.WhenAny(body.FirstWrite.Task, Task.Delay(TimeSpan.FromMilliseconds(500)));
            var startedBeforeExit = firstWrite == body.FirstWrite.Task && !File.Exists(finished);
            await relay;

            Assert.True(startedBeforeExit, "The MP4 initialization section should reach the client before ffmpeg exits.");
            Assert.Equal(200, context.Response.StatusCode);
            Assert.Equal("video/mp4", context.Response.ContentType);
            Assert.Null(context.Response.ContentLength);
            Assert.Equal("none", context.Response.Headers.AcceptRanges.ToString());
            var response = body.ToArray();
            Assert.Equal(4200u, MovieDurationMilliseconds(response.AsSpan(0, CreateInitializationSegment().Length).ToArray()));
            Assert.EndsWith("fragment", Encoding.UTF8.GetString(body.ToArray()), StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public async Task RelayAsync_CancellationStopsFfmpegAfterInitialization()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        var directory = Path.Combine(Path.GetTempPath(), $"cancelled-trailer-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        var executable = Path.Combine(directory, "fake-ffmpeg");
        var initialization = Convert.ToBase64String(CreateInitializationSegment());
        try
        {
            await File.WriteAllTextAsync(executable, $"#!/bin/sh\nfor last; do :; done\nprintf '%s' '{initialization}' | base64 -d\nsleep 30\n");
            File.SetUnixFileMode(executable, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            var encoder = new Mock<IMediaEncoder>();
            encoder.SetupGet(value => value.EncoderPath).Returns(executable);
            var remuxer = new FfmpegTrailerRemuxer(encoder.Object);
            var context = CreateContext();
            var body = new WriteSignalStream();
            context.Response.Body = body;
            using var cancellation = new CancellationTokenSource();
            var relay = remuxer.RelayAsync(AdaptiveResolution(4.2), context, cancellation.Token);

            await body.FirstWrite.Task.WaitAsync(TimeSpan.FromSeconds(5));
            cancellation.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => relay);
            Assert.Equal(4200u, MovieDurationMilliseconds(body.ToArray()));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public async Task RelayAsync_RequiresDurationForAdaptiveTracks()
    {
        var encoder = new Mock<IMediaEncoder>();
        var remuxer = new FfmpegTrailerRemuxer(encoder.Object);
        var resolution = new YtDlpResolution("video", new Dictionary<string, string>(), "audio");

        var exception = await Assert.ThrowsAsync<YtDlpException>(() => remuxer.RelayAsync(resolution, CreateContext(), CancellationToken.None));

        Assert.Equal("yt-dlp did not report a duration for the adaptive trailer.", exception.Message);
        encoder.VerifyGet(value => value.EncoderPath, Times.Never);
    }

    [RealFfmpegFact]
    public async Task RelayAsync_RealAdaptiveTracksStreamFiniteDurationAndFragments()
    {
        var directory = Path.Combine(Path.GetTempPath(), $"real-trailer-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        try
        {
            var video = Path.Combine(directory, "video.mp4");
            var audio = Path.Combine(directory, "audio.m4a");
            await RunFfmpegAsync("-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10", "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", video);
            await RunFfmpegAsync("-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "4", "-c:a", "aac", "-vn", audio);
            var encoder = new Mock<IMediaEncoder>();
            encoder.SetupGet(value => value.EncoderPath).Returns(FfmpegPath);
            var remuxer = new FfmpegTrailerRemuxer(encoder.Object);
            var context = CreateContext();

            await remuxer.RelayAsync(new YtDlpResolution(video, new Dictionary<string, string>(), audio, new Dictionary<string, string>(), 4.2), context, CancellationToken.None);

            var bytes = ((MemoryStream)context.Response.Body).ToArray();
            var topLevel = ReadAtoms(bytes, 0, bytes.Length);
            Assert.Contains(topLevel, atom => atom.Type == "moov");
            Assert.Contains(topLevel, atom => atom.Type == "moof");
            Assert.Contains(topLevel, atom => atom.Type == "mdat");
            Assert.Equal(4200u, MovieDurationMilliseconds(bytes));
            Assert.Null(context.Response.ContentLength);
            Assert.Equal("none", context.Response.Headers.AcceptRanges.ToString());
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static YtDlpResolution AdaptiveResolution(double durationSeconds)
        => new("https://media.example/video.mp4", new Dictionary<string, string>(), "https://media.example/audio.m4a", new Dictionary<string, string>(), durationSeconds);

    private static DefaultHttpContext CreateContext()
    {
        var context = new DefaultHttpContext();
        context.Request.Method = HttpMethods.Get;
        context.Response.Body = new MemoryStream();
        return context;
    }

    private static byte[] CreateInitializationSegment()
    {
        var fileType = new byte[24];
        BinaryPrimitives.WriteUInt32BigEndian(fileType, (uint)fileType.Length);
        Encoding.ASCII.GetBytes("ftyp").CopyTo(fileType, 4);
        Encoding.ASCII.GetBytes("isom").CopyTo(fileType, 8);
        Encoding.ASCII.GetBytes("isom").CopyTo(fileType, 16);

        var movieHeader = new byte[108];
        BinaryPrimitives.WriteUInt32BigEndian(movieHeader, (uint)movieHeader.Length);
        Encoding.ASCII.GetBytes("mvhd").CopyTo(movieHeader, 4);
        BinaryPrimitives.WriteUInt32BigEndian(movieHeader.AsSpan(20, 4), 1000);
        var movie = new byte[8 + movieHeader.Length];
        BinaryPrimitives.WriteUInt32BigEndian(movie, (uint)movie.Length);
        Encoding.ASCII.GetBytes("moov").CopyTo(movie, 4);
        movieHeader.CopyTo(movie, 8);
        return [ .. fileType, .. movie ];
    }

    private static uint MovieDurationMilliseconds(byte[] bytes)
    {
        var topLevel = ReadAtoms(bytes, 0, bytes.Length);
        var movie = Assert.Single(topLevel, atom => atom.Type == "moov");
        var movieHeader = Assert.Single(ReadAtoms(bytes, movie.Offset + movie.HeaderSize, movie.Offset + movie.Size), atom => atom.Type == "mvhd");
        return BinaryPrimitives.ReadUInt32BigEndian(bytes.AsSpan(movieHeader.Offset + 24, sizeof(uint)));
    }

    private static List<Mp4Atom> ReadAtoms(byte[] bytes, int start, int end)
    {
        var atoms = new List<Mp4Atom>();
        for (var offset = start; offset + 8 <= end;)
        {
            var size = checked((int)BinaryPrimitives.ReadUInt32BigEndian(bytes.AsSpan(offset, sizeof(uint))));
            Assert.InRange(size, 8, end - offset);
            atoms.Add(new Mp4Atom(Encoding.ASCII.GetString(bytes, offset + 4, 4), offset, size, 8));
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

    private sealed record Mp4Atom(string Type, int Offset, int Size, int HeaderSize);

    private sealed class WriteSignalStream : MemoryStream
    {
        public TaskCompletionSource FirstWrite { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public override void Write(byte[] buffer, int offset, int count)
        {
            FirstWrite.TrySetResult();
            base.Write(buffer, offset, count);
        }

        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
        {
            FirstWrite.TrySetResult();
            return base.WriteAsync(buffer, offset, count, cancellationToken);
        }

        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            FirstWrite.TrySetResult();
            return base.WriteAsync(buffer, cancellationToken);
        }
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
}
