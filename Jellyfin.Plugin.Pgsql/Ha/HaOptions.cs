using System;
using System.Globalization;

namespace Jellyfin.Plugin.Pgsql.Ha;

/// <summary>
/// Resolved active-standby HA options from environment variables.
/// </summary>
internal sealed class HaOptions
{
    /// <summary>
    /// Default PostgreSQL advisory lock key for instance leadership.
    /// </summary>
    public const long DefaultLockKey = 738462901;

    /// <summary>
    /// Advisory lock key used around EF migrations (distinct from leadership).
    /// </summary>
    public const long MigrationLockKey = 738462902;

    private static readonly Lazy<HaOptions> LazyCurrent = new(Resolve);

    /// <summary>
    /// Gets the resolved options for the current process.
    /// </summary>
    public static HaOptions Current => LazyCurrent.Value;

    /// <summary>
    /// Gets a value indicating whether active-standby HA is enabled.
    /// </summary>
    public bool Enabled { get; private init; }

    /// <summary>
    /// Gets the PostgreSQL advisory lock key for leadership.
    /// </summary>
    public long LockKey { get; private init; }

    /// <summary>
    /// Gets the leadership heartbeat interval.
    /// </summary>
    public TimeSpan Heartbeat { get; private init; }

    private static HaOptions Resolve()
    {
        var heartbeatSeconds = GetInt("Pgsql_HA_HEARTBEAT_SECONDS", 5);
        if (heartbeatSeconds < 1)
        {
            heartbeatSeconds = 1;
        }

        return new HaOptions
        {
            Enabled = GetBool("Pgsql_HA_ENABLED", false),
            LockKey = GetLong("Pgsql_HA_LOCK_KEY", DefaultLockKey),
            Heartbeat = TimeSpan.FromSeconds(heartbeatSeconds),
        };
    }

    private static bool GetBool(string variable, bool defaultValue)
    {
        var value = Environment.GetEnvironmentVariable(variable);
        return value is null ? defaultValue : value.Equals(bool.TrueString, StringComparison.OrdinalIgnoreCase);
    }

    private static int GetInt(string variable, int defaultValue)
    {
        var value = Environment.GetEnvironmentVariable(variable);
        return value is not null && int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed)
            ? parsed
            : defaultValue;
    }

    private static long GetLong(string variable, long defaultValue)
    {
        var value = Environment.GetEnvironmentVariable(variable);
        return value is not null && long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed)
            ? parsed
            : defaultValue;
    }
}
