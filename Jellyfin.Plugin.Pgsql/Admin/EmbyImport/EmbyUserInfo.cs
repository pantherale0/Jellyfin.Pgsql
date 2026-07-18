using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.Pgsql.Admin.EmbyImport;

/// <summary>
/// An Emby user discovered from <c>users.db</c> / <c>library.db</c>.
/// </summary>
public sealed class EmbyUserInfo
{
    /// <summary>
    /// Gets the Emby internal user id (matches <c>UserDatas.userId</c>).
    /// </summary>
    [JsonPropertyName("id")]
    public required int Id { get; init; }

    /// <summary>
    /// Gets the display name.
    /// </summary>
    [JsonPropertyName("name")]
    public required string Name { get; init; }

    /// <summary>
    /// Gets the number of <c>UserDatas</c> rows for this user.
    /// </summary>
    [JsonPropertyName("userDataCount")]
    public required int UserDataCount { get; init; }
}
