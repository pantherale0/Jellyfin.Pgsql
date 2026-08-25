using System;
using System.Collections.Generic;
using System.Linq;

#pragma warning disable SA1402 // Source candidate/result records live next to the picker.

namespace Jellyfin.Plugin.Pgsql.Taste;

/// <summary>A movie eligible to become a Because you X baseline.</summary>
/// <param name="ItemId">Movie id.</param>
/// <param name="BoxSetIds">BoxSet parent ids, if any.</param>
public readonly record struct BecauseYouSourceCandidate(Guid ItemId, IReadOnlyList<Guid> BoxSetIds);

/// <summary>A chosen Because you X baseline.</summary>
/// <param name="ItemId">Movie id.</param>
/// <param name="Kind"><see cref="BecauseYouSourceKinds"/> value.</param>
public readonly record struct BecauseYouSource(Guid ItemId, string Kind);

/// <summary>
/// Picks a diverse set of Because you watched/liked baseline movies.
/// </summary>
public static class BecauseYouSourcePicker
{
    /// <summary>Maximum recently played sources to materialize.</summary>
    public const int MaxRecentlyPlayed = 12;

    /// <summary>Maximum liked/favorited sources to materialize (excluding already picked played).</summary>
    public const int MaxLiked = 8;

    /// <summary>Skip shared-BoxSet sources until at least this many are chosen.</summary>
    public const int MinSourcesBeforeFranchiseRepeat = 4;

    /// <summary>
    /// Selects recently played then liked sources with franchise diversity.
    /// </summary>
    /// <param name="playedInDateOrder">Played movies, newest first.</param>
    /// <param name="liked">Liked or favorited movies (any order).</param>
    /// <returns>Ordered sources to materialize.</returns>
    public static IReadOnlyList<BecauseYouSource> Pick(
        IReadOnlyList<BecauseYouSourceCandidate> playedInDateOrder,
        IReadOnlyList<BecauseYouSourceCandidate> liked)
    {
        ArgumentNullException.ThrowIfNull(playedInDateOrder);
        ArgumentNullException.ThrowIfNull(liked);

        var selected = new List<BecauseYouSource>(MaxRecentlyPlayed + MaxLiked);
        var selectedIds = new HashSet<Guid>();
        var usedBoxSets = new HashSet<Guid>();

        Append(playedInDateOrder, BecauseYouSourceKinds.RecentlyPlayed, MaxRecentlyPlayed, selected, selectedIds, usedBoxSets);
        Append(liked, BecauseYouSourceKinds.Liked, MaxLiked, selected, selectedIds, usedBoxSets);
        return selected;
    }

    private static void Append(
        IReadOnlyList<BecauseYouSourceCandidate> candidates,
        string kind,
        int max,
        List<BecauseYouSource> selected,
        HashSet<Guid> selectedIds,
        HashSet<Guid> usedBoxSets)
    {
        if (max <= 0 || candidates.Count == 0)
        {
            return;
        }

        var added = 0;
        var deferred = new List<BecauseYouSourceCandidate>();
        foreach (var candidate in candidates)
        {
            if (added >= max)
            {
                break;
            }

            if (candidate.ItemId == Guid.Empty || !selectedIds.Add(candidate.ItemId))
            {
                continue;
            }

            if (SharesFranchise(candidate, usedBoxSets)
                && selected.Count < MinSourcesBeforeFranchiseRepeat)
            {
                selectedIds.Remove(candidate.ItemId);
                deferred.Add(candidate);
                continue;
            }

            Accept(candidate, kind, selected, usedBoxSets);
            added++;
        }

        foreach (var candidate in deferred)
        {
            if (added >= max)
            {
                break;
            }

            if (!selectedIds.Add(candidate.ItemId))
            {
                continue;
            }

            Accept(candidate, kind, selected, usedBoxSets);
            added++;
        }
    }

    private static void Accept(
        BecauseYouSourceCandidate candidate,
        string kind,
        List<BecauseYouSource> selected,
        HashSet<Guid> usedBoxSets)
    {
        selected.Add(new BecauseYouSource(candidate.ItemId, kind));
        foreach (var boxSetId in candidate.BoxSetIds)
        {
            usedBoxSets.Add(boxSetId);
        }
    }

    private static bool SharesFranchise(BecauseYouSourceCandidate candidate, HashSet<Guid> usedBoxSets)
    {
        foreach (var boxSetId in candidate.BoxSetIds)
        {
            if (usedBoxSets.Contains(boxSetId))
            {
                return true;
            }
        }

        return false;
    }
}
