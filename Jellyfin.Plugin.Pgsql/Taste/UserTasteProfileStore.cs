using System;
using System.Collections.Concurrent;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Pgsql.Taste;

/// <summary>
/// Loads and caches user taste profiles for the similar-items serve path.
/// </summary>
public sealed class UserTasteProfileStore
{
    private readonly IDbContextFactory<JellyfinDbContext> _dbProvider;
    private readonly ILogger<UserTasteProfileStore> _logger;
    private readonly ConcurrentDictionary<Guid, CacheEntry> _cache = new();
    private static readonly TimeSpan CacheTtl = TimeSpan.FromMinutes(15);

    /// <summary>
    /// Initializes a new instance of the <see cref="UserTasteProfileStore"/> class.
    /// </summary>
    /// <param name="dbProvider">Database context factory.</param>
    /// <param name="logger">Logger.</param>
    public UserTasteProfileStore(
        IDbContextFactory<JellyfinDbContext> dbProvider,
        ILogger<UserTasteProfileStore> logger)
    {
        _dbProvider = dbProvider;
        _logger = logger;
    }

    /// <summary>
    /// Invalidates all cached profiles (call after a successful rebuild).
    /// </summary>
    public void InvalidateAll() => _cache.Clear();

    /// <summary>
    /// Loads a profile for the user when taste personalization is enabled and min samples are met.
    /// </summary>
    /// <param name="userId">User id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Payload and sample count, or null when unavailable.</returns>
    public async Task<(UserTasteFeaturePayload Payload, int SampleCount)?> TryGetAsync(
        Guid userId,
        CancellationToken cancellationToken)
    {
        var options = TasteOptions.Current;
        if (!options.EnableTasteProfiles)
        {
            return null;
        }

        if (_cache.TryGetValue(userId, out var cached) && cached.ExpiresAt > DateTime.UtcNow)
        {
            return cached.Value;
        }

        try
        {
            var context = await _dbProvider.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
            await using (context.ConfigureAwait(false))
            {
                var row = await context.UserTasteProfiles.AsNoTracking()
                    .FirstOrDefaultAsync(p => p.UserId == userId, cancellationToken)
                    .ConfigureAwait(false);

                (UserTasteFeaturePayload Payload, int SampleCount)? value = null;
                if (row is not null && row.SampleCount >= options.MinSamples)
                {
                    value = (UserTasteProfileBuilder.DeserializeFeatures(row.FeaturesJson), row.SampleCount);
                }

                _cache[userId] = new CacheEntry(value, DateTime.UtcNow.Add(CacheTtl));
                return value;
            }
        }
        catch (Exception ex) when (ex is InvalidOperationException or TimeoutException
            or System.Text.Json.JsonException or System.Data.Common.DbException)
        {
            _logger.LogWarning(ex, "Failed to load taste profile for user {UserId}", userId);
            return null;
        }
    }

    private sealed record CacheEntry(
        (UserTasteFeaturePayload Payload, int SampleCount)? Value,
        DateTime ExpiresAt);
}
