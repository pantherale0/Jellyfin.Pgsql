using System;
using System.ComponentModel.DataAnnotations;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.Pgsql.Api;

/// <summary>
/// Request body for merge/move preview and execute endpoints.
/// </summary>
public sealed class UserAdminTransferRequest
{
    /// <summary>
    /// Gets or sets the source user id (data is taken from this user).
    /// </summary>
    [Required]
    public Guid SourceUserId { get; set; }

    /// <summary>
    /// Gets or sets the target user id (data is written to this user).
    /// </summary>
    [Required]
    public Guid TargetUserId { get; set; }

    /// <summary>
    /// Gets or sets the token returned by the matching preview.
    /// Required by execute endpoints and ignored by preview endpoints.
    /// </summary>
    [JsonPropertyName("previewToken")]
    public string? PreviewToken { get; set; }
}
