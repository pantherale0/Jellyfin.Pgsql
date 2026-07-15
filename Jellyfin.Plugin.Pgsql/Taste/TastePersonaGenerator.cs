using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;

namespace Jellyfin.Plugin.Pgsql.Taste;

/// <summary>
/// Compositional taste persona titles from profile axes + seeded synonym pools.
/// </summary>
public sealed class TastePersonaGenerator
{
    private static readonly Dictionary<string, string[]> DomainPools = new(StringComparer.OrdinalIgnoreCase)
    {
        ["action"] = ["Action", "Pulse", "Spectacle", "Adrenaline", "Kinetic"],
        ["adventure"] = ["Adventure", "Quest", "Trail", "Expedition"],
        ["comedy"] = ["Comedy", "Wit", "Comfort", "Laugh"],
        ["drama"] = ["Drama", "Stage", "Character", "Arc"],
        ["horror"] = ["Horror", "Shadow", "Dread", "Chill"],
        ["thriller"] = ["Thriller", "Tension", "Nerve", "Suspense"],
        ["sci-fi"] = ["Sci-Fi", "Cosmic", "Future", "Orbit"],
        ["science fiction"] = ["Sci-Fi", "Cosmic", "Future", "Orbit"],
        ["fantasy"] = ["Fantasy", "Myth", "Realm", "Enchanted"],
        ["romance"] = ["Romance", "Heart", "Chemistry", "Flame"],
        ["animation"] = ["Animation", "Frame", "Ink", "Toon"],
        ["documentary"] = ["Documentary", "Lens", "Fact", "Archive"],
        ["crime"] = ["Crime", "Heist", "Underworld", "Case"],
        ["mystery"] = ["Mystery", "Puzzle", "Clue", "Enigma"],
        ["war"] = ["War", "Front", "Campaign", "Battalion"],
        ["western"] = ["Western", "Frontier", "Dust", "Outlaw"],
        ["family"] = ["Family", "Hearth", "Kin", "Saturday"],
        ["music"] = ["Music", "Rhythm", "Melody", "Gig"],
        ["history"] = ["History", "Chronicle", "Epoch", "Archive"],
        ["default"] = ["Cinema", "Screen", "Reel", "Feature"],
    };

    private static readonly string[] SpecialistStances =
        ["Specialist", "Devotee", "Curator", "Aficionado", "Connoisseur"];

    private static readonly string[] OmnivoreStances =
        ["Omnivore", "Wanderer", "Sampler", "Explorer", "Rover", "Scout"];

    private static readonly string[] SelectiveBars =
        ["Selective", "Prestige", "Critic's", "Discerning"];

    private static readonly string[] EverymanBars =
        ["Everyman", "Crowd", "Popular", "Easygoing"];

    private static readonly string[] WildcardBars =
        ["Wildcard", "Chaos", "Unpredictable", "Maverick"];

    private static readonly string[] LoyaltyRoles =
        ["Tracker", "Disciple", "Follower", "Stalker", "Chronicler"];

    private static readonly Dictionary<string, string[]> MoodPools = new(StringComparer.OrdinalIgnoreCase)
    {
        ["noir"] = ["After Hours", "Neon", "Noir"],
        ["feel-good"] = ["Sunday", "Cozy", "Warm"],
        ["feel good"] = ["Sunday", "Cozy", "Warm"],
        ["dark"] = ["Midnight", "Bleak", "Gritty"],
        ["classic"] = ["Vintage", "Timeless", "Retro"],
        ["default"] = ["Late Night", "Weekend", "Rainy Day"],
    };

    private static readonly string[] RareEpithets =
        ["Midnight Edition", "of the Prestige Tier", "Director’s Cut", "Deep Cut"];

    /// <summary>
    /// Builds a persona for the given profile snapshot.
    /// </summary>
    /// <param name="userId">User id (seeds stability).</param>
    /// <param name="payload">Feature payload.</param>
    /// <param name="sampleCount">Positive sample count.</param>
    /// <param name="updatedAt">Profile update time (UTC).</param>
    /// <param name="minSamples">Minimum samples for a calibrated persona.</param>
    /// <returns>Persona result.</returns>
    public TastePersonaResult Generate(
        Guid userId,
        UserTasteFeaturePayload? payload,
        int sampleCount,
        DateTime updatedAt,
        int minSamples)
    {
        if (payload is null || sampleCount < minSamples || payload.Genres.Count == 0)
        {
            return new TastePersonaResult(
                Code: "calibrating",
                Title: "Still Calibrating",
                Blurb: "Play and favorite a few movies, then run Rebuild user taste profiles.",
                Domain: null,
                Stance: "calibrating",
                Bar: null,
                Loyalty: null,
                Mood: null,
                Focus: "unknown");
        }

        var topGenres = payload.Genres
            .OrderByDescending(kvp => kvp.Value)
            .Take(3)
            .ToList();
        var domainKey = NormalizeGenreKey(topGenres[0].Key);
        var entropy = GenreEntropy(payload.Genres);
        var specialist = entropy < 1.35;
        var stanceKey = specialist ? "specialist" : "omnivore";
        var barKey = ResolveBar(payload);
        var peopleShare = payload.Directors.Values.Sum() + payload.Actors.Values.Sum();
        var loyaltyKey = peopleShare >= 0.35f ? "loyalty" : null;
        var moodKey = ResolveMood(payload, topGenres);

        var seed = StableSeed(userId, topGenres.Select(g => g.Key), updatedAt.Date);
        var rng = new Random(seed);

        var domainWord = Pick(DomainPools.GetValueOrDefault(domainKey) ?? DomainPools["default"], rng);
        var stanceWord = Pick(specialist ? SpecialistStances : OmnivoreStances, rng);
        string? barWord = barKey is null ? null : Pick(BarPool(barKey), rng);
        string? loyaltyWord = loyaltyKey is null ? null : Pick(LoyaltyRoles, rng);
        string? moodWord = moodKey is null ? null : Pick(MoodPools.GetValueOrDefault(moodKey) ?? MoodPools["default"], rng);

        string title;
        if (loyaltyWord is not null && rng.NextDouble() < 0.45)
        {
            title = $"{domainWord} {loyaltyWord}";
        }
        else if (moodWord is not null && rng.NextDouble() < 0.35)
        {
            title = $"{moodWord} {domainWord} {stanceWord}";
        }
        else if (barWord is not null)
        {
            title = $"{barWord} {domainWord} {stanceWord}";
        }
        else
        {
            title = $"{domainWord} {stanceWord}";
        }

        if (rng.NextDouble() < 0.10)
        {
            title = $"{title} — {Pick(RareEpithets, rng)}";
        }

        var blurb = BuildBlurb(topGenres, payload, sampleCount, specialist);
        var code = string.Create(
            CultureInfo.InvariantCulture,
            $"{domainKey}:{stanceKey}:{barKey ?? "none"}:{loyaltyKey ?? "none"}");

        return new TastePersonaResult(
            Code: code,
            Title: title,
            Blurb: blurb,
            Domain: domainKey,
            Stance: stanceKey,
            Bar: barKey,
            Loyalty: loyaltyKey,
            Mood: moodKey,
            Focus: specialist ? "specialist" : "omnivore");
    }

    private static string BuildBlurb(
        IReadOnlyList<KeyValuePair<string, float>> topGenres,
        UserTasteFeaturePayload payload,
        int sampleCount,
        bool specialist)
    {
        var genrePart = string.Join(
            " + ",
            topGenres.Take(2).Select(g => CultureInfo.InvariantCulture.TextInfo.ToTitleCase(g.Key)));
        var focusPart = specialist ? "Focused tastes" : "Broad tastes";
        var ratingPart = payload.RatingP25 is float p25 && payload.RatingP75 is float p75
            ? string.Create(CultureInfo.InvariantCulture, $" · ratings usually {p25:0.0}–{p75:0.0}")
            : string.Empty;
        return string.Create(
            CultureInfo.InvariantCulture,
            $"{focusPart} · heavy on {genrePart}{ratingPart} · {sampleCount} films shaping this");
    }

    private static string? ResolveBar(UserTasteFeaturePayload payload)
    {
        if (payload.RatingMean is not float mean)
        {
            return null;
        }

        if (mean >= 7.5f && payload.RatingP25 is float p25 && p25 >= 6.5f)
        {
            return "selective";
        }

        if (mean < 5.5f || (payload.RatingP75 is float p75 && payload.RatingP25 is float low && p75 - low > 3.5f))
        {
            return "wildcard";
        }

        return "everyman";
    }

    private static string? ResolveMood(
        UserTasteFeaturePayload payload,
        List<KeyValuePair<string, float>> topGenres)
    {
        foreach (var tag in payload.Tags.OrderByDescending(t => t.Value).Take(3))
        {
            var key = NormalizeGenreKey(tag.Key);
            if (MoodPools.ContainsKey(key) && !key.Equals("default", StringComparison.Ordinal))
            {
                return key;
            }
        }

        if (topGenres.Count > 1)
        {
            var secondary = NormalizeGenreKey(topGenres[1].Key);
            if (secondary is "horror" or "thriller" or "crime")
            {
                return "dark";
            }

            if (secondary is "comedy" or "family" or "romance")
            {
                return "feel-good";
            }
        }

        return null;
    }

    private static string[] BarPool(string barKey)
        => barKey switch
        {
            "selective" => SelectiveBars,
            "wildcard" => WildcardBars,
            _ => EverymanBars
        };

    private static string NormalizeGenreKey(string value)
    {
        var trimmed = value.Trim().ToLowerInvariant();
        if (trimmed is "sci fi" or "scifi")
        {
            return "sci-fi";
        }

        return trimmed;
    }

    private static double GenreEntropy(Dictionary<string, float> genres)
    {
        var sum = genres.Values.Sum();
        if (sum <= 0)
        {
            return 0;
        }

        double entropy = 0;
        foreach (var weight in genres.Values)
        {
            var p = weight / sum;
            if (p > 0)
            {
                entropy -= p * Math.Log(p + 1e-12, 2);
            }
        }

        return entropy;
    }

    private static int StableSeed(Guid userId, IEnumerable<string> topGenres, DateTime day)
    {
        var sb = new StringBuilder();
        sb.Append(userId.ToString("N"));
        sb.Append('|');
        sb.Append(day.ToString("yyyyMMdd", CultureInfo.InvariantCulture));
        foreach (var genre in topGenres)
        {
            sb.Append('|');
            sb.Append(genre.ToLowerInvariant());
        }

        unchecked
        {
            var hash = 17;
            foreach (var ch in sb.ToString())
            {
                hash = (hash * 31) + ch;
            }

            return hash;
        }
    }

    private static string Pick(string[] pool, Random rng)
        => pool[rng.Next(pool.Length)];
}
