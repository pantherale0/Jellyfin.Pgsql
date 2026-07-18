using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Pgsql.Admin.EmbyImport;

/// <summary>
/// Previews and executes Emby UserData imports into a Jellyfin user.
/// </summary>
public sealed class EmbyUserDataImportService
{
    private readonly EmbyImportSessionStore _sessionStore;
    private readonly EmbySqliteReader _sqliteReader;
    private readonly EmbyUserDataMatcher _matcher;
    private readonly IUserManager _userManager;
    private readonly IUserDataManager _userDataManager;
    private readonly ILogger<EmbyUserDataImportService> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="EmbyUserDataImportService"/> class.
    /// </summary>
    /// <param name="sessionStore">Session store.</param>
    /// <param name="sqliteReader">SQLite reader.</param>
    /// <param name="matcher">Key matcher.</param>
    /// <param name="userManager">User manager.</param>
    /// <param name="userDataManager">User data manager.</param>
    /// <param name="logger">Logger.</param>
    public EmbyUserDataImportService(
        EmbyImportSessionStore sessionStore,
        EmbySqliteReader sqliteReader,
        EmbyUserDataMatcher matcher,
        IUserManager userManager,
        IUserDataManager userDataManager,
        ILogger<EmbyUserDataImportService> logger)
    {
        _sessionStore = sessionStore;
        _sqliteReader = sqliteReader;
        _matcher = matcher;
        _userManager = userManager;
        _userDataManager = userDataManager;
        _logger = logger;
    }

    /// <summary>
    /// Accepts uploaded databases and returns Emby users for selection.
    /// </summary>
    /// <param name="libraryDb">Library database stream.</param>
    /// <param name="usersDb">Users database stream.</param>
    /// <param name="createdByUserId">Administrator who uploaded the databases.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Session id and Emby users.</returns>
    public async Task<(string SessionId, IReadOnlyList<EmbyUserInfo> Users)> UploadAsync(
        System.IO.Stream libraryDb,
        System.IO.Stream usersDb,
        Guid createdByUserId,
        CancellationToken cancellationToken)
    {
        var session = await _sessionStore.CreateAsync(libraryDb, usersDb, createdByUserId, cancellationToken)
            .ConfigureAwait(false);
        try
        {
            var users = await _sqliteReader.ListUsersAsync(session, cancellationToken).ConfigureAwait(false);
            return (session.SessionId, users);
        }
        catch
        {
            _sessionStore.Delete(session.SessionId);
            throw;
        }
    }

    /// <summary>
    /// Previews an import without writing.
    /// </summary>
    /// <param name="sessionId">Session id.</param>
    /// <param name="embyUserIds">Selected Emby user ids.</param>
    /// <param name="targetUserId">Target Jellyfin user id.</param>
    /// <param name="callerUserId">Authenticated administrator user id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Preview counts.</returns>
    public async Task<EmbyImportCounts> PreviewAsync(
        string sessionId,
        IReadOnlyCollection<int> embyUserIds,
        Guid targetUserId,
        Guid callerUserId,
        CancellationToken cancellationToken)
    {
        var plan = await BuildPlanAsync(sessionId, embyUserIds, targetUserId, callerUserId, cancellationToken)
            .ConfigureAwait(false);
        return plan.Counts;
    }

    /// <summary>
    /// Executes an import and deletes the session.
    /// </summary>
    /// <param name="sessionId">Session id.</param>
    /// <param name="embyUserIds">Selected Emby user ids.</param>
    /// <param name="targetUserId">Target Jellyfin user id.</param>
    /// <param name="callerUserId">Authenticated administrator user id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Result counts.</returns>
    public async Task<EmbyImportCounts> ExecuteAsync(
        string sessionId,
        IReadOnlyCollection<int> embyUserIds,
        Guid targetUserId,
        Guid callerUserId,
        CancellationToken cancellationToken)
    {
        var plan = await BuildPlanAsync(sessionId, embyUserIds, targetUserId, callerUserId, cancellationToken)
            .ConfigureAwait(false);

        var imported = 0;
        foreach (var (itemId, sourceData) in plan.ByItem)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var item = _matcher.GetItem(itemId);
            if (item is null)
            {
                continue;
            }

            var existing = _userDataManager.GetUserData(plan.TargetUser, item);
            UserItemData toSave;
            if (existing is null)
            {
                toSave = ToUserItemData(sourceData, item);
            }
            else
            {
                MergeUserItemData(existing, sourceData);
                toSave = existing;
                if (string.IsNullOrEmpty(toSave.Key))
                {
                    toSave.Key = item.GetUserDataKeys().FirstOrDefault() ?? item.Id.ToString("N");
                }
            }

            _userDataManager.SaveUserData(
                plan.TargetUser,
                item,
                toSave,
                UserDataSaveReason.Import,
                cancellationToken);
            imported++;
        }

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "Imported Emby UserData into {TargetUserId}: items={Imported}, unmatchedKeys={Unmatched}",
                targetUserId,
                imported,
                plan.Counts.UnmatchedKeys);
        }

        _sessionStore.Delete(sessionId);
        return plan.Counts;
    }

    /// <summary>
    /// Discards an upload session owned by the caller.
    /// </summary>
    /// <param name="sessionId">Session id.</param>
    /// <param name="callerUserId">Authenticated administrator user id.</param>
    /// <returns><c>true</c> if removed.</returns>
    public bool Discard(string sessionId, Guid callerUserId) => _sessionStore.Delete(sessionId, callerUserId);

    private async Task<ImportPlan> BuildPlanAsync(
        string sessionId,
        IReadOnlyCollection<int> embyUserIds,
        Guid targetUserId,
        Guid callerUserId,
        CancellationToken cancellationToken)
    {
        if (embyUserIds is null || embyUserIds.Count == 0)
        {
            throw new EmbyImportException("At least one Emby user must be selected.");
        }

        var targetUser = _userManager.GetUserById(targetUserId)
            ?? throw new EmbyImportException("Target Jellyfin user was not found.");

        var session = _sessionStore.GetRequired(sessionId, callerUserId);
        var rows = await _sqliteReader
            .ReadUserDataAsync(session.LibraryDbPath, embyUserIds, cancellationToken)
            .ConfigureAwait(false);

        var keyIndex = _matcher.BuildKeyIndex();
        var byItem = new Dictionary<Guid, UserData>();
        var matchedKeys = 0;
        var unmatchedKeys = 0;

        foreach (var row in rows)
        {
            if (!keyIndex.TryGetValue(row.Key, out var itemId))
            {
                unmatchedKeys++;
                continue;
            }

            matchedKeys++;
            var source = ToUserData(row, itemId, targetUserId);
            if (byItem.TryGetValue(itemId, out var existing))
            {
                UserDataMergeRules.MergeInto(existing, source);
            }
            else
            {
                byItem[itemId] = source;
            }
        }

        var itemsNew = 0;
        var itemsMerged = 0;
        foreach (var existing in byItem.Keys
                     .Select(_matcher.GetItem)
                     .OfType<BaseItem>()
                     .Select(item => _userDataManager.GetUserData(targetUser, item)))
        {
            if (existing is null)
            {
                itemsNew++;
            }
            else
            {
                itemsMerged++;
            }
        }

        return new ImportPlan
        {
            TargetUser = targetUser,
            ByItem = byItem,
            Counts = new EmbyImportCounts
            {
                SourceRows = rows.Count,
                MatchedKeys = matchedKeys,
                UnmatchedKeys = unmatchedKeys,
                MatchedItems = byItem.Count,
                ItemsNew = itemsNew,
                ItemsMerged = itemsMerged,
            },
        };
    }

    private static UserData ToUserData(EmbyUserDataRow row, Guid itemId, Guid userId)
    {
        var rating = ClampRating(row.Rating);
        return new UserData
        {
            ItemId = itemId,
            UserId = userId,
            CustomDataKey = row.Key,
            Rating = rating,
            Played = row.Played,
            PlayCount = Math.Max(0, row.PlayCount),
            IsFavorite = row.IsFavorite,
            PlaybackPositionTicks = Math.Max(0, row.PlaybackPositionTicks),
            LastPlayedDate = row.LastPlayedDate,
            AudioStreamIndex = row.AudioStreamIndex,
            SubtitleStreamIndex = row.SubtitleStreamIndex,
            Likes = null,
            User = null!,
            Item = null!,
        };
    }

    private static UserItemData ToUserItemData(UserData source, BaseItem item)
    {
        var key = item.GetUserDataKeys().FirstOrDefault() ?? item.Id.ToString("N");
        return new UserItemData
        {
            Key = key,
            Rating = ClampRating(source.Rating),
            Played = source.Played,
            PlayCount = source.PlayCount,
            IsFavorite = source.IsFavorite,
            PlaybackPositionTicks = source.PlaybackPositionTicks,
            LastPlayedDate = source.LastPlayedDate,
            AudioStreamIndex = source.AudioStreamIndex,
            SubtitleStreamIndex = source.SubtitleStreamIndex,
        };
    }

    private static void MergeUserItemData(UserItemData target, UserData source)
    {
        var bridge = new UserData
        {
            ItemId = source.ItemId,
            UserId = source.UserId,
            CustomDataKey = target.Key,
            Rating = target.Rating,
            Played = target.Played,
            PlayCount = target.PlayCount,
            IsFavorite = target.IsFavorite,
            PlaybackPositionTicks = target.PlaybackPositionTicks,
            LastPlayedDate = target.LastPlayedDate,
            AudioStreamIndex = target.AudioStreamIndex,
            SubtitleStreamIndex = target.SubtitleStreamIndex,
            Likes = null,
            User = null!,
            Item = null!,
        };

        UserDataMergeRules.MergeInto(bridge, source);

        target.Rating = bridge.Rating;
        target.Played = bridge.Played;
        target.PlayCount = bridge.PlayCount;
        target.IsFavorite = bridge.IsFavorite;
        target.PlaybackPositionTicks = bridge.PlaybackPositionTicks;
        target.LastPlayedDate = bridge.LastPlayedDate;
        target.AudioStreamIndex = bridge.AudioStreamIndex;
        target.SubtitleStreamIndex = bridge.SubtitleStreamIndex;
    }

    private static double? ClampRating(double? rating)
    {
        if (rating is null)
        {
            return null;
        }

        if (rating < 0 || rating > 10)
        {
            return null;
        }

        return rating;
    }

    private sealed class ImportPlan
    {
        public required User TargetUser { get; init; }

        public required Dictionary<Guid, UserData> ByItem { get; init; }

        public required EmbyImportCounts Counts { get; init; }
    }
}
