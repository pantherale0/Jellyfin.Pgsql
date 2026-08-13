using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations;
using Microsoft.EntityFrameworkCore;

#pragma warning disable SA1402 // Companion engage snapshot types live in this file.

namespace Jellyfin.Plugin.Pgsql.Taste;

/// <summary>
/// For You impression → engage rate over a matured window.
/// </summary>
public static class TasteForYouEngageMetrics
{
    /// <summary>
    /// Computes matured impression→engage rate.
    /// </summary>
    /// <param name="context">Database context.</param>
    /// <param name="nowUtc">Current UTC time.</param>
    /// <param name="lookbackDays">History lookback.</param>
    /// <param name="windowDays">Engage window (and maturity age).</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Snapshot with rate and counts.</returns>
    public static async Task<TasteForYouEngageSnapshot> ComputeAsync(
        JellyfinDbContext context,
        DateTime nowUtc,
        int lookbackDays,
        int windowDays,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(context);
        windowDays = Math.Max(1, windowDays);
        lookbackDays = Math.Max(windowDays, lookbackDays);
        var matureBefore = nowUtc.AddDays(-windowDays);
        var lookbackStart = nowUtc.AddDays(-lookbackDays);

        var impressions = await context.UserTasteRecommendationImpressions.AsNoTracking()
            .Where(i => i.ServedAt >= lookbackStart && i.ServedAt <= matureBefore)
            .Select(i => new { i.UserId, i.ItemId, i.ServedAt })
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        var distinct = impressions
            .GroupBy(i => (i.UserId, i.ItemId))
            .Select(g => new TasteImpressionEngageRow(g.Key.UserId, g.Key.ItemId, g.Min(x => x.ServedAt)))
            .ToList();
        if (distinct.Count == 0)
        {
            return new TasteForYouEngageSnapshot(null, windowDays, 0, 0);
        }

        var userIds = distinct.Select(d => d.UserId).Distinct().ToList();
        var itemIds = distinct.Select(d => d.ItemId).Distinct().ToList();

        var userData = await context.UserData.AsNoTracking()
            .Where(ud => userIds.Contains(ud.UserId)
                && itemIds.Contains(ud.ItemId)
                && (ud.IsFavorite || ud.Likes == true || ud.Played || ud.PlayCount > 0 || ud.PlaybackPositionTicks > 0))
            .Select(ud => new TasteEngageEvent(ud.UserId, ud.ItemId, ud.LastPlayedDate))
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        var playback = await context.PlaybackActivity.AsNoTracking()
            .Where(p => userIds.Contains(p.UserId)
                && itemIds.Contains(p.ItemId)
                && p.PlayedTicks > 0
                && p.DatePlayed >= lookbackStart)
            .Select(p => new TasteEngageEvent(p.UserId, p.ItemId, p.DatePlayed))
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        return ComputeFromRows(distinct, userData, playback, windowDays);
    }

    /// <summary>
    /// Counts matured impression→engage from in-memory rows.
    /// </summary>
    /// <param name="impressions">Distinct impressions.</param>
    /// <param name="userData">UserData engagement events.</param>
    /// <param name="playback">Playback activity events.</param>
    /// <param name="windowDays">Engage window.</param>
    /// <returns>Snapshot with rate and counts.</returns>
    public static TasteForYouEngageSnapshot ComputeFromRows(
        IReadOnlyList<TasteImpressionEngageRow> impressions,
        IReadOnlyList<TasteEngageEvent> userData,
        IReadOnlyList<TasteEngageEvent> playback,
        int windowDays)
    {
        ArgumentNullException.ThrowIfNull(impressions);
        ArgumentNullException.ThrowIfNull(userData);
        ArgumentNullException.ThrowIfNull(playback);
        windowDays = Math.Max(1, windowDays);
        if (impressions.Count == 0)
        {
            return new TasteForYouEngageSnapshot(null, windowDays, 0, 0);
        }

        var engageCount = 0;
        foreach (var row in impressions)
        {
            var windowEnd = row.ServedAt.AddDays(windowDays);
            var udHit = userData.Any(ud =>
                ud.UserId == row.UserId
                && ud.ItemId == row.ItemId
                && ud.At is DateTime played
                && played.ToUniversalTime() >= row.ServedAt
                && played.ToUniversalTime() <= windowEnd);
            var pbHit = playback.Any(p =>
                p.UserId == row.UserId
                && p.ItemId == row.ItemId
                && p.At is DateTime played
                && played.ToUniversalTime() >= row.ServedAt
                && played.ToUniversalTime() <= windowEnd);
            if (udHit || pbHit)
            {
                engageCount++;
            }
        }

        var rate = engageCount / (double)impressions.Count;
        return new TasteForYouEngageSnapshot(rate, windowDays, impressions.Count, engageCount);
    }
}

/// <summary>
/// Snapshot of For You impression→engage metrics.
/// </summary>
/// <param name="Rate">Engage count / impression count, or null when no matured impressions.</param>
/// <param name="WindowDays">Window used.</param>
/// <param name="ImpressionCount">Matured distinct impressions.</param>
/// <param name="EngageCount">Impressions with later engagement in the window.</param>
public sealed record TasteForYouEngageSnapshot(
    double? Rate,
    int WindowDays,
    int ImpressionCount,
    int EngageCount);

/// <summary>
/// Distinct For You impression used for engage-rate calculation.
/// </summary>
/// <param name="UserId">User id.</param>
/// <param name="ItemId">Item id.</param>
/// <param name="ServedAt">Earliest serve time.</param>
public sealed record TasteImpressionEngageRow(Guid UserId, Guid ItemId, DateTime ServedAt);

/// <summary>
/// Engagement event timestamped at <see cref="At"/>.
/// </summary>
/// <param name="UserId">User id.</param>
/// <param name="ItemId">Item id.</param>
/// <param name="At">Event time, or null when unknown.</param>
public sealed record TasteEngageEvent(Guid UserId, Guid ItemId, DateTime? At);
