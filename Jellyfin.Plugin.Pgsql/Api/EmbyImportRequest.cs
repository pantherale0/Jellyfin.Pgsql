using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;

namespace Jellyfin.Plugin.Pgsql.Api;

/// <summary>
/// Request body for Emby UserData preview/execute.
/// </summary>
public sealed class EmbyImportRequest
{
    /// <summary>
    /// Gets or sets the upload session id.
    /// </summary>
    [Required]
    public required string SessionId { get; set; }

    /// <summary>
    /// Gets or sets the selected Emby user ids.
    /// </summary>
    [Required]
    [MinLength(1)]
    public required IReadOnlyList<int> EmbyUserIds { get; set; }

    /// <summary>
    /// Gets or sets the target Jellyfin user id.
    /// </summary>
    [Required]
    public Guid TargetUserId { get; set; }
}
