using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.Seerr.Models;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Seerr.Services;

/// <summary>
/// Resolves Jellyfin usernames to Seerr user ids.
/// </summary>
public sealed class SeerrUserResolver
{
    private static readonly TimeSpan CacheDuration = TimeSpan.FromMinutes(30);

    private readonly SeerrClient _client;
    private readonly IMemoryCache _cache;
    private readonly ILogger<SeerrUserResolver> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="SeerrUserResolver"/> class.
    /// </summary>
    /// <param name="client">Seerr HTTP client.</param>
    /// <param name="cache">Memory cache.</param>
    /// <param name="logger">Logger.</param>
    public SeerrUserResolver(SeerrClient client, IMemoryCache cache, ILogger<SeerrUserResolver> logger)
    {
        _client = client;
        _cache = cache;
        _logger = logger;
    }

    /// <summary>
    /// Resolves a Jellyfin user to a Seerr user id by username match.
    /// </summary>
    /// <param name="jellyfinUserId">Jellyfin user id (cache key).</param>
    /// <param name="jellyfinUsername">Jellyfin username.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Seerr user id.</returns>
    /// <exception cref="SeerrApiException">Thrown when no matching Seerr user exists.</exception>
    public async Task<int> ResolveAsync(Guid jellyfinUserId, string jellyfinUsername, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(jellyfinUsername);

        var cacheKey = "seerr-user:" + jellyfinUserId.ToString("N");
        if (_cache.TryGetValue(cacheKey, out int cachedId))
        {
            return cachedId;
        }

        var users = await _client.FindUsersAsync(jellyfinUsername, cancellationToken).ConfigureAwait(false);
        var match = users.FirstOrDefault(u =>
                string.Equals(u.JellyfinUsername, jellyfinUsername, StringComparison.OrdinalIgnoreCase))
            ?? users.FirstOrDefault(u =>
                string.Equals(u.Username, jellyfinUsername, StringComparison.OrdinalIgnoreCase));

        if (match is null)
        {
            _logger.LogWarning("No Seerr user found for Jellyfin username {Username}", jellyfinUsername);
            throw new SeerrApiException(
                404,
                "No Seerr account found for this Jellyfin user. Ensure the user exists in Seerr (SSO import) and usernames match.");
        }

        _cache.Set(cacheKey, match.Id, CacheDuration);
        return match.Id;
    }
}
