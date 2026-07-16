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

    private const string UserDataCacheWarning =
        "Jellyfin's in-memory UserData cache may retain stale entries until natural eviction or a server restart.";

    private readonly UserMergeService _mergeService;

    /// <summary>
    /// Initializes a new instance of the <see cref="UserAdminController"/> class.
    /// </summary>
    /// <param name="mergeService">User merge service.</param>
    public UserAdminController(UserMergeService mergeService)
    {
        _mergeService = mergeService;
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
    public async Task<ActionResult<UserAdminTransferResponse>> PreviewMerge(
        [FromBody] UserAdminTransferRequest? request,
        CancellationToken cancellationToken)
    {
        if (request is null)
        {
            return BadRequest("Request body is required.");
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
    public async Task<ActionResult<UserAdminTransferResponse>> Merge(
        [FromBody] UserAdminTransferRequest? request,
        CancellationToken cancellationToken)
    {
        if (request is null)
        {
            return BadRequest("Request body is required.");
        }

        try
        {
            var counts = await _mergeService
                .MergeAsync(request.SourceUserId, request.TargetUserId, cancellationToken)
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
    public async Task<ActionResult<UserAdminTransferResponse>> PreviewMoveUserData(
        [FromBody] UserAdminTransferRequest? request,
        CancellationToken cancellationToken)
    {
        if (request is null)
        {
            return BadRequest("Request body is required.");
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
    public async Task<ActionResult<UserAdminTransferResponse>> MoveUserData(
        [FromBody] UserAdminTransferRequest? request,
        CancellationToken cancellationToken)
    {
        if (request is null)
        {
            return BadRequest("Request body is required.");
        }

        try
        {
            var counts = await _mergeService
                .MoveUserDataAsync(request.SourceUserId, request.TargetUserId, cancellationToken)
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
    }
}
