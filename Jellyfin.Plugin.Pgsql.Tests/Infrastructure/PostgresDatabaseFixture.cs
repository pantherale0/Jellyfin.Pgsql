using System;
using System.Data.Common;
using System.IO;
using System.Net.Sockets;
using System.Threading.Tasks;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace Jellyfin.Plugin.Pgsql.Tests.Infrastructure;

/// <summary>
/// Applies EF migrations once per test run when Postgres is available.
/// </summary>
public sealed class PostgresDatabaseFixture : IAsyncLifetime
{
    public bool IsAvailable { get; private set; }

    public string? InitializationError { get; private set; }

    public string ConnectionString => PostgresTestEnvironment.ConnectionString;

    public async Task InitializeAsync()
    {
        if (string.IsNullOrWhiteSpace(ConnectionString))
        {
            return;
        }

        try
        {
            var factory = new TestDbContextFactory(ConnectionString);
            await using var dbContext = await factory.CreateDbContextAsync().ConfigureAwait(false);
            await dbContext.Database.MigrateAsync().ConfigureAwait(false);
            IsAvailable = true;
        }
        catch (Exception ex) when (ex is DbException or InvalidOperationException or TimeoutException
            or IOException or ArgumentException or SocketException)
        {
            InitializationError = ex.Message;
            IsAvailable = false;
        }
    }

    public Task DisposeAsync() => Task.CompletedTask;
}

[CollectionDefinition(PostgresCollection.Name)]
public sealed class PostgresCollection : ICollectionFixture<PostgresDatabaseFixture>
{
    public const string Name = "Postgres";
}
