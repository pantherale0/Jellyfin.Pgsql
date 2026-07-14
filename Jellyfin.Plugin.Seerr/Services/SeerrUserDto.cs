namespace Jellyfin.Plugin.Seerr.Services;

/// <summary>
/// Seerr user DTO used for username mapping.
/// </summary>
public sealed class SeerrUserDto
{
    /// <summary>
    /// Gets or sets the Seerr user id.
    /// </summary>
    public int Id { get; set; }

    /// <summary>
    /// Gets or sets the Seerr username.
    /// </summary>
    public string? Username { get; set; }

    /// <summary>
    /// Gets or sets the linked Jellyfin username.
    /// </summary>
    public string? JellyfinUsername { get; set; }

    /// <summary>
    /// Gets or sets the email address.
    /// </summary>
    public string? Email { get; set; }
}
