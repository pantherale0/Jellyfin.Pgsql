using System;

namespace Jellyfin.Plugin.Pgsql.Taste;

/// <summary>
/// Episode→series binge weighting helpers.
/// </summary>
public static class TasteSeriesSignalWeights
{
    /// <summary>Base play weight for a series once any episode is played.</summary>
    public const float BaseSeriesPlayWeight = 1f;

    /// <summary>Maximum multiplier from distinct episode count (log2).</summary>
    public const float MaxBingeMultiplier = 2f;

    /// <summary>
    /// Computes play-derived weight for a series from distinct episode play count.
    /// </summary>
    /// <param name="distinctEpisodeCount">Distinct episodes with a play signal.</param>
    /// <returns>Capped binge-aware play weight.</returns>
    public static float BingeCappedPlayWeight(int distinctEpisodeCount)
    {
        if (distinctEpisodeCount <= 0)
        {
            return 0f;
        }

        var multiplier = (float)Math.Log2(1 + distinctEpisodeCount);
        return BaseSeriesPlayWeight * Math.Min(MaxBingeMultiplier, multiplier);
    }
}
