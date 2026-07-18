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
    private const float AffinityWeightGate = 0.12f;

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
    /// <param name="affinityHints">Optional resolved affinity labels for the blurb.</param>
    /// <returns>Persona result.</returns>
    public TastePersonaResult Generate(
        Guid userId,
        UserTasteFeaturePayload? payload,
        int sampleCount,
        DateTime updatedAt,
        int minSamples,
        TasteAffinityHints? affinityHints = null)
    {
        if (payload is null || sampleCount < minSamples || payload.Genres.Count == 0)
        {
            return new TastePersonaResult(
                Code: "calibrating",
                Title: "Still Calibrating",
                Blurb: "Keep watching and favoriting movies — your taste portrait fills in as Jellyfin learns what you like.",
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

        var blurb = BuildBlurb(
            domainKey,
            barKey,
            loyaltyKey,
            specialist,
            sampleCount,
            payload,
            affinityHints ?? new TasteAffinityHints(),
            rng);
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
        string domainKey,
        string? barKey,
        string? loyaltyKey,
        bool specialist,
        int sampleCount,
        UserTasteFeaturePayload payload,
        TasteAffinityHints hints,
        Random rng)
    {
        var pack = TastePersonaVibePacks.ForDomain(domainKey);
        var sentences = new List<string>(4);

        var opener = Pick(pack.Openers, rng)
            .Replace("{n}", sampleCount.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal);
        sentences.Add(opener);

        if (payload.RatingP25 is float p25 && payload.RatingP75 is float p75)
        {
            var ratingPool = barKey switch
            {
                "selective" => TastePersonaVibePacks.SelectiveRatingLines,
                "wildcard" => TastePersonaVibePacks.WildcardRatingLines,
                _ => TastePersonaVibePacks.EverymanRatingLines
            };
            var lo = p25.ToString("0.0", CultureInfo.InvariantCulture);
            var hi = p75.ToString("0.0", CultureInfo.InvariantCulture);
            sentences.Add(
                Pick(ratingPool, rng)
                    .Replace("{lo}", lo, StringComparison.Ordinal)
                    .Replace("{hi}", hi, StringComparison.Ordinal));
        }

        var affinity = TryBuildAffinitySentence(payload, loyaltyKey, hints, rng);
        if (affinity is not null)
        {
            sentences.Add(affinity);
        }

        if (rng.NextDouble() < 0.5)
        {
            var closerPool = specialist ? pack.CommitLines.Concat(pack.Closers).ToArray() : pack.Closers;
            sentences.Add(Pick(closerPool, rng));
        }
        else if (specialist && sentences.Count < 3)
        {
            sentences.Add(Pick(pack.CommitLines, rng));
        }

        while (sentences.Count > 4)
        {
            sentences.RemoveAt(sentences.Count - 1);
        }

        return string.Join(' ', sentences);
    }

    private static string? TryBuildAffinitySentence(
        UserTasteFeaturePayload payload,
        string? loyaltyKey,
        TasteAffinityHints hints,
        Random rng)
    {
        var candidates = new List<(string Kind, string Value)>();

        var tag = ResolveTopWeight(payload.Tags, hints.TopTag);
        if (tag is not null)
        {
            candidates.Add(("tag", tag));
        }

        var studio = ResolveTopWeight(payload.Studios, hints.TopStudio);
        if (studio is not null)
        {
            candidates.Add(("studio", studio));
        }

        if (loyaltyKey is not null
            && !string.IsNullOrWhiteSpace(hints.TopPersonName))
        {
            candidates.Add(("person", hints.TopPersonName.Trim()));
        }

        if (candidates.Count == 0)
        {
            return null;
        }

        var pick = candidates[rng.Next(candidates.Count)];
        if (pick.Kind == "person")
        {
            return Pick(TastePersonaVibePacks.PersonAffinityLines, rng)
                .Replace("{name}", pick.Value, StringComparison.Ordinal);
        }

        var label = CultureInfo.InvariantCulture.TextInfo.ToTitleCase(pick.Value.ToLowerInvariant());
        return Pick(TastePersonaVibePacks.TagStudioAffinityLines, rng)
            .Replace("{label}", label, StringComparison.Ordinal);
    }

    private static string? ResolveTopWeight(Dictionary<string, float> weights, string? hintLabel)
    {
        if (!string.IsNullOrWhiteSpace(hintLabel))
        {
            return hintLabel.Trim();
        }

        if (weights.Count == 0)
        {
            return null;
        }

        var top = weights.OrderByDescending(kvp => kvp.Value).First();
        return top.Value >= AffinityWeightGate ? top.Key : null;
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
        foreach (var key in payload.Tags
                     .OrderByDescending(t => t.Value)
                     .Take(3)
                     .Select(t => NormalizeGenreKey(t.Key))
                     .Where(key => MoodPools.ContainsKey(key) && !key.Equals("default", StringComparison.Ordinal)))
        {
            return key;
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
        foreach (var p in genres.Values.Select(weight => weight / sum).Where(p => p > 0))
        {
            entropy -= p * Math.Log(p + 1e-12, 2);
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
