using System;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.Pgsql.Admin;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.Pgsql.Api;

/// <summary>
/// Administrator APIs for merging users and moving UserData.
/// </summary>
[ApiController]
[Authorize(Roles = AdministratorRole)]
[Route("Pgsql/Admin")]
public sealed class UserAdminController : ControllerBase
{
    private const string AdministratorRole = "Administrator";
    private const string UserIdClaim = "Jellyfin-UserId";
    private const string MergeMode = "merge";
    private const string MoveMode = "move";

    private const string UserDataCacheWarning =
        "Jellyfin's in-memory UserData cache may retain stale entries until natural eviction or a server restart.";

    private readonly UserMergeService _mergeService;
    private readonly MergePreviewTokens _previewTokens;

    /// <summary>
    /// Initializes a new instance of the <see cref="UserAdminController"/> class.
    /// </summary>
    /// <param name="mergeService">User merge service.</param>
    /// <param name="previewTokens">Preview token service.</param>
    public UserAdminController(UserMergeService mergeService, MergePreviewTokens previewTokens)
    {
        _mergeService = mergeService;
        _previewTokens = previewTokens;
    }

    /// <summary>
    /// Previews a full user merge without writing.
    /// </summary>
    /// <param name="request">Source and target users.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Preview counts.</returns>
    [HttpPost("Users/Merge/Preview")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status401Unauthorized)]
    public async Task<ActionResult<UserAdminTransferResponse>> PreviewMerge(
        [FromBody] UserAdminTransferRequest? request,
        CancellationToken cancellationToken)
    {
        if (request is null)
        {
            return BadRequest("Request body is required.");
        }

        if (!TryGetAdministratorId(out var administratorId))
        {
            return Unauthorized();
        }

        try
        {
            var counts = await _mergeService
                .PreviewMergeAsync(request.SourceUserId, request.TargetUserId, cancellationToken)
                .ConfigureAwait(false);
            return Ok(new UserAdminTransferResponse
            {
                IsPreview = true,
                Counts = counts,
                PreviewToken = _previewTokens.Issue(
                    administratorId,
                    request.SourceUserId,
                    request.TargetUserId,
                    MergeMode,
                    MergePreviewTokens.Fingerprint(counts)),
            });
        }
        catch (UserMergeException ex)
        {
            return BadRequest(ex.Message);
        }
    }

    /// <summary>
    /// Fully merges the source user into the target user and deletes the source.
    /// </summary>
    /// <param name="request">Source and target users.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Result counts.</returns>
    [HttpPost("Users/Merge")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<ActionResult<UserAdminTransferResponse>> Merge(
        [FromBody] UserAdminTransferRequest? request,
        CancellationToken cancellationToken)
    {
        if (request is null)
        {
            return BadRequest("Request body is required.");
        }

        if (string.IsNullOrWhiteSpace(request.PreviewToken))
        {
            return BadRequest("Preview the current user pair before merging.");
        }

        if (!TryGetAdministratorId(out var administratorId))
        {
            return Unauthorized();
        }

        try
        {
            var fingerprint = _previewTokens.Validate(
                request.PreviewToken,
                administratorId,
                request.SourceUserId,
                request.TargetUserId,
                MergeMode);
            var counts = await _mergeService
                .MergeAsync(request.SourceUserId, request.TargetUserId, fingerprint, cancellationToken)
                .ConfigureAwait(false);
            return Ok(new UserAdminTransferResponse
            {
                IsPreview = false,
                Counts = counts,
                Warning = UserDataCacheWarning,
            });
        }
        catch (UserMergeException ex)
        {
            return BadRequest(ex.Message);
        }
        catch (UserMergeConflictException ex)
        {
            return Conflict(ex.Message);
        }
    }

    /// <summary>
    /// Previews a UserData-only move without writing.
    /// </summary>
    /// <param name="request">Source and target users.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Preview counts.</returns>
    [HttpPost("Users/MoveUserData/Preview")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status401Unauthorized)]
    public async Task<ActionResult<UserAdminTransferResponse>> PreviewMoveUserData(
        [FromBody] UserAdminTransferRequest? request,
        CancellationToken cancellationToken)
    {
        if (request is null)
        {
            return BadRequest("Request body is required.");
        }

        if (!TryGetAdministratorId(out var administratorId))
        {
            return Unauthorized();
        }

        try
        {
            var counts = await _mergeService
                .PreviewMoveUserDataAsync(request.SourceUserId, request.TargetUserId, cancellationToken)
                .ConfigureAwait(false);
            return Ok(new UserAdminTransferResponse
            {
                IsPreview = true,
                Counts = counts,
                PreviewToken = _previewTokens.Issue(
                    administratorId,
                    request.SourceUserId,
                    request.TargetUserId,
                    MoveMode,
                    MergePreviewTokens.Fingerprint(counts)),
            });
        }
        catch (UserMergeException ex)
        {
            return BadRequest(ex.Message);
        }
    }

    /// <summary>
    /// Moves UserData from the source user to the target user without deleting the source.
    /// </summary>
    /// <param name="request">Source and target users.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Result counts.</returns>
    [HttpPost("Users/MoveUserData")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    [ProducesResponseType(StatusCodes.Status401Unauthorized)]
    [ProducesResponseType(StatusCodes.Status409Conflict)]
    public async Task<ActionResult<UserAdminTransferResponse>> MoveUserData(
        [FromBody] UserAdminTransferRequest? request,
        CancellationToken cancellationToken)
    {
        if (request is null)
        {
            return BadRequest("Request body is required.");
        }

        if (string.IsNullOrWhiteSpace(request.PreviewToken))
        {
            return BadRequest("Preview the current user pair before moving userdata.");
        }

        if (!TryGetAdministratorId(out var administratorId))
        {
            return Unauthorized();
        }

        try
        {
            var fingerprint = _previewTokens.Validate(
                request.PreviewToken,
                administratorId,
                request.SourceUserId,
                request.TargetUserId,
                MoveMode);
            var counts = await _mergeService
                .MoveUserDataAsync(request.SourceUserId, request.TargetUserId, fingerprint, cancellationToken)
                .ConfigureAwait(false);
            return Ok(new UserAdminTransferResponse
            {
                IsPreview = false,
                Counts = counts,
                Warning = UserDataCacheWarning,
            });
        }
        catch (UserMergeException ex)
        {
            return BadRequest(ex.Message);
        }
        catch (UserMergeConflictException ex)
        {
            return Conflict(ex.Message);
        }
    }

    private bool TryGetAdministratorId(out Guid administratorId)
    {
        var value = User.FindFirst(
            claim => claim.Type.Equals(UserIdClaim, StringComparison.OrdinalIgnoreCase))?.Value;
        return Guid.TryParse(value, out administratorId);
    }
}
