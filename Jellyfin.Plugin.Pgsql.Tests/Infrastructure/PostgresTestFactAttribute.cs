using System;
using Xunit;

namespace Jellyfin.Plugin.Pgsql.Tests.Infrastructure;

/// <summary>
/// Skips the test when <c>ConnectionStrings__Default</c> is not set (local dev without Postgres).
/// </summary>
[AttributeUsage(AttributeTargets.Method, AllowMultiple = false)]
internal sealed class PostgresTestFactAttribute : FactAttribute
{
    public PostgresTestFactAttribute()
    {
        if (string.IsNullOrWhiteSpace(PostgresTestEnvironment.ConnectionString))
        {
            Skip = "ConnectionStrings__Default is not configured.";
        }
    }
}
