namespace Jellyfin.Plugin.Seerr.Models;

/// <summary>
/// Normalized media availability status for UI consumers.
/// </summary>
public enum SeerrMediaStatus
{
    /// <summary>No known availability / not requested.</summary>
    Unknown = 0,

    /// <summary>Request pending approval.</summary>
    Pending = 1,

    /// <summary>Download/processing in progress.</summary>
    Processing = 2,

    /// <summary>Some seasons or qualities available.</summary>
    PartiallyAvailable = 3,

    /// <summary>Fully available in the library.</summary>
    Available = 4,

    /// <summary>Marked deleted in Seerr.</summary>
    Deleted = 5
}
