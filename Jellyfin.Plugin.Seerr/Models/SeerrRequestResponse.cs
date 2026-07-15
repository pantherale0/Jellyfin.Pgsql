using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.Seerr.Models;

/// <summary>
/// Response after creating a request.
/// </summary>
public sealed class SeerrRequestResponse
{
    /// <summary>
    /// Gets or sets the Seerr request id when available.
    /// </summary>
    [JsonPropertyName("requestId")]
    public int? RequestId { get; set; }

    /// <summary>
    /// Gets or sets a human-readable status message.
    /// </summary>
    [JsonPropertyName("message")]
    public string Message { get; set; } = "Requested";
}
