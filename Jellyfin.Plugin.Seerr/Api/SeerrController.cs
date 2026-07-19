using System;
using System.ComponentModel.DataAnnotations;
using System.Linq;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.Seerr.Models;
using Jellyfin.Plugin.Seerr.Services;
using MediaBrowser.Common.Api;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Seerr.Api;

/// <summary>
/// Jellyfin gateway API for Seerr search and requests.
/// </summary>
[ApiController]
[Authorize]
[Route("Seerr")]
public sealed class SeerrController : ControllerBase
{
    private const string UserIdClaimType = "Jellyfin-UserId";

    private readonly SeerrClient _client;
    private readonly SeerrUserResolver _userResolver;
    private readonly SeerrParentalFilter _parentalFilter;
    private readonly IUserManager _userManager;
    private readonly ILogger<SeerrController> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="SeerrController"/> class.
    /// </summary>
    /// <param name="client">Seerr HTTP client.</param>
    /// <param name="userResolver">Username → Seerr user mapper.</param>
    /// <param name="parentalFilter">Parental-control filter.</param>
    /// <param name="userManager">Jellyfin user manager.</param>
    /// <param name="logger">Logger.</param>
    public SeerrController(
        SeerrClient client,
        SeerrUserResolver userResolver,
        SeerrParentalFilter parentalFilter,
        IUserManager userManager,
        ILogger<SeerrController> logger)
    {
        _client = client;
        _userResolver = userResolver;
        _parentalFilter = parentalFilter;
        _userManager = userManager;
        _logger = logger;
    }

    /// <summary>
    /// Returns whether the Seerr gateway is enabled for clients (no secrets).
    /// </summary>
    /// <returns>Status payload.</returns>
    [HttpGet("Status")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public ActionResult<SeerrStatusResponse> GetStatus()
    {
        return Ok(new SeerrStatusResponse { Enabled = SeerrClient.IsConfigured() });
    }

    /// <summary>
    /// Searches Seerr for requestable titles.
    /// </summary>
    /// <param name="query">Search term.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Requestable items.</returns>
    [HttpGet("Search")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType(StatusCodes.Status503ServiceUnavailable)]
    public async Task<ActionResult<SeerrSearchResponse>> Search(
        [FromQuery, Required] string query,
        CancellationToken cancellationToken)
    {
        var jellyfinUser = GetAuthenticatedUser();
        if (jellyfinUser is null)
        {
            return Unauthorized();
        }

        if (!SeerrClient.IsConfigured())
        {
            return StatusCode(StatusCodes.Status503ServiceUnavailable, new { message = "Seerr gateway is not enabled." });
        }

        if (string.IsNullOrWhiteSpace(query))
        {
            return BadRequest(new { message = "query is required." });
        }

        try
        {
            var items = await _parentalFilter
                .SearchForUserAsync(jellyfinUser, query.Trim(), cancellationToken)
                .ConfigureAwait(false);
            return Ok(new SeerrSearchResponse { Items = items });
        }
        catch (SeerrApiException ex)
        {
            return StatusCode(MapStatusCode(ex.StatusCode), new { message = ex.Message });
        }
    }

    /// <summary>
    /// Creates a Seerr request on behalf of the authenticated Jellyfin user.
    /// </summary>
    /// <param name="body">Request payload.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Created request summary.</returns>
    [HttpPost("Request")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status403Forbidden)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    [ProducesResponseType(StatusCodes.Status503ServiceUnavailable)]
    public async Task<ActionResult<SeerrRequestResponse>> RequestMedia(
        [FromBody] SeerrRequestBody body,
        CancellationToken cancellationToken)
    {
        var jellyfinUser = GetAuthenticatedUser();
        if (jellyfinUser is null)
        {
            return Unauthorized();
        }

        if (!SeerrClient.IsConfigured())
        {
            return StatusCode(StatusCodes.Status503ServiceUnavailable, new { message = "Seerr gateway is not enabled." });
        }

        if (body is null
            || string.IsNullOrWhiteSpace(body.MediaType)
            || body.MediaId <= 0)
        {
            return BadRequest(new { message = "mediaType and mediaId are required." });
        }

        var mediaType = body.MediaType.Trim().ToLowerInvariant();
        if (mediaType is not ("movie" or "tv"))
        {
            return BadRequest(new { message = "mediaType must be 'movie' or 'tv'." });
        }

        try
        {
            var allowed = await _parentalFilter
                .IsRequestAllowedAsync(jellyfinUser, mediaType, body.MediaId, cancellationToken)
                .ConfigureAwait(false);
            if (!allowed)
            {
                return StatusCode(
                    StatusCodes.Status403Forbidden,
                    new { message = "This title is blocked by parental controls." });
            }

            var seerrUserId = await _userResolver
                .ResolveAsync(jellyfinUser.Id, jellyfinUser.Username, cancellationToken)
                .ConfigureAwait(false);

            var requestId = await _client
                .CreateRequestAsync(mediaType, body.MediaId, seerrUserId, cancellationToken)
                .ConfigureAwait(false);

            return Ok(new SeerrRequestResponse
            {
                RequestId = requestId,
                Message = "Requested"
            });
        }
        catch (SeerrApiException ex)
        {
            return StatusCode(MapStatusCode(ex.StatusCode), new { message = ex.Message });
        }
    }

    /// <summary>
    /// Tests connectivity to Seerr using the saved configuration (admin only).
    /// </summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Connection test result.</returns>
    [HttpPost("Test")]
    [Authorize(Policy = Policies.RequiresElevation)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<SeerrTestResponse>> Test(CancellationToken cancellationToken)
    {
        var config = Plugin.Instance?.Configuration;
        if (config is null
            || string.IsNullOrWhiteSpace(config.SeerrUrl)
            || string.IsNullOrWhiteSpace(config.ApiKey))
        {
            return BadRequest(new { message = "Save a Seerr URL and API key before testing." });
        }

        try
        {
            var status = await _client.GetStatusAsync(cancellationToken).ConfigureAwait(false);
            // Exercise user list permission (needed for username mapping).
            _ = await _client.FindUsersAsync(string.Empty, cancellationToken).ConfigureAwait(false);

            return Ok(new SeerrTestResponse
            {
                Version = status.Version,
                Message = string.IsNullOrWhiteSpace(status.Version)
                    ? "Reached Seerr successfully."
                    : $"Reached Seerr {status.Version} successfully."
            });
        }
        catch (SeerrApiException ex)
        {
            return StatusCode(MapStatusCode(ex.StatusCode), new { message = ex.Message });
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or InvalidOperationException)
        {
            _logger.LogWarning(ex, "Seerr connection test failed");
            return StatusCode(StatusCodes.Status502BadGateway, new { message = "Unable to reach Seerr." });
        }
    }

    private User? GetAuthenticatedUser()
    {
        var claim = User.Claims.FirstOrDefault(c =>
            string.Equals(c.Type, UserIdClaimType, StringComparison.OrdinalIgnoreCase));
        if (claim is null || !Guid.TryParse(claim.Value, out var userId) || userId == Guid.Empty)
        {
            return null;
        }

        return _userManager.GetUserById(userId);
    }

    private static int MapStatusCode(int seerrStatus) => seerrStatus switch
    {
        400 => StatusCodes.Status400BadRequest,
        401 => StatusCodes.Status401Unauthorized,
        403 => StatusCodes.Status403Forbidden,
        404 => StatusCodes.Status404NotFound,
        409 => StatusCodes.Status409Conflict,
        429 => StatusCodes.Status429TooManyRequests,
        502 => StatusCodes.Status502BadGateway,
        503 => StatusCodes.Status503ServiceUnavailable,
        504 => StatusCodes.Status504GatewayTimeout,
        >= 400 and < 500 => StatusCodes.Status400BadRequest,
        _ => StatusCodes.Status502BadGateway
    };
}
