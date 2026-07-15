using System;

namespace Jellyfin.Plugin.Pgsql.Taste.Entities;

/// <summary>
/// Persisted per-user taste feature profile used for linear re-ranking and shadow training.
/// </summary>
public sealed class UserTasteProfile
{
    /// <summary>
    /// Gets or sets the user identifier (primary key).
    /// </summary>
    public Guid UserId { get; set; }

    /// <summary>
    /// Gets or sets the serialized feature payload (JSON).
    /// </summary>
    public string FeaturesJson { get; set; } = "{}";

    /// <summary>
    /// Gets or sets how many positively weighted history signals contributed to the profile.
    /// </summary>
    public int SampleCount { get; set; }

    /// <summary>
    /// Gets or sets when the profile was last rebuilt (UTC).
    /// </summary>
    public DateTime UpdatedAt { get; set; }
}
