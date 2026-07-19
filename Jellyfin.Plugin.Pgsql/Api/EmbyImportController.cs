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
    private const long MaxChunkRequestBytes = EmbyImportSessionStore.ChunkSizeBytes + (2L * 1024 * 1024);

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
    /// Starts a chunked upload of Emby <c>library.db</c> and <c>users.db</c>.
    /// </summary>
    /// <param name="request">Declared file sizes.</param>
    /// <returns>Session id and chunk size.</returns>
    [HttpPost("Upload/Init")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public ActionResult<EmbyImportUploadInitResponse> InitUpload([FromBody] EmbyImportUploadInitRequest? request)
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
            var (sessionId, chunkSizeBytes) = _importService.InitUpload(
                request.LibraryDbBytes,
                request.UsersDbBytes,
                callerUserId);
            return Ok(new EmbyImportUploadInitResponse
            {
                SessionId = sessionId,
                ChunkSizeBytes = chunkSizeBytes,
            });
        }
        catch (EmbyImportException ex)
        {
            return BadRequest(ex.Message);
        }
    }

    /// <summary>
    /// Uploads one sequential chunk of an Emby database file.
    /// </summary>
    /// <param name="sessionId">Upload session id.</param>
    /// <param name="file">Target file: <c>libraryDb</c> or <c>usersDb</c>.</param>
    /// <param name="chunkIndex">Zero-based chunk index.</param>
    /// <param name="chunk">Chunk payload.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>No content when accepted.</returns>
    [HttpPut("Upload/Chunk")]
    [RequestSizeLimit(MaxChunkRequestBytes)]
    [RequestFormLimits(MultipartBodyLengthLimit = MaxChunkRequestBytes)]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<ActionResult> UploadChunk(
        [FromForm] string? sessionId,
        [FromForm] string? file,
        [FromForm] int chunkIndex,
        [FromForm] IFormFile? chunk,
        CancellationToken cancellationToken)
    {
        if (!TryGetCallerUserId(out var callerUserId))
        {
            return Forbid();
        }

        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return BadRequest("sessionId is required.");
        }

        if (!TryParseFileKind(file, out var fileKind))
        {
            return BadRequest("file must be libraryDb or usersDb.");
        }

        if (chunk is null || chunk.Length == 0)
        {
            return BadRequest("chunk is required.");
        }

        try
        {
            await using var stream = chunk.OpenReadStream();
            await _importService
                .AppendChunkAsync(
                    sessionId,
                    callerUserId,
                    fileKind,
                    chunkIndex,
                    stream,
                    chunk.Length,
                    cancellationToken)
                .ConfigureAwait(false);
            return NoContent();
        }
        catch (EmbyImportException ex)
        {
            return BadRequest(ex.Message);
        }
    }

    /// <summary>
    /// Finalizes a chunked upload and returns Emby users for selection.
    /// </summary>
    /// <param name="request">Session id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Session id and Emby users.</returns>
    [HttpPost("Upload/Complete")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<ActionResult<EmbyImportUploadResponse>> CompleteUpload(
        [FromBody] EmbyImportUploadCompleteRequest? request,
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
            var (sessionId, users) = await _importService
                .CompleteUploadAsync(request.SessionId, callerUserId, cancellationToken)
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

    private static bool TryParseFileKind(string? file, out EmbyUploadFileKind fileKind)
    {
        if (string.Equals(file, "libraryDb", StringComparison.OrdinalIgnoreCase))
        {
            fileKind = EmbyUploadFileKind.LibraryDb;
            return true;
        }

        if (string.Equals(file, "usersDb", StringComparison.OrdinalIgnoreCase))
        {
            fileKind = EmbyUploadFileKind.UsersDb;
            return true;
        }

        fileKind = default;
        return false;
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
