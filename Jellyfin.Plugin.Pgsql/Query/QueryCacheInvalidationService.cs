using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Pgsql.Query;

/// <summary>
/// Invalidates query caches when library items or user playback state change by bumping
/// version stamps (keys become unreachable) instead of scanning Redis KEYS on every save.
/// </summary>
internal sealed class QueryCacheInvalidationService : IHostedService
{
    private readonly ILibraryManager _libraryManager;
    private readonly IUserDataManager _userDataManager;
    private readonly IQueryCacheVersionStore _versions;
    private readonly ILogger<QueryCacheInvalidationService> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="QueryCacheInvalidationService"/> class.
    /// </summary>
    /// <param name="libraryManager">The library manager.</param>
    /// <param name="userDataManager">The user data manager.</param>
    /// <param name="versions">The query cache version store.</param>
    /// <param name="logger">The logger.</param>
    public QueryCacheInvalidationService(
        ILibraryManager libraryManager,
        IUserDataManager userDataManager,
        IQueryCacheVersionStore versions,
        ILogger<QueryCacheInvalidationService> logger)
    {
        _libraryManager = libraryManager;
        _userDataManager = userDataManager;
        _versions = versions;
        _logger = logger;
    }

    /// <inheritdoc />
    public Task StartAsync(CancellationToken cancellationToken)
    {
        _libraryManager.ItemAdded += OnLibraryChanged;
        _libraryManager.ItemUpdated += OnLibraryChanged;
        _libraryManager.ItemRemoved += OnLibraryChanged;
        _userDataManager.UserDataSaved += OnUserDataSaved;
        return Task.CompletedTask;
    }

    /// <inheritdoc />
    public Task StopAsync(CancellationToken cancellationToken)
    {
        _libraryManager.ItemAdded -= OnLibraryChanged;
        _libraryManager.ItemUpdated -= OnLibraryChanged;
        _libraryManager.ItemRemoved -= OnLibraryChanged;
        _userDataManager.UserDataSaved -= OnUserDataSaved;
        return Task.CompletedTask;
    }

    /// <summary>
    /// Returns whether a userdata save should bump the user's cache generation.
    /// Frequent PlaybackProgress saves are skipped; Resume TTL covers stale positions.
    /// </summary>
    /// <param name="reason">The save reason.</param>
    /// <returns><c>true</c> when the user version should be bumped.</returns>
    internal static bool ShouldBumpUserCache(UserDataSaveReason reason)
        => reason is not UserDataSaveReason.PlaybackProgress;

    private void OnLibraryChanged(object? sender, ItemChangeEventArgs e) => BumpLibrary("library change");

    private void OnUserDataSaved(object? sender, UserDataSaveEventArgs e)
    {
        if (!ShouldBumpUserCache(e.SaveReason))
        {
            return;
        }

        BumpUser(e.UserId, e.SaveReason);
    }

    private void BumpLibrary(string reason)
    {
        try
        {
            _versions.BumpLibrary();
            if (_logger.IsEnabled(LogLevel.Debug))
            {
                _logger.LogDebug("Bumped PostgreSQL query cache library version due to {Reason}", reason);
            }
        }
        catch (Exception ex) when (ex is InvalidOperationException or ObjectDisposedException or IOException or TimeoutException)
        {
            _logger.LogWarning(ex, "Failed to bump PostgreSQL query cache library version after {Reason}", reason);
        }
    }

    private void BumpUser(Guid userId, UserDataSaveReason reason)
    {
        try
        {
            _versions.BumpUser(userId);
            if (_logger.IsEnabled(LogLevel.Debug))
            {
                _logger.LogDebug(
                    "Bumped PostgreSQL query cache user version for {UserId} due to {Reason}",
                    userId,
                    reason);
            }
        }
        catch (Exception ex) when (ex is InvalidOperationException or ObjectDisposedException or IOException or TimeoutException)
        {
            _logger.LogWarning(
                ex,
                "Failed to bump PostgreSQL query cache user version for {UserId} after {Reason}",
                userId,
                reason);
        }
    }
}
