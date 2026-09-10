using System;
using System.IO;
using System.Threading;
using Microsoft.Extensions.Logging;
using StackExchange.Redis;

namespace Jellyfin.Plugin.Pgsql.Query;

/// <summary>
/// Observed Redis link state for request gating.
/// </summary>
public enum RedisAvailability
{
    /// <summary>Last PING or successful op completed; safe for request-path use.</summary>
    Ready = 0,

    /// <summary>Reconnecting or not yet verified; request path skips; background probes.</summary>
    Unknown = 1,

    /// <summary>Known failure; request path skips until a probe succeeds.</summary>
    Unavailable = 2,
}

/// <summary>
/// Shared long-lived Redis multiplexer with proactive health probing.
/// Request paths use Redis only when <see cref="CanUse"/> is true (last probe/op succeeded);
/// Unknown/Unavailable skip immediately so home APIs never wait on SyncTimeout to discover an outage.
/// </summary>
public sealed class RedisConnectionHub : IDisposable
{
    private static readonly TimeSpan ProbeIntervalWhenUnhealthy = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan ProbeIntervalWhenHealthy = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan ProbeBackoffAfterFailure = TimeSpan.FromSeconds(2);

    private readonly ConnectionMultiplexer _connection;
    private readonly ILogger _logger;
    private readonly Timer _probeTimer;
    private int _availability = (int)RedisAvailability.Unknown;
    private long _nextProbeAllowedTicks;
    private int _probeInFlight;
    private int _disposed;

    private RedisConnectionHub(ConnectionMultiplexer connection, ILogger logger)
    {
        _connection = connection;
        _logger = logger;
        _connection.ConnectionFailed += OnConnectionFailed;
        _connection.ConnectionRestored += OnConnectionRestored;
        _probeTimer = new Timer(
            static state => ((RedisConnectionHub)state!).Probe(),
            this,
            TimeSpan.Zero,
            ProbeIntervalWhenUnhealthy);
    }

    /// <summary>
    /// Gets the underlying multiplexer for <c>RedisCache</c> and direct database access.
    /// </summary>
    public IConnectionMultiplexer Connection => _connection;

    /// <summary>
    /// Gets the current availability (<see cref="RedisAvailability.Ready"/> /
    /// <see cref="RedisAvailability.Unknown"/> / <see cref="RedisAvailability.Unavailable"/>).
    /// </summary>
    public RedisAvailability Status => (RedisAvailability)Volatile.Read(ref _availability);

    /// <summary>
    /// Gets a value indicating whether Redis has been verified healthy. Unknown and Unavailable
    /// both skip the request path immediately (fail-fast to memory / DB).
    /// </summary>
    public bool CanUse => Status == RedisAvailability.Ready && _connection.IsConnected;

    /// <summary>
    /// Creates a hub, or returns <c>null</c> if the multiplexer cannot be constructed.
    /// Connect itself does not throw when Redis is briefly unreachable (<c>AbortOnConnectFail=false</c>).
    /// </summary>
    /// <param name="connectionString">StackExchange.Redis connection string.</param>
    /// <param name="logger">Logger.</param>
    /// <returns>A hub, or <c>null</c> on configuration failure.</returns>
    public static RedisConnectionHub? TryCreate(string connectionString, ILogger logger)
    {
        try
        {
            var configuration = ConfigurationOptions.Parse(connectionString);
            // Never fail server startup because Redis is briefly unreachable; the multiplexer
            // keeps retrying in the background and cache ops degrade to misses until then.
            configuration.AbortOnConnectFail = false;
            // Do not queue commands while disconnected — that backlog wait is a multi-second tax
            // on every Latest/Resume/NextUp request when Redis is unreachable.
            configuration.BacklogPolicy = BacklogPolicy.FailFast;
            // Residual timeouts only apply when CanUse is true but the link dies mid-op.
            configuration.ConnectTimeout = 1000;
            configuration.SyncTimeout = 100;
            configuration.AsyncTimeout = 100;
            // Detect dead TCP sooner than the StackExchange default (60s).
            configuration.KeepAlive = 15;

            var connection = ConnectionMultiplexer.Connect(configuration);
            return new RedisConnectionHub(connection, logger);
        }
        catch (Exception ex) when (ex is RedisException or IOException or TimeoutException or ArgumentException or ObjectDisposedException)
        {
            logger.LogWarning(ex, "Failed to create Redis connection hub");
            return null;
        }
    }

    /// <summary>
    /// Returns a database proxy when the hub is usable.
    /// </summary>
    /// <param name="db">The database, when available.</param>
    /// <returns>True when Redis may be used on the request path.</returns>
    public bool TryGetDatabase(out IDatabase db)
    {
        if (!CanUse)
        {
            db = null!;
            return false;
        }

        db = _connection.GetDatabase();
        return true;
    }

    /// <summary>
    /// Marks Redis Ready after a successful cache/version/progress operation.
    /// </summary>
    public void ReportSuccess()
        => SetAvailability(RedisAvailability.Ready, "op-success");

    /// <summary>
    /// Marks Redis Unavailable after a failed operation; background probes recover it.
    /// </summary>
    public void ReportFailure()
    {
        SetAvailability(RedisAvailability.Unavailable, "op-failure");
        Interlocked.Exchange(
            ref _nextProbeAllowedTicks,
            DateTimeOffset.UtcNow.Add(ProbeBackoffAfterFailure).UtcTicks);
        TryChangeProbePeriod(ProbeIntervalWhenUnhealthy);
    }

    /// <inheritdoc />
    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        _probeTimer.Dispose();
        _connection.ConnectionFailed -= OnConnectionFailed;
        _connection.ConnectionRestored -= OnConnectionRestored;
        _connection.Dispose();
    }

    private void OnConnectionFailed(object? sender, ConnectionFailedEventArgs e)
        => SetAvailability(RedisAvailability.Unavailable, $"connection-failed:{e.FailureType}");

    private void OnConnectionRestored(object? sender, ConnectionFailedEventArgs e)
    {
        // Socket restored ≠ verified Redis; stay Unknown until PING succeeds so user requests
        // do not pay SyncTimeout as the first probe.
        SetAvailability(RedisAvailability.Unknown, "connection-restored");
        TryChangeProbePeriod(ProbeIntervalWhenUnhealthy);
        Probe();
    }

    private void Probe()
    {
        if (Volatile.Read(ref _disposed) != 0)
        {
            return;
        }

        if (Interlocked.CompareExchange(ref _probeInFlight, 1, 0) != 0)
        {
            return;
        }

        try
        {
            var nextAllowed = Interlocked.Read(ref _nextProbeAllowedTicks);
            if (nextAllowed != 0 && DateTimeOffset.UtcNow.UtcTicks < nextAllowed)
            {
                return;
            }

            if (!_connection.IsConnected)
            {
                SetAvailability(RedisAvailability.Unavailable, "probe-disconnected");
                TryChangeProbePeriod(ProbeIntervalWhenUnhealthy);
                return;
            }

            var latency = _connection.GetDatabase().Ping();
            SetAvailability(RedisAvailability.Ready, $"probe-ok:{latency.TotalMilliseconds:F0}ms");
            TryChangeProbePeriod(ProbeIntervalWhenHealthy);
        }
        catch (Exception ex) when (ex is RedisException or IOException or TimeoutException or ObjectDisposedException)
        {
            SetAvailability(RedisAvailability.Unavailable, "probe-failed");
            Interlocked.Exchange(
                ref _nextProbeAllowedTicks,
                DateTimeOffset.UtcNow.Add(ProbeBackoffAfterFailure).UtcTicks);
            TryChangeProbePeriod(ProbeIntervalWhenUnhealthy);
            if (_logger.IsEnabled(LogLevel.Debug))
            {
                _logger.LogDebug(ex, "Redis health probe failed");
            }
        }
        finally
        {
            Interlocked.Exchange(ref _probeInFlight, 0);
        }
    }

    private void SetAvailability(RedisAvailability value, string reason)
    {
        var previous = (RedisAvailability)Interlocked.Exchange(ref _availability, (int)value);
        if (previous == value)
        {
            return;
        }

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "Redis availability {Previous} -> {Current} ({Reason})",
                previous,
                value,
                reason);
        }

        if (value != RedisAvailability.Ready)
        {
            TryChangeProbePeriod(ProbeIntervalWhenUnhealthy);
        }
    }

    private void TryChangeProbePeriod(TimeSpan period)
    {
        if (Volatile.Read(ref _disposed) != 0)
        {
            return;
        }

        try
        {
            _probeTimer.Change(period, period);
        }
        catch (ObjectDisposedException)
        {
            // Hub is shutting down.
        }
    }
}
