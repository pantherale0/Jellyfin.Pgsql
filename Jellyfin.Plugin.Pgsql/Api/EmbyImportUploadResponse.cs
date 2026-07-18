using System.Collections.Generic;
using System.Text.Json.Serialization;
using Jellyfin.Plugin.Pgsql.Admin.EmbyImport;

namespace Jellyfin.Plugin.Pgsql.Api;

/// <summary>
/// Response after uploading Emby databases.
/// </summary>
public sealed class EmbyImportUploadResponse
{
    /// <summary>
    /// Gets or sets the session id used for preview/execute.
    /// </summary>
    [JsonPropertyName("sessionId")]
    public required string SessionId { get; set; }

    /// <summary>
    /// Gets or sets Emby users discovered in the upload.
    /// </summary>
    [JsonPropertyName("users")]
    public required IReadOnlyList<EmbyUserInfo> Users { get; set; }
}
