using System;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.Pgsql.Admin.EmbyImport;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.Pgsql.Api;

/// <summary>
/// Administrator APIs for importing UserData from Emby SQLite databases.
/// </summary>
[ApiController]
[Authorize(Roles = AdministratorRole)]
[Route("Pgsql/Admin/EmbyImport")]
public sealed class EmbyImportController : ControllerBase
{
    private const string AdministratorRole = "Administrator";
    private const string UserIdClaim = "Jellyfin-UserId";
    private const long MaxUploadBytes = 512L * 1024 * 1024;

    private readonly EmbyUserDataImportService _importService;

    /// <summary>
    /// Initializes a new instance of the <see cref="EmbyImportController"/> class.
    /// </summary>
    /// <param name="importService">Import service.</param>
    public EmbyImportController(EmbyUserDataImportService importService)
    {
        _importService = importService;
    }

    /// <summary>
    /// Uploads Emby <c>library.db</c> and <c>users.db</c> for a one-shot import session.
    /// </summary>
    /// <param name="libraryDb">Emby library database.</param>
    /// <param name="usersDb">Emby users database.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Session id and Emby users.</returns>
    [HttpPost("Upload")]
    [RequestSizeLimit(MaxUploadBytes)]
    [RequestFormLimits(MultipartBodyLengthLimit = MaxUploadBytes)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<EmbyImportUploadResponse>> Upload(
        IFormFile? libraryDb,
        IFormFile? usersDb,
        CancellationToken cancellationToken)
    {
        if (!TryGetCallerUserId(out var callerUserId))
        {
            return Forbid();
        }

        if (libraryDb is null || libraryDb.Length == 0)
        {
            return BadRequest("library.db is required.");
        }

        if (usersDb is null || usersDb.Length == 0)
        {
            return BadRequest("users.db is required.");
        }

        try
        {
            await using var libraryStream = libraryDb.OpenReadStream();
            await using var usersStream = usersDb.OpenReadStream();
            var (sessionId, users) = await _importService
                .UploadAsync(libraryStream, usersStream, callerUserId, cancellationToken)
                .ConfigureAwait(false);

            return Ok(new EmbyImportUploadResponse
            {
                SessionId = sessionId,
                Users = users,
            });
        }
        catch (EmbyImportException ex)
        {
            return BadRequest(ex.Message);
        }
    }

    /// <summary>
    /// Previews importing selected Emby users into one Jellyfin user.
    /// </summary>
    /// <param name="request">Import request.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Preview counts.</returns>
    [HttpPost("Preview")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<EmbyImportResponse>> Preview(
        [FromBody] EmbyImportRequest? request,
        CancellationToken cancellationToken)
    {
        if (!TryGetCallerUserId(out var callerUserId))
        {
            return Forbid();
        }

        if (request is null)
        {
            return BadRequest("Request body is required.");
        }

        try
        {
            var counts = await _importService
                .PreviewAsync(request.SessionId, request.EmbyUserIds, request.TargetUserId, callerUserId, cancellationToken)
                .ConfigureAwait(false);
            return Ok(new EmbyImportResponse
            {
                IsPreview = true,
                Counts = counts,
            });
        }
        catch (EmbyImportException ex)
        {
            return BadRequest(ex.Message);
        }
    }

    /// <summary>
    /// Imports selected Emby users into one Jellyfin user and discards the session.
    /// </summary>
    /// <param name="request">Import request.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Result counts.</returns>
    [HttpPost("Execute")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<EmbyImportResponse>> Execute(
        [FromBody] EmbyImportRequest? request,
        CancellationToken cancellationToken)
    {
        if (!TryGetCallerUserId(out var callerUserId))
        {
            return Forbid();
        }

        if (request is null)
        {
            return BadRequest("Request body is required.");
        }

        try
        {
            var counts = await _importService
                .ExecuteAsync(request.SessionId, request.EmbyUserIds, request.TargetUserId, callerUserId, cancellationToken)
                .ConfigureAwait(false);
            return Ok(new EmbyImportResponse
            {
                IsPreview = false,
                Counts = counts,
            });
        }
        catch (EmbyImportException ex)
        {
            return BadRequest(ex.Message);
        }
    }

    /// <summary>
    /// Discards an upload session without importing.
    /// </summary>
    /// <param name="sessionId">Session id.</param>
    /// <returns>No content when removed.</returns>
    [HttpDelete("{sessionId}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public ActionResult Discard(string sessionId)
    {
        if (!TryGetCallerUserId(out var callerUserId))
        {
            return Forbid();
        }

        if (!_importService.Discard(sessionId, callerUserId))
        {
            return NotFound();
        }

        return NoContent();
    }

    private bool TryGetCallerUserId(out Guid userId)
    {
        var claim = User.FindFirst(c => c.Type.Equals(UserIdClaim, StringComparison.OrdinalIgnoreCase))?.Value;
        if (string.IsNullOrWhiteSpace(claim) || !Guid.TryParse(claim, out userId) || userId == Guid.Empty)
        {
            userId = Guid.Empty;
            return false;
        }

        return true;
    }
}
