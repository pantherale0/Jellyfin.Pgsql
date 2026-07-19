using System.ComponentModel.DataAnnotations;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.Pgsql.Api;

/// <summary>
/// Request body for starting a chunked Emby database upload.
/// </summary>
public sealed class EmbyImportUploadInitRequest
{
    /// <summary>
    /// Gets or sets the declared size of <c>library.db</c> in bytes.
    /// </summary>
    [Required]
    [JsonPropertyName("libraryDbBytes")]
    public long LibraryDbBytes { get; set; }

    /// <summary>
    /// Gets or sets the declared size of <c>users.db</c> in bytes.
    /// </summary>
    [Required]
    [JsonPropertyName("usersDbBytes")]
    public long UsersDbBytes { get; set; }
}
