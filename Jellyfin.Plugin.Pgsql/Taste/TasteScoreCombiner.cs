using System;

namespace Jellyfin.Plugin.Pgsql.Taste;

/// <summary>
/// Blends linear taste bonus with a neural probability when serving is enabled.
/// </summary>
public static class TasteScoreCombiner
{
    /// <summary>Neural share of the blended bonus.</summary>
    public const float NeuralBlendAlpha = 0.5f;

    /// <summary>
    /// Combines linear bonus with an optional neural probability.
    /// </summary>
    /// <param name="linearBonus">Linear scorer bonus (already capped).</param>
    /// <param name="neuralProbability">Model probability 0…1, or null when unavailable.</param>
    /// <param name="useNeural">Whether neural serving is enabled.</param>
    /// <param name="maxBonus">Absolute cap.</param>
    /// <returns>Non-negative blended bonus.</returns>
    public static int Blend(int linearBonus, float? neuralProbability, bool useNeural, int maxBonus)
    {
        if (maxBonus <= 0)
        {
            return 0;
        }

        var linear = Math.Clamp(linearBonus, 0, maxBonus);
        if (!useNeural || neuralProbability is not float probability)
        {
            return linear;
        }

        probability = Math.Clamp(probability, 0f, 1f);
        var neuralBonus = (int)Math.Round(probability * maxBonus, MidpointRounding.AwayFromZero);
        var blended = (int)Math.Round(
            (NeuralBlendAlpha * neuralBonus) + ((1f - NeuralBlendAlpha) * linear),
            MidpointRounding.AwayFromZero);
        return Math.Clamp(blended, 0, maxBonus);
    }
}
