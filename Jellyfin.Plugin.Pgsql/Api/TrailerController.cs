using System;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.Pgsql.Trailers;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Pgsql.Api;

/// <summary>
/// Relays remote YouTube trailers resolved by yt-dlp.
/// </summary>
[ApiController]
[Authorize]
[Route("Pgsql/Trailers")]
public sealed class TrailerController : ControllerBase
{
    private readonly YtDlpTrailerService _service;
    private readonly ILogger<TrailerController> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="TrailerController"/> class.
    /// </summary>
    /// <param name="service">Trailer relay service.</param>
    /// <param name="logger">Logger.</param>
    public TrailerController(YtDlpTrailerService service, ILogger<TrailerController> logger)
    {
        _service = service;
        _logger = logger;
    }

    /// <summary>
    /// Streams a YouTube trailer through Jellyfin.
    /// </summary>
    /// <param name="videoId">YouTube video identifier.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task representing the streaming operation.</returns>
    [HttpGet("{videoId}/stream")]
    public async Task Stream(string videoId, CancellationToken cancellationToken)
    {
        if (!YouTubeVideoId.IsValid(videoId))
        {
            Response.StatusCode = StatusCodes.Status400BadRequest;
            return;
        }

        try
        {
            await _service.RelayAsync(videoId, HttpContext, cancellationToken).ConfigureAwait(false);
        }
        catch (YtDlpException ex)
        {
            _logger.LogWarning(ex, "Unable to resolve YouTube trailer {VideoId}", videoId);
            Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
        }
        catch (HttpRequestException ex)
        {
            _logger.LogWarning(ex, "Unable to relay YouTube trailer {VideoId}", videoId);
            Response.StatusCode = StatusCodes.Status502BadGateway;
        }
    }
}
