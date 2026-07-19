using System.ComponentModel.DataAnnotations;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.Pgsql.Api;

/// <summary>
/// Request body for finalizing a chunked Emby database upload.
/// </summary>
public sealed class EmbyImportUploadCompleteRequest
{
    /// <summary>
    /// Gets or sets the upload session id.
    /// </summary>
    [Required]
    [JsonPropertyName("sessionId")]
    public required string SessionId { get; set; }
}
