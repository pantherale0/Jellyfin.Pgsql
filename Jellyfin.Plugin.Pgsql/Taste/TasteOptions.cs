using System;
using System.Globalization;
using Jellyfin.Plugin.Pgsql.Configuration;

namespace Jellyfin.Plugin.Pgsql.Taste;

/// <summary>
/// Resolved taste-profile options. Environment variables take precedence over plugin configuration.
/// </summary>
internal sealed class TasteOptions
{
    private static readonly Lazy<TasteOptions> LazyCurrent = new(Resolve);

    /// <summary>
    /// Gets the resolved options for the current process.
    /// </summary>
    public static TasteOptions Current => LazyCurrent.Value;

    /// <summary>
    /// Gets a value indicating whether linear taste re-ranking and profile rebuild are enabled.
    /// </summary>
    public bool EnableTasteProfiles { get; private init; }

    /// <summary>
    /// Gets a value indicating whether the scheduled task should train a shadow model.
    /// </summary>
    public bool EnableNeuralShadowTraining { get; private init; }

    /// <summary>
    /// Gets a value indicating whether neural scores may affect live ranking (default false).
    /// </summary>
    public bool UseNeuralForServing { get; private init; }

    /// <summary>
    /// Gets how many days of history to include when building profiles.
    /// </summary>
    public int LookbackDays { get; private init; }

    /// <summary>
    /// Gets the minimum positive sample count required before applying a taste bonus.
    /// </summary>
    public int MinSamples { get; private init; }

    /// <summary>
    /// Gets the absolute max taste bonus applied on the linear serve path.
    /// </summary>
    public int MaxTasteBonus { get; private init; }

    /// <summary>
    /// Resolves options from environment and <see cref="PluginConfiguration"/>.
    /// </summary>
    /// <returns>Resolved options.</returns>
    public static TasteOptions Resolve()
    {
        var config = Plugin.Instance?.Configuration ?? new PluginConfiguration();

        return new TasteOptions
        {
            EnableTasteProfiles = ReadBool("Pgsql_TASTE_ENABLED", config.EnableTasteProfiles),
            EnableNeuralShadowTraining = ReadBool("Pgsql_TASTE_SHADOW_TRAIN", config.EnableNeuralShadowTraining),
            UseNeuralForServing = ReadBool("Pgsql_TASTE_NEURAL_SERVE", config.UseNeuralForServing),
            LookbackDays = ReadInt("Pgsql_TASTE_LOOKBACK_DAYS", config.TasteLookbackDays, 1, 3650),
            MinSamples = ReadInt("Pgsql_TASTE_MIN_SAMPLES", config.TasteMinSamples, 1, 1000),
            MaxTasteBonus = ReadInt("Pgsql_TASTE_MAX_BONUS", config.MaxTasteBonus, 0, 10_000),
        };
    }

    private static bool ReadBool(string envName, bool fallback)
    {
        var raw = Environment.GetEnvironmentVariable(envName);
        if (string.IsNullOrWhiteSpace(raw))
        {
            return fallback;
        }

        return raw.Equals("1", StringComparison.OrdinalIgnoreCase)
            || raw.Equals("true", StringComparison.OrdinalIgnoreCase)
            || raw.Equals("yes", StringComparison.OrdinalIgnoreCase);
    }

    private static int ReadInt(string envName, int fallback, int min, int max)
    {
        var raw = Environment.GetEnvironmentVariable(envName);
        if (string.IsNullOrWhiteSpace(raw)
            || !int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var value))
        {
            value = fallback;
        }

        return Math.Clamp(value, min, max);
    }
}
