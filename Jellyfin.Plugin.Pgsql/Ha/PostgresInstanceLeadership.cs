using System;
using System.Globalization;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller;
using Microsoft.Extensions.Logging;
using Npgsql;

namespace Jellyfin.Plugin.Pgsql.Ha;

/// <summary>
/// PostgreSQL session advisory lock used as the single-writer fence.
/// </summary>
internal sealed class PostgresInstanceLeadership : IInstanceLeadership, IAsyncDisposable
{
    private readonly ILogger<PostgresInstanceLeadership> _logger;
    private readonly HaOptions _options;
    private readonly string _connectionString;
    private readonly SemaphoreSlim _mutex = new(1, 1);

    private NpgsqlConnection? _connection;
    private bool _isLeader;
    private long _epoch;

    /// <summary>
    /// Initializes a new instance of the <see cref="PostgresInstanceLeadership"/> class.
    /// </summary>
    /// <param name="logger">The logger.</param>
    public PostgresInstanceLeadership(ILogger<PostgresInstanceLeadership> logger)
    {
        _logger = logger;
        _options = HaOptions.Current;
        _connectionString = BuildConnectionString();
    }

    /// <inheritdoc />
    public event EventHandler<LeadershipChangedEventArgs>? LeadershipChanged;

    /// <inheritdoc />
    public bool IsHaEnabled => true;

    /// <inheritdoc />
    public bool IsLeader => Volatile.Read(ref _isLeader);

    /// <inheritdoc />
    public long Epoch => Interlocked.Read(ref _epoch);

    /// <summary>
    /// Attempts to acquire the advisory lock or confirm it is still held.
    /// </summary>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>A <see cref="Task"/> representing the asynchronous operation.</returns>
    public async Task TickAsync(CancellationToken cancellationToken)
    {
        await _mutex.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (_isLeader)
            {
                if (await HeartbeatAsync(cancellationToken).ConfigureAwait(false))
                {
                    return;
                }

                await ResignLockedAsync().ConfigureAwait(false);
            }

            if (await TryAcquireLockedAsync(cancellationToken).ConfigureAwait(false))
            {
                var epoch = Interlocked.Increment(ref _epoch);
                Volatile.Write(ref _isLeader, true);
                if (_logger.IsEnabled(LogLevel.Information))
                {
                    _logger.LogInformation("Acquired HA leadership lock (epoch {Epoch})", epoch);
                }

                LeadershipChanged?.Invoke(this, new LeadershipChangedEventArgs(true, epoch));
            }
        }
        finally
        {
            _mutex.Release();
        }
    }

    /// <summary>
    /// Releases the lock if held.
    /// </summary>
    /// <returns>A <see cref="Task"/> representing the asynchronous operation.</returns>
    public async Task ResignAsync()
    {
        await _mutex.WaitAsync().ConfigureAwait(false);
        try
        {
            await ResignLockedAsync().ConfigureAwait(false);
        }
        finally
        {
            _mutex.Release();
        }
    }

    /// <inheritdoc />
    public async ValueTask DisposeAsync()
    {
        await ResignAsync().ConfigureAwait(false);
        _mutex.Dispose();
    }

    private async Task<bool> TryAcquireLockedAsync(CancellationToken cancellationToken)
    {
        try
        {
            await EnsureConnectionAsync(cancellationToken).ConfigureAwait(false);
            await using var command = new NpgsqlCommand(
                "SELECT pg_try_advisory_lock(@key)",
                _connection);
            command.Parameters.AddWithValue("key", _options.LockKey);
            var result = await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false);
            return result is true;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to acquire HA leadership lock");
            await DisposeConnectionAsync().ConfigureAwait(false);
            return false;
        }
    }

    private async Task<bool> HeartbeatAsync(CancellationToken cancellationToken)
    {
        try
        {
            if (_connection is null)
            {
                return false;
            }

            await using var command = new NpgsqlCommand("SELECT 1", _connection);
            await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false);
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "HA leadership heartbeat failed");
            return false;
        }
    }

    private async Task ResignLockedAsync()
    {
        var wasLeader = _isLeader;
        Volatile.Write(ref _isLeader, false);
        await DisposeConnectionAsync().ConfigureAwait(false);
        if (wasLeader)
        {
            var epoch = Epoch;
            if (_logger.IsEnabled(LogLevel.Warning))
            {
                _logger.LogWarning("Released HA leadership lock (epoch {Epoch})", epoch);
            }

            LeadershipChanged?.Invoke(this, new LeadershipChangedEventArgs(false, epoch));
        }
    }

    private async Task EnsureConnectionAsync(CancellationToken cancellationToken)
    {
        if (_connection is { State: System.Data.ConnectionState.Open })
        {
            return;
        }

        await DisposeConnectionAsync().ConfigureAwait(false);
        var builder = new NpgsqlConnectionStringBuilder(_connectionString)
        {
            KeepAlive = 15,
            CommandTimeout = 15,
            Pooling = false,
            ApplicationName = "jellyfin-ha-leader"
        };
        _connection = new NpgsqlConnection(builder.ToString());
        await _connection.OpenAsync(cancellationToken).ConfigureAwait(false);
    }

    private async Task DisposeConnectionAsync()
    {
        if (_connection is null)
        {
            return;
        }

        try
        {
            await _connection.DisposeAsync().ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Error disposing HA leadership connection");
        }

        _connection = null;
    }

    private static string BuildConnectionString()
    {
        return new NpgsqlConnectionStringBuilder
        {
            Host = Environment.GetEnvironmentVariable("POSTGRES_HOST") ?? "jellyfin",
            Port = int.Parse(Environment.GetEnvironmentVariable("POSTGRES_PORT") ?? "5432", CultureInfo.InvariantCulture),
            Database = Environment.GetEnvironmentVariable("POSTGRES_DB") ?? "jellyfin",
            Username = Environment.GetEnvironmentVariable("POSTGRES_USER") ?? "jellyfin",
            Password = Environment.GetEnvironmentVariable("POSTGRES_PASSWORD")
                ?? throw new InvalidOperationException("PostgreSQL password must be provided via POSTGRES_PASSWORD environment variable"),
            CommandTimeout = 15,
            KeepAlive = 15,
            Pooling = false,
        }.ToString();
    }
}
