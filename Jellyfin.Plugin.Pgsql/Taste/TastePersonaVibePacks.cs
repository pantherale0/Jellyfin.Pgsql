using System;
using System.Collections.Generic;

namespace Jellyfin.Plugin.Pgsql.Taste;

/// <summary>
/// Genre-specific chill vibe phrase packs for persona blurbs.
/// </summary>
internal static class TastePersonaVibePacks
{
    private static readonly TastePersonaVibePack DefaultPack = new(
        [
            "Out of {n} movies, you're carving out a taste that feels pretty you.",
            "From {n} films in the mix, your watchlist has a chill through-line.",
            "Out of {n} movies, you keep circling the stuff that just hits."
        ],
        [
            "You're not stuck in one lane — you're just honest about what clicks.",
            "When something lands, you lean all the way in."
        ],
        [
            "Wherever the good ones are hiding, you're usually early.",
            "Keep chasing what feels right — the portrait only gets clearer."
        ]);

    private static readonly Dictionary<string, TastePersonaVibePack> Packs = new(StringComparer.OrdinalIgnoreCase)
    {
        ["action"] = new(
            [
                "Out of {n} movies, you keep showing up for the set pieces.",
                "From {n} films, the kinetic stuff keeps finding you.",
                "Out of {n} movies, you're basically on team adrenaline."
            ],
            [
                "When it gets loud and kinetic, you're all in.",
                "You're here for the pulse — no apologies."
            ],
            [
                "Wherever the action is, you're already in the seat.",
                "Spectacle calls, and you pick up."
            ]),
        ["adventure"] = new(
            [
                "Out of {n} movies, you keep packing for the next quest.",
                "From {n} films, trail energy keeps winning.",
                "Out of {n} movies, the expedition vibes pull you in."
            ],
            [
                "You're soft for maps, myths, and getting a little lost.",
                "When the trail opens up, you're already walking it."
            ],
            [
                "Wherever the quest goes, you're tagging along.",
                "New horizons? You're already halfway there."
            ]),
        ["comedy"] = new(
            [
                "Out of {n} movies, you keep coming back for the laughs.",
                "From {n} films, comfort and wit keep winning the night.",
                "Out of {n} movies, you're basically running a good-mood club."
            ],
            [
                "When something's warm and funny, you're locked.",
                "You're here for the easy smiles — and that rules."
            ],
            [
                "Wherever the chuckles are, you've got front-row vibes.",
                "Keep the good mood going — you wear it well."
            ]),
        ["drama"] = new(
            [
                "Out of {n} movies, you keep leaning into character and arc.",
                "From {n} films, the emotional stage work keeps calling.",
                "Out of {n} movies, quiet intensity is kinda your thing."
            ],
            [
                "When the performances get real, you're all ears.",
                "You're soft for people stories that stick."
            ],
            [
                "Wherever the heart of the story is, you're already there.",
                "Big feelings, small frames — you get it."
            ]),
        ["horror"] = new(
            [
                "Out of {n} movies, you keep wandering into the dark.",
                "From {n} films, the dread has a standing invitation.",
                "Out of {n} movies, chill and shadows keep pulling you back."
            ],
            [
                "When it gets tense, you're all in.",
                "You're on friendly terms with a little fright."
            ],
            [
                "Wherever the dread is, you're already in the seat.",
                "Lights low, pulse up — that's your zone."
            ]),
        ["thriller"] = new(
            [
                "Out of {n} movies, you keep chasing the tension.",
                "From {n} films, nerve and suspense keep winning.",
                "Out of {n} movies, the edge-of-seat energy finds you."
            ],
            [
                "When the screws tighten, you lean closer.",
                "You're here for the grip — never bored."
            ],
            [
                "Wherever the suspense coils, you're already watching.",
                "A little pressure? That's your comfort food."
            ]),
        ["sci-fi"] = new(
            [
                "Out of {n} movies, you keep orbiting the weird and wondrous.",
                "From {n} films, cosmic ideas keep lighting you up.",
                "Out of {n} movies, the future-y stuff feels like home."
            ],
            [
                "When the big ideas drop, you're locked in.",
                "You're soft for orbits, tech, and what-ifs."
            ],
            [
                "Wherever the cosmos cracks open, you're peering in.",
                "Strange new worlds? Pull up a chair."
            ]),
        ["fantasy"] = new(
            [
                "Out of {n} movies, you keep slipping into other realms.",
                "From {n} films, myth and magic keep winning.",
                "Out of {n} movies, the enchanted stuff has your name on it."
            ],
            [
                "When the mythic turns up, you're gone in a good way.",
                "You're soft for wonder with a little dust on it."
            ],
            [
                "Wherever the realm unfolds, you're already packed.",
                "Enchanted nights suit you."
            ]),
        ["romance"] = new(
            [
                "Out of {n} movies, you keep chasing the spark.",
                "From {n} films, chemistry keeps stealing the night.",
                "Out of {n} movies, you're a little soft for the slow burn."
            ],
            [
                "You're soft for chemistry — and a little teasing about it.",
                "When the flirt energy shows up, so do you."
            ],
            [
                "Wherever the slow burn is, you're there for it.",
                "Hearts on sleeve? Kinda your brand."
            ]),
        ["animation"] = new(
            [
                "Out of {n} movies, you keep falling for frame and color.",
                "From {n} films, ink-and-light storytelling keeps winning.",
                "Out of {n} movies, the animated world is a second home."
            ],
            [
                "When the craft pops, you're grinning.",
                "You're soft for stories that move — literally."
            ],
            [
                "Wherever the frames sing, you're watching close.",
                "Drawn worlds, real feelings — that's the sweet spot."
            ]),
        ["documentary"] = new(
            [
                "Out of {n} movies, you keep chasing the real stories.",
                "From {n} films, the lens-on-truth stuff keeps calling.",
                "Out of {n} movies, facts with feeling are your jam."
            ],
            [
                "When something true hits hard, you stick with it.",
                "You're soft for archive energy and lived-in realities."
            ],
            [
                "Wherever the truth gets framed well, you're in.",
                "Curious mind, cozy couch — strong combo."
            ]),
        ["crime"] = new(
            [
                "Out of {n} movies, you keep sliding into the underworld.",
                "From {n} films, heist and case energy keeps winning.",
                "Out of {n} movies, the shady corners feel familiar."
            ],
            [
                "When the scheme tightens, you're locked.",
                "You're soft for clever crooks and colder streets."
            ],
            [
                "Wherever the case goes sideways, you're watching.",
                "Underworld nights suit your playlist."
            ]),
        ["mystery"] = new(
            [
                "Out of {n} movies, you keep hunting the next clue.",
                "From {n} films, puzzle vibes keep calling your name.",
                "Out of {n} movies, enigma mode is kinda default."
            ],
            [
                "When the riddle deepens, you lean in.",
                "You're soft for questions that won't sit still."
            ],
            [
                "Wherever the mystery thickens, you've got popcorn ready.",
                "Clues first, spoilers never — respect."
            ]),
        ["war"] = new(
            [
                "Out of {n} movies, you keep returning to the front.",
                "From {n} films, campaign stories keep landing.",
                "Out of {n} movies, battlefield gravity pulls you in."
            ],
            [
                "When the stakes get heavy, you stay with them.",
                "You're soft for grit, duty, and hard choices."
            ],
            [
                "Wherever the front line is drawn, you're watching.",
                "Heavy stories, steady attention — that's you."
            ]),
        ["western"] = new(
            [
                "Out of {n} movies, you keep riding into the dust.",
                "From {n} films, frontier energy keeps winning.",
                "Out of {n} movies, outlaw sunsets feel right."
            ],
            [
                "When the horizon stretches, you're gone.",
                "You're soft for dust, grit, and quiet legends."
            ],
            [
                "Wherever the frontier opens, you're on the trail.",
                "Wide skies, quiet stares — your vibe."
            ]),
        ["family"] = new(
            [
                "Out of {n} movies, you keep picking the warm ones.",
                "From {n} films, hearth-and-kin energy keeps winning.",
                "Out of {n} movies, Saturday softness is a whole mood."
            ],
            [
                "When it's cozy and kind, you're all in.",
                "You're soft for stories that feel like home."
            ],
            [
                "Wherever the hearth is glowing, you're settling in.",
                "Gentle nights, big hearts — that's the move."
            ]),
        ["music"] = new(
            [
                "Out of {n} movies, you keep chasing the rhythm.",
                "From {n} films, melody-forward stories keep winning.",
                "Out of {n} movies, gig energy finds you every time."
            ],
            [
                "When the soundtrack lifts, so do you.",
                "You're soft for stages, songs, and that live-wire feeling."
            ],
            [
                "Wherever the beat drops, you're already tapping along.",
                "Music on screen just hits different for you."
            ]),
        ["history"] = new(
            [
                "Out of {n} movies, you keep walking through other eras.",
                "From {n} films, chronicle vibes keep calling.",
                "Out of {n} movies, the past feels surprisingly cozy."
            ],
            [
                "When the epoch turns vivid, you're locked.",
                "You're soft for lived-in eras and careful detail."
            ],
            [
                "Wherever history gets cinematic, you're front row.",
                "Old worlds, fresh feelings — nice mix."
            ]),
        ["default"] = DefaultPack
    };

    /// <summary>
    /// Selective rating-band sentence templates with {lo} / {hi}.
    /// </summary>
    internal static readonly string[] SelectiveRatingLines =
    [
        "Most of what you dig sits between about {lo} and {hi} — a little picky, in a good way.",
        "Your sweet spot runs about {lo}–{hi}; you're not chasing everything that rates high."
    ];

    /// <summary>
    /// Everyman rating-band sentence templates with {lo} / {hi}.
    /// </summary>
    internal static readonly string[] EverymanRatingLines =
    [
        "Most of what you dig lands between about {lo} and {hi} — solid crowd-pleasers.",
        "You're usually hanging around {lo}–{hi}; easygoing and trustworthy tastes."
    ];

    /// <summary>
    /// Wildcard rating-band sentence templates with {lo} / {hi}.
    /// </summary>
    internal static readonly string[] WildcardRatingLines =
    [
        "Your range is wild — from about {lo} up to {hi}, you'll try just about anything.",
        "Ratings from {lo} to {hi}? Chaos mode, and somehow it works."
    ];

    /// <summary>
    /// Affinity lines for tags/studios with {label}.
    /// </summary>
    internal static readonly string[] TagStudioAffinityLines =
    [
        "A lot of that energy leans {label}.",
        "You keep circling stuff that feels {label}.",
        "{label} shows up a lot in your orbit."
    ];

    /// <summary>
    /// Affinity lines for people with {name}.
    /// </summary>
    internal static readonly string[] PersonAffinityLines =
    [
        "When {name} shows up, you're usually locked in.",
        "You're kind of following {name} around the catalog — respectfully.",
        "{name} keeps popping up in your favorites, and that tracks."
    ];

    /// <summary>
    /// Resolves a vibe pack for a normalized domain key.
    /// </summary>
    /// <param name="domainKey">Normalized genre key.</param>
    /// <returns>Vibe pack.</returns>
    internal static TastePersonaVibePack ForDomain(string domainKey)
    {
        if (domainKey.Equals("science fiction", StringComparison.OrdinalIgnoreCase))
        {
            domainKey = "sci-fi";
        }

        return Packs.GetValueOrDefault(domainKey, DefaultPack);
    }
}
