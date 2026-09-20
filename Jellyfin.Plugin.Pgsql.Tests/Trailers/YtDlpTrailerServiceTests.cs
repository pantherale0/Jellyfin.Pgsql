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
        var service = new YtDlpTrailerService(runner, factory.Object, NullLogger<YtDlpTrailerService>.Instance);

        for (var index = 0; index < 2; index++)
        {
            var context = new DefaultHttpContext();
            context.Request.Headers.Range = "bytes=10-20";
            context.Response.Body = new MemoryStream();
            await service.RelayAsync("dQw4w9WgXcQ", context, CancellationToken.None);
            Assert.Equal(StatusCodes.Status206PartialContent, context.Response.StatusCode);
            Assert.Equal("video/mp4", context.Response.ContentType);
        }

        Assert.Equal(1, runner.CallCount);
        Assert.Equal("bytes=10-20", handler.LastRange);
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
        public string? LastRange { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            LastRange = request.Headers.Range?.ToString();
            var response = new HttpResponseMessage(HttpStatusCode.PartialContent)
            {
                Content = new ByteArrayContent([1, 2, 3])
            };
            response.Content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("video/mp4");
            response.Headers.AcceptRanges.Add("bytes");
            return Task.FromResult(response);
        }
    }
}
