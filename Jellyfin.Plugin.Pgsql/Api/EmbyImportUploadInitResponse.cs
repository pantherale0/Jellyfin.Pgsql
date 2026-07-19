using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.Pgsql.Api;

/// <summary>
/// Response after starting a chunked Emby database upload.
/// </summary>
public sealed class EmbyImportUploadInitResponse
{
    /// <summary>
    /// Gets or sets the session id used for chunk uploads.
    /// </summary>
    [JsonPropertyName("sessionId")]
    public required string SessionId { get; set; }

    /// <summary>
    /// Gets or sets the maximum chunk size in bytes.
    /// </summary>
    [JsonPropertyName("chunkSizeBytes")]
    public int ChunkSizeBytes { get; set; }
}
