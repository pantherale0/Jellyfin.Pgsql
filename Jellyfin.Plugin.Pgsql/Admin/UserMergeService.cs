using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.Pgsql.Query;
using Jellyfin.Plugin.Pgsql.Taste;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using LogLevel = Microsoft.Extensions.Logging.LogLevel;

namespace Jellyfin.Plugin.Pgsql.Admin;

/// <summary>
/// Merges or moves per-user database state between Jellyfin users.
/// </summary>
public sealed class UserMergeService
{
    private readonly IDbContextFactory<JellyfinDbContext> _dbProvider;
    private readonly IUserManager _userManager;
    private readonly UserTasteProfileBuilder _tasteBuilder;
    private readonly UserTasteProfileStore _tasteStore;
    private readonly IItemTypeLookup _itemTypeLookup;
    private readonly IServiceProvider _services;
    private readonly ILogger<UserMergeService> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="UserMergeService"/> class.
    /// </summary>
    /// <param name="dbProvider">Database context factory.</param>
    /// <param name="userManager">User manager.</param>
    /// <param name="tasteBuilder">Taste profile builder.</param>
    /// <param name="tasteStore">Taste profile cache.</param>
    /// <param name="itemTypeLookup">Item type name lookup.</param>
    /// <param name="services">Service provider (optional query cache).</param>
    /// <param name="logger">Logger.</param>
    public UserMergeService(
        IDbContextFactory<JellyfinDbContext> dbProvider,
        IUserManager userManager,
        UserTasteProfileBuilder tasteBuilder,
        UserTasteProfileStore tasteStore,
        IItemTypeLookup itemTypeLookup,
        IServiceProvider services,
        ILogger<UserMergeService> logger)
    {
        _dbProvider = dbProvider;
        _userManager = userManager;
        _tasteBuilder = tasteBuilder;
        _tasteStore = tasteStore;
        _itemTypeLookup = itemTypeLookup;
        _services = services;
        _logger = logger;
    }

    /// <summary>
    /// Builds a dry-run summary for a full user merge.
    /// </summary>
    /// <param name="sourceUserId">Source user id.</param>
    /// <param name="targetUserId">Target user id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Preview counts.</returns>
    public Task<UserMergeCounts> PreviewMergeAsync(
        Guid sourceUserId,
        Guid targetUserId,
        CancellationToken cancellationToken)
        => PreviewAsync(sourceUserId, targetUserId, fullMerge: true, cancellationToken);

    /// <summary>
    /// Builds a dry-run summary for a UserData-only move.
    /// </summary>
    /// <param name="sourceUserId">Source user id.</param>
    /// <param name="targetUserId">Target user id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Preview counts.</returns>
    public Task<UserMergeCounts> PreviewMoveUserDataAsync(
        Guid sourceUserId,
        Guid targetUserId,
        CancellationToken cancellationToken)
        => PreviewAsync(sourceUserId, targetUserId, fullMerge: false, cancellationToken);

    /// <summary>
    /// Fully merges <paramref name="sourceUserId"/> into <paramref name="targetUserId"/> and deletes the source user.
    /// </summary>
    /// <param name="sourceUserId">Source user id.</param>
    /// <param name="targetUserId">Target user id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Result counts.</returns>
    public async Task<UserMergeCounts> MergeAsync(
        Guid sourceUserId,
        Guid targetUserId,
        CancellationToken cancellationToken)
    {
        ValidateUsers(sourceUserId, targetUserId, requireSourceDeletable: true);

        var counts = new UserMergeCounts();
        var context = await _dbProvider.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
        await using (context.ConfigureAwait(false))
        {
            await using var transaction = await context.Database
                .BeginTransactionAsync(cancellationToken)
                .ConfigureAwait(false);

            await MoveUserDataCoreAsync(context, sourceUserId, targetUserId, counts, cancellationToken)
                .ConfigureAwait(false);
            await MovePlaybackActivityAsync(context, sourceUserId, targetUserId, counts, cancellationToken)
                .ConfigureAwait(false);
            await MoveDisplayPreferencesAsync(context, sourceUserId, targetUserId, counts, cancellationToken)
                .ConfigureAwait(false);
            await MoveItemDisplayPreferencesAsync(context, sourceUserId, targetUserId, counts, cancellationToken)
                .ConfigureAwait(false);
            await MoveCustomItemDisplayPreferencesAsync(context, sourceUserId, targetUserId, counts, cancellationToken)
                .ConfigureAwait(false);
            await MoveDevicesAsync(context, sourceUserId, targetUserId, counts, cancellationToken)
                .ConfigureAwait(false);
            await DropSourcePermissionsAsync(context, sourceUserId, counts, cancellationToken)
                .ConfigureAwait(false);
            await MergePreferencesAsync(context, sourceUserId, targetUserId, counts, cancellationToken)
                .ConfigureAwait(false);
            await DropSourceAccessSchedulesAsync(context, sourceUserId, counts, cancellationToken)
                .ConfigureAwait(false);
            await DropSourceImageInfosAsync(context, sourceUserId, counts, cancellationToken)
                .ConfigureAwait(false);
            await MoveActivityLogsAsync(context, sourceUserId, targetUserId, counts, cancellationToken)
                .ConfigureAwait(false);
            await RemoveSourceTasteProfileAsync(context, sourceUserId, counts, cancellationToken)
                .ConfigureAwait(false);
            await RemoveSourceTasteImpressionsAsync(context, sourceUserId, counts, cancellationToken)
                .ConfigureAwait(false);
            await RemoveSourceBecauseYouAsync(context, sourceUserId, cancellationToken)
                .ConfigureAwait(false);

            await context.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
        }

        try
        {
            await _userManager.DeleteUserAsync(sourceUserId).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException)
        {
            throw new UserMergeException(ex.Message, ex);
        }

        counts.SourceUserDeleted = true;

        await RebuildTargetTasteAsync(targetUserId, counts, cancellationToken).ConfigureAwait(false);
        InvalidateCaches();

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "Merged user {SourceUserId} into {TargetUserId} (UserData moved={Moved}, merged={Merged})",
                sourceUserId,
                targetUserId,
                counts.UserDataMoved,
                counts.UserDataMerged);
        }

        return counts;
    }

    /// <summary>
    /// Moves UserData from <paramref name="sourceUserId"/> to <paramref name="targetUserId"/> without deleting the source.
    /// </summary>
    /// <param name="sourceUserId">Source user id.</param>
    /// <param name="targetUserId">Target user id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Result counts.</returns>
    public async Task<UserMergeCounts> MoveUserDataAsync(
        Guid sourceUserId,
        Guid targetUserId,
        CancellationToken cancellationToken)
    {
        ValidateUsers(sourceUserId, targetUserId, requireSourceDeletable: false);

        var counts = new UserMergeCounts();
        var context = await _dbProvider.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
        await using (context.ConfigureAwait(false))
        {
            await using var transaction = await context.Database
                .BeginTransactionAsync(cancellationToken)
                .ConfigureAwait(false);

            await MoveUserDataCoreAsync(context, sourceUserId, targetUserId, counts, cancellationToken)
                .ConfigureAwait(false);
            await context.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
        }

        await RebuildTargetTasteAsync(targetUserId, counts, cancellationToken).ConfigureAwait(false);
        InvalidateCaches();

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "Moved UserData from {SourceUserId} to {TargetUserId} (moved={Moved}, merged={Merged})",
                sourceUserId,
                targetUserId,
                counts.UserDataMoved,
                counts.UserDataMerged);
        }

        return counts;
    }

    private async Task<UserMergeCounts> PreviewAsync(
        Guid sourceUserId,
        Guid targetUserId,
        bool fullMerge,
        CancellationToken cancellationToken)
    {
        ValidateUsers(sourceUserId, targetUserId, requireSourceDeletable: fullMerge);

        var counts = new UserMergeCounts();
        var context = await _dbProvider.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
        await using (context.ConfigureAwait(false))
        {
            var sourceKeys = await context.UserData.AsNoTracking()
                .Where(u => u.UserId == sourceUserId)
                .Select(u => new { u.ItemId, u.CustomDataKey })
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);
            var targetKeySet = (await context.UserData.AsNoTracking()
                    .Where(u => u.UserId == targetUserId)
                    .Select(u => new { u.ItemId, u.CustomDataKey })
                    .ToListAsync(cancellationToken)
                    .ConfigureAwait(false))
                .Select(k => (k.ItemId, k.CustomDataKey))
                .ToHashSet();

            foreach (var key in sourceKeys)
            {
                if (targetKeySet.Contains((key.ItemId, key.CustomDataKey)))
                {
                    counts.UserDataMerged++;
                }
                else
                {
                    counts.UserDataMoved++;
                }
            }

            if (!fullMerge)
            {
                return counts;
            }

            counts.PlaybackActivityMoved = await context.PlaybackActivity.AsNoTracking()
                .CountAsync(p => p.UserId == sourceUserId, cancellationToken)
                .ConfigureAwait(false);

            var sourceDisplay = await context.DisplayPreferences.AsNoTracking()
                .Where(d => d.UserId == sourceUserId)
                .Select(d => new { d.ItemId, d.Client })
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);
            var targetDisplay = (await context.DisplayPreferences.AsNoTracking()
                    .Where(d => d.UserId == targetUserId)
                    .Select(d => new { d.ItemId, d.Client })
                    .ToListAsync(cancellationToken)
                    .ConfigureAwait(false))
                .Select(d => (d.ItemId, d.Client))
                .ToHashSet();
            foreach (var row in sourceDisplay)
            {
                if (targetDisplay.Contains((row.ItemId, row.Client)))
                {
                    counts.DisplayPreferencesDropped++;
                }
                else
                {
                    counts.DisplayPreferencesMoved++;
                }
            }

            var sourceItemDisplay = await context.ItemDisplayPreferences.AsNoTracking()
                .Where(d => d.UserId == sourceUserId)
                .Select(d => new { d.ItemId, d.Client })
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);
            var targetItemDisplay = (await context.ItemDisplayPreferences.AsNoTracking()
                    .Where(d => d.UserId == targetUserId)
                    .Select(d => new { d.ItemId, d.Client })
                    .ToListAsync(cancellationToken)
                    .ConfigureAwait(false))
                .Select(d => (d.ItemId, d.Client))
                .ToHashSet();
            foreach (var row in sourceItemDisplay)
            {
                if (targetItemDisplay.Contains((row.ItemId, row.Client)))
                {
                    counts.ItemDisplayPreferencesDropped++;
                }
                else
                {
                    counts.ItemDisplayPreferencesMoved++;
                }
            }

            var sourceCustom = await context.CustomItemDisplayPreferences.AsNoTracking()
                .Where(d => d.UserId == sourceUserId)
                .Select(d => new { d.ItemId, d.Client, d.Key })
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);
            var targetCustom = (await context.CustomItemDisplayPreferences.AsNoTracking()
                    .Where(d => d.UserId == targetUserId)
                    .Select(d => new { d.ItemId, d.Client, d.Key })
                    .ToListAsync(cancellationToken)
                    .ConfigureAwait(false))
                .Select(d => (d.ItemId, d.Client, d.Key))
                .ToHashSet();
            foreach (var row in sourceCustom)
            {
                if (targetCustom.Contains((row.ItemId, row.Client, row.Key)))
                {
                    counts.CustomItemDisplayPreferencesDropped++;
                }
                else
                {
                    counts.CustomItemDisplayPreferencesMoved++;
                }
            }

            counts.DevicesMoved = await context.Devices.AsNoTracking()
                .CountAsync(d => d.UserId == sourceUserId, cancellationToken)
                .ConfigureAwait(false);

            var sourceDeviceIds = await context.Devices.AsNoTracking()
                .Where(d => d.UserId == sourceUserId)
                .Select(d => d.DeviceId)
                .Distinct()
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);
            var targetDeviceIds = (await context.Devices.AsNoTracking()
                    .Where(d => d.UserId == targetUserId)
                    .Select(d => d.DeviceId)
                    .Distinct()
                    .ToListAsync(cancellationToken)
                    .ConfigureAwait(false))
                .ToHashSet(StringComparer.Ordinal);
            counts.DevicesDeactivated = sourceDeviceIds.Count(id => targetDeviceIds.Contains(id));

            counts.PermissionsDropped = await context.Permissions.AsNoTracking()
                .CountAsync(p => p.UserId == sourceUserId, cancellationToken)
                .ConfigureAwait(false);

            var sourcePrefs = await context.Preferences.AsNoTracking()
                .Where(p => p.UserId == sourceUserId)
                .Select(p => p.Kind)
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);
            var targetPrefKinds = (await context.Preferences.AsNoTracking()
                    .Where(p => p.UserId == targetUserId)
                    .Select(p => p.Kind)
                    .ToListAsync(cancellationToken)
                    .ConfigureAwait(false))
                .ToHashSet();
            foreach (var kind in sourcePrefs)
            {
                counts.PreferencesUnioned++;
                if (targetPrefKinds.Contains(kind))
                {
                    counts.PreferencesDropped++;
                }
            }

            counts.AccessSchedulesDropped = await context.AccessSchedules.AsNoTracking()
                .CountAsync(a => a.UserId == sourceUserId, cancellationToken)
                .ConfigureAwait(false);
            counts.ImageInfosDropped = await context.ImageInfos.AsNoTracking()
                .CountAsync(i => i.UserId == sourceUserId, cancellationToken)
                .ConfigureAwait(false);
            counts.ActivityLogsMoved = await context.ActivityLogs.AsNoTracking()
                .CountAsync(a => a.UserId == sourceUserId, cancellationToken)
                .ConfigureAwait(false);
            counts.TasteProfileSourceRemoved = await context.UserTasteProfiles.AsNoTracking()
                .AnyAsync(p => p.UserId == sourceUserId, cancellationToken)
                .ConfigureAwait(false);
            counts.SourceUserDeleted = true;
        }

        return counts;
    }

    private void ValidateUsers(Guid sourceUserId, Guid targetUserId, bool requireSourceDeletable)
    {
        if (sourceUserId == Guid.Empty || targetUserId == Guid.Empty)
        {
            throw new UserMergeException("Source and target user ids are required.");
        }

        if (sourceUserId.Equals(targetUserId))
        {
            throw new UserMergeException("Source and target users must be different.");
        }

        var source = _userManager.GetUserById(sourceUserId)
            ?? throw new UserMergeException($"Source user '{sourceUserId}' was not found.");
        var target = _userManager.GetUserById(targetUserId)
            ?? throw new UserMergeException($"Target user '{targetUserId}' was not found.");

        if (!requireSourceDeletable)
        {
            return;
        }

        var users = _userManager.GetUsers().ToList();
        if (users.Count <= 1)
        {
            throw new UserMergeException(
                string.Format(
                    CultureInfo.InvariantCulture,
                    "The user '{0}' cannot be merged away because there must be at least one user in the system.",
                    source.Username));
        }

        if (source.HasPermission(PermissionKind.IsAdministrator)
            && !target.HasPermission(PermissionKind.IsAdministrator)
            && users.Count(u => u.HasPermission(PermissionKind.IsAdministrator)) == 1)
        {
            throw new UserMergeException(
                string.Format(
                    CultureInfo.InvariantCulture,
                    "The user '{0}' is the last administrator and cannot be merged into a non-administrator.",
                    source.Username));
        }
    }

    private static async Task MoveUserDataCoreAsync(
        JellyfinDbContext context,
        Guid sourceUserId,
        Guid targetUserId,
        UserMergeCounts counts,
        CancellationToken cancellationToken)
    {
        var sourceRows = await context.UserData
            .Where(u => u.UserId == sourceUserId)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        if (sourceRows.Count == 0)
        {
            return;
        }

        var targetRows = await context.UserData
            .Where(u => u.UserId == targetUserId)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        var targetMap = targetRows.ToDictionary(u => (u.ItemId, u.CustomDataKey));

        foreach (var source in sourceRows)
        {
            var key = (source.ItemId, source.CustomDataKey);
            if (targetMap.TryGetValue(key, out var target))
            {
                UserDataMergeRules.MergeInto(target, source);
                context.UserData.Remove(source);
                counts.UserDataMerged++;
            }
            else
            {
                context.UserData.Remove(source);
                var moved = new UserData
                {
                    ItemId = source.ItemId,
                    UserId = targetUserId,
                    CustomDataKey = source.CustomDataKey,
                    Item = null,
                    User = null,
                    Rating = source.Rating,
                    PlaybackPositionTicks = source.PlaybackPositionTicks,
                    PlayCount = source.PlayCount,
                    IsFavorite = source.IsFavorite,
                    LastPlayedDate = source.LastPlayedDate,
                    Played = source.Played,
                    AudioStreamIndex = source.AudioStreamIndex,
                    SubtitleStreamIndex = source.SubtitleStreamIndex,
                    Likes = source.Likes,
                    RetentionDate = source.RetentionDate,
                };
                context.UserData.Add(moved);
                targetMap[key] = moved;
                counts.UserDataMoved++;
            }
        }
    }

    private static async Task MovePlaybackActivityAsync(
        JellyfinDbContext context,
        Guid sourceUserId,
        Guid targetUserId,
        UserMergeCounts counts,
        CancellationToken cancellationToken)
    {
        counts.PlaybackActivityMoved = await context.PlaybackActivity
            .Where(p => p.UserId == sourceUserId)
            .ExecuteUpdateAsync(
                setters => setters.SetProperty(p => p.UserId, targetUserId),
                cancellationToken)
            .ConfigureAwait(false);
    }

    private static async Task MoveDisplayPreferencesAsync(
        JellyfinDbContext context,
        Guid sourceUserId,
        Guid targetUserId,
        UserMergeCounts counts,
        CancellationToken cancellationToken)
    {
        var sourceRows = await context.DisplayPreferences
            .Include(d => d.HomeSections)
            .Where(d => d.UserId == sourceUserId)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        var targetKeys = (await context.DisplayPreferences
                .Where(d => d.UserId == targetUserId)
                .Select(d => new { d.ItemId, d.Client })
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false))
            .Select(d => (d.ItemId, d.Client))
            .ToHashSet();

        foreach (var row in sourceRows)
        {
            if (targetKeys.Contains((row.ItemId, row.Client)))
            {
                context.DisplayPreferences.Remove(row);
                counts.DisplayPreferencesDropped++;
            }
            else
            {
                row.UserId = targetUserId;
                counts.DisplayPreferencesMoved++;
            }
        }
    }

    private static async Task MoveItemDisplayPreferencesAsync(
        JellyfinDbContext context,
        Guid sourceUserId,
        Guid targetUserId,
        UserMergeCounts counts,
        CancellationToken cancellationToken)
    {
        var sourceRows = await context.ItemDisplayPreferences
            .Where(d => d.UserId == sourceUserId)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        var targetKeys = (await context.ItemDisplayPreferences
                .Where(d => d.UserId == targetUserId)
                .Select(d => new { d.ItemId, d.Client })
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false))
            .Select(d => (d.ItemId, d.Client))
            .ToHashSet();

        foreach (var row in sourceRows)
        {
            if (targetKeys.Contains((row.ItemId, row.Client)))
            {
                context.ItemDisplayPreferences.Remove(row);
                counts.ItemDisplayPreferencesDropped++;
            }
            else
            {
                row.UserId = targetUserId;
                counts.ItemDisplayPreferencesMoved++;
            }
        }
    }

    private static async Task MoveCustomItemDisplayPreferencesAsync(
        JellyfinDbContext context,
        Guid sourceUserId,
        Guid targetUserId,
        UserMergeCounts counts,
        CancellationToken cancellationToken)
    {
        var sourceRows = await context.CustomItemDisplayPreferences
            .Where(d => d.UserId == sourceUserId)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        var targetKeys = (await context.CustomItemDisplayPreferences
                .Where(d => d.UserId == targetUserId)
                .Select(d => new { d.ItemId, d.Client, d.Key })
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false))
            .Select(d => (d.ItemId, d.Client, d.Key))
            .ToHashSet();

        foreach (var row in sourceRows)
        {
            if (targetKeys.Contains((row.ItemId, row.Client, row.Key)))
            {
                context.CustomItemDisplayPreferences.Remove(row);
                counts.CustomItemDisplayPreferencesDropped++;
            }
            else
            {
                row.UserId = targetUserId;
                counts.CustomItemDisplayPreferencesMoved++;
            }
        }
    }

    private static async Task MoveDevicesAsync(
        JellyfinDbContext context,
        Guid sourceUserId,
        Guid targetUserId,
        UserMergeCounts counts,
        CancellationToken cancellationToken)
    {
        var sourceDevices = await context.Devices
            .Where(d => d.UserId == sourceUserId)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        if (sourceDevices.Count == 0)
        {
            return;
        }

        var targetDeviceIds = (await context.Devices
                .Where(d => d.UserId == targetUserId)
                .Select(d => d.DeviceId)
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false))
            .ToHashSet(StringComparer.Ordinal);

        counts.DevicesMoved = await context.Devices
            .Where(d => d.UserId == sourceUserId)
            .ExecuteUpdateAsync(
                setters => setters.SetProperty(d => d.UserId, targetUserId),
                cancellationToken)
            .ConfigureAwait(false);

        // Reload after ExecuteUpdate (entities above are stale for UserId).
        var overlapping = await context.Devices
            .Where(d => d.UserId == targetUserId && targetDeviceIds.Contains(d.DeviceId))
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        foreach (var group in overlapping.GroupBy(d => d.DeviceId, StringComparer.Ordinal))
        {
            var ordered = group.OrderByDescending(d => d.DateLastActivity).ToList();
            for (var i = 1; i < ordered.Count; i++)
            {
                if (ordered[i].IsActive)
                {
                    ordered[i].IsActive = false;
                    counts.DevicesDeactivated++;
                }
            }
        }
    }

    private static async Task DropSourcePermissionsAsync(
        JellyfinDbContext context,
        Guid sourceUserId,
        UserMergeCounts counts,
        CancellationToken cancellationToken)
    {
        var rows = await context.Permissions
            .Where(p => p.UserId == sourceUserId)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        context.Permissions.RemoveRange(rows);
        counts.PermissionsDropped = rows.Count;
    }

    private static async Task MergePreferencesAsync(
        JellyfinDbContext context,
        Guid sourceUserId,
        Guid targetUserId,
        UserMergeCounts counts,
        CancellationToken cancellationToken)
    {
        var sourceRows = await context.Preferences
            .Where(p => p.UserId == sourceUserId)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        var targetRows = await context.Preferences
            .Where(p => p.UserId == targetUserId)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        var targetMap = targetRows.ToDictionary(p => p.Kind);

        foreach (var source in sourceRows)
        {
            if (targetMap.TryGetValue(source.Kind, out var target))
            {
                var unioned = UnionPreferenceValue(target.Value, source.Value);
                if (!string.Equals(unioned, target.Value, StringComparison.Ordinal))
                {
                    target.Value = unioned;
                    counts.PreferencesUnioned++;
                }

                context.Preferences.Remove(source);
                counts.PreferencesDropped++;
            }
            else
            {
                source.UserId = targetUserId;
                targetMap[source.Kind] = source;
                counts.PreferencesUnioned++;
            }
        }
    }

    private static string UnionPreferenceValue(string targetValue, string sourceValue)
    {
        static IEnumerable<string> Split(string value)
            => (value ?? string.Empty)
                .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        var set = new HashSet<string>(Split(targetValue), StringComparer.OrdinalIgnoreCase);
        foreach (var item in Split(sourceValue))
        {
            set.Add(item);
        }

        return string.Join(',', set);
    }

    private static async Task DropSourceAccessSchedulesAsync(
        JellyfinDbContext context,
        Guid sourceUserId,
        UserMergeCounts counts,
        CancellationToken cancellationToken)
    {
        var rows = await context.AccessSchedules
            .Where(a => a.UserId == sourceUserId)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        context.AccessSchedules.RemoveRange(rows);
        counts.AccessSchedulesDropped = rows.Count;
    }

    private static async Task DropSourceImageInfosAsync(
        JellyfinDbContext context,
        Guid sourceUserId,
        UserMergeCounts counts,
        CancellationToken cancellationToken)
    {
        var rows = await context.ImageInfos
            .Where(i => i.UserId == sourceUserId)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        context.ImageInfos.RemoveRange(rows);
        counts.ImageInfosDropped = rows.Count;
    }

    private static async Task MoveActivityLogsAsync(
        JellyfinDbContext context,
        Guid sourceUserId,
        Guid targetUserId,
        UserMergeCounts counts,
        CancellationToken cancellationToken)
    {
        counts.ActivityLogsMoved = await context.ActivityLogs
            .Where(a => a.UserId == sourceUserId)
            .ExecuteUpdateAsync(
                setters => setters.SetProperty(a => a.UserId, targetUserId),
                cancellationToken)
            .ConfigureAwait(false);
    }

    private static async Task RemoveSourceTasteProfileAsync(
        JellyfinDbContext context,
        Guid sourceUserId,
        UserMergeCounts counts,
        CancellationToken cancellationToken)
    {
        var row = await context.UserTasteProfiles
            .FirstOrDefaultAsync(p => p.UserId == sourceUserId, cancellationToken)
            .ConfigureAwait(false);
        if (row is null)
        {
            return;
        }

        context.UserTasteProfiles.Remove(row);
        counts.TasteProfileSourceRemoved = true;
    }

    private static async Task RemoveSourceTasteImpressionsAsync(
        JellyfinDbContext context,
        Guid sourceUserId,
        UserMergeCounts counts,
        CancellationToken cancellationToken)
    {
        var deleted = await context.UserTasteRecommendationImpressions
            .Where(i => i.UserId == sourceUserId)
            .ExecuteDeleteAsync(cancellationToken)
            .ConfigureAwait(false);
        counts.TasteImpressionsSourceRemoved = deleted;
    }

    private static async Task RemoveSourceBecauseYouAsync(
        JellyfinDbContext context,
        Guid sourceUserId,
        CancellationToken cancellationToken)
    {
        await context.UserTasteBecauseYouRecommendations
            .Where(r => r.UserId == sourceUserId)
            .ExecuteDeleteAsync(cancellationToken)
            .ConfigureAwait(false);
    }

    private async Task RebuildTargetTasteAsync(
        Guid targetUserId,
        UserMergeCounts counts,
        CancellationToken cancellationToken)
    {
        var options = TasteOptions.Current;
        if (!options.EnableTasteProfiles)
        {
            return;
        }

        var context = await _dbProvider.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
        await using (context.ConfigureAwait(false))
        {
            var movieType = _itemTypeLookup.BaseItemKindNames[BaseItemKind.Movie];
            var seriesType = _itemTypeLookup.BaseItemKindNames[BaseItemKind.Series];
            var episodeType = _itemTypeLookup.BaseItemKindNames[BaseItemKind.Episode];
            _itemTypeLookup.BaseItemKindNames.TryGetValue(BaseItemKind.BoxSet, out var boxSetType);
            var cutoff = DateTime.UtcNow.AddDays(-options.LookbackDays);
            var outcome = await _tasteBuilder.RebuildUserAsync(
                    context,
                    targetUserId,
                    movieType,
                    seriesType,
                    episodeType,
                    cutoff,
                    options.MinSamples,
                    cancellationToken,
                    boxSetType)
                .ConfigureAwait(false);
            counts.TasteProfileTargetRebuilt = outcome.Upserted;
            _tasteStore.InvalidateAll();
        }
    }

    private void InvalidateCaches()
    {
        _services.GetService<IQueryResultCache>()?.InvalidateAll();
        _tasteStore.InvalidateAll();
    }
}
