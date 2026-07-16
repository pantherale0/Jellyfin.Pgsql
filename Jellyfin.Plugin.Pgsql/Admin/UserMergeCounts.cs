namespace Jellyfin.Plugin.Pgsql.Admin;

/// <summary>
/// Row-count summary for a merge or UserData move preview/result.
/// </summary>
public sealed class UserMergeCounts
{
    /// <summary>
    /// Gets or sets UserData rows rewritten without field merge.
    /// </summary>
    public int UserDataMoved { get; set; }

    /// <summary>
    /// Gets or sets UserData rows that conflicted and were field-merged.
    /// </summary>
    public int UserDataMerged { get; set; }

    /// <summary>
    /// Gets or sets PlaybackActivity rows rewritten.
    /// </summary>
    public int PlaybackActivityMoved { get; set; }

    /// <summary>
    /// Gets or sets DisplayPreferences rows rewritten.
    /// </summary>
    public int DisplayPreferencesMoved { get; set; }

    /// <summary>
    /// Gets or sets DisplayPreferences rows dropped because the target already had them.
    /// </summary>
    public int DisplayPreferencesDropped { get; set; }

    /// <summary>
    /// Gets or sets ItemDisplayPreferences rows rewritten.
    /// </summary>
    public int ItemDisplayPreferencesMoved { get; set; }

    /// <summary>
    /// Gets or sets ItemDisplayPreferences rows dropped as duplicates.
    /// </summary>
    public int ItemDisplayPreferencesDropped { get; set; }

    /// <summary>
    /// Gets or sets CustomItemDisplayPreferences rows rewritten.
    /// </summary>
    public int CustomItemDisplayPreferencesMoved { get; set; }

    /// <summary>
    /// Gets or sets CustomItemDisplayPreferences rows dropped as duplicates.
    /// </summary>
    public int CustomItemDisplayPreferencesDropped { get; set; }

    /// <summary>
    /// Gets or sets Devices rows rewritten.
    /// </summary>
    public int DevicesMoved { get; set; }

    /// <summary>
    /// Gets or sets Devices deactivated as duplicates after the move.
    /// </summary>
    public int DevicesDeactivated { get; set; }

    /// <summary>
    /// Gets or sets Permissions rows dropped from the source.
    /// </summary>
    public int PermissionsDropped { get; set; }

    /// <summary>
    /// Gets or sets Preferences rows whose list values were unioned into the target.
    /// </summary>
    public int PreferencesUnioned { get; set; }

    /// <summary>
    /// Gets or sets Preferences rows dropped from the source.
    /// </summary>
    public int PreferencesDropped { get; set; }

    /// <summary>
    /// Gets or sets AccessSchedules rows dropped from the source.
    /// </summary>
    public int AccessSchedulesDropped { get; set; }

    /// <summary>
    /// Gets or sets ImageInfos rows dropped from the source.
    /// </summary>
    public int ImageInfosDropped { get; set; }

    /// <summary>
    /// Gets or sets ActivityLogs rows rewritten.
    /// </summary>
    public int ActivityLogsMoved { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether the source taste profile row was removed.
    /// </summary>
    public bool TasteProfileSourceRemoved { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether the target taste profile was rebuilt.
    /// </summary>
    public bool TasteProfileTargetRebuilt { get; set; }

    /// <summary>
    /// Gets or sets a value indicating whether the source user was deleted.
    /// </summary>
    public bool SourceUserDeleted { get; set; }
}
