using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.Pgsql.Trailers;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using Xunit;

namespace Jellyfin.Plugin.Pgsql.Tests.Trailers;

public sealed class YtDlpTrailerServiceTests
{
    [Fact]
    public async Task RelayAsync_CachesResolutionAndForwardsRange()
    {
        var runner = new CountingRunner();
        var handler = new RecordingHandler();
        using var httpClient = new HttpClient(handler);
        var factory = new Mock<IHttpClientFactory>();
        factory.Setup(f => f.CreateClient(It.IsAny<string>())).Returns(httpClient);
        var remuxer = new Mock<ITrailerRemuxer>();
        var service = new YtDlpTrailerService(runner, factory.Object, remuxer.Object, NullLogger<YtDlpTrailerService>.Instance);

        for (var index = 0; index < 2; index++)
        {
            var context = new DefaultHttpContext();
            context.Request.Headers.Range = "bytes=10-20";
            var responseBody = new MemoryStream();
            using (responseBody)
            {
                context.Response.Body = responseBody;
                await service.RelayAsync("dQw4w9WgXcQ", context, CancellationToken.None);
                Assert.Equal(StatusCodes.Status206PartialContent, context.Response.StatusCode);
                Assert.Equal("video/mp4", context.Response.ContentType);
            }

            Assert.False(responseBody.CanWrite);
        }

        Assert.Equal(1, runner.CallCount);
        Assert.Equal("bytes=10-20", handler.LastRange);
        Assert.Equal(2, handler.Contents.Count);
        Assert.All(handler.Contents, content => Assert.True(content.IsDisposed));
    }

    [Fact]
    public async Task RelayAsync_UsesRemuxerForAdaptiveTracks()
    {
        var runner = new Mock<IYtDlpProcessRunner>();
        runner.Setup(r => r.ResolveAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(new YtDlpResolution(
                "https://media.example/video.mp4",
                new Dictionary<string, string>(),
                "https://media.example/audio.m4a",
                new Dictionary<string, string>()));
        var factory = new Mock<IHttpClientFactory>();
        var remuxer = new Mock<ITrailerRemuxer>();
        var service = new YtDlpTrailerService(runner.Object, factory.Object, remuxer.Object, NullLogger<YtDlpTrailerService>.Instance);
        var context = new DefaultHttpContext();

        await service.RelayAsync("dQw4w9WgXcQ", context, CancellationToken.None);

        remuxer.Verify(r => r.RelayAsync(It.Is<YtDlpResolution>(value => value.RequiresRemux), context, CancellationToken.None), Times.Once);
        factory.Verify(f => f.CreateClient(It.IsAny<string>()), Times.Never);
    }

    private sealed class CountingRunner : IYtDlpProcessRunner
    {
        public int CallCount { get; private set; }

        public Task<YtDlpResolution> ResolveAsync(string executablePath, string videoId, CancellationToken cancellationToken)
        {
            CallCount++;
            return Task.FromResult(new YtDlpResolution(
                "https://media.example/trailer.mp4",
                new Dictionary<string, string> { ["User-Agent"] = "test" }));
        }
    }

    private sealed class RecordingHandler : HttpMessageHandler
    {
        public List<TrackingContent> Contents { get; } = [];

        public string? LastRange { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            LastRange = request.Headers.Range?.ToString();
            var content = new TrackingContent([1, 2, 3]);
            Contents.Add(content);
            var response = new HttpResponseMessage(HttpStatusCode.PartialContent)
            {
                Content = content
            };
            response.Content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("video/mp4");
            response.Headers.AcceptRanges.Add("bytes");
            return Task.FromResult(response);
        }
    }

    private sealed class TrackingContent(byte[] content) : ByteArrayContent(content)
    {
        public bool IsDisposed { get; private set; }

        protected override void Dispose(bool disposing)
        {
            IsDisposed = true;
            base.Dispose(disposing);
        }
    }
}
