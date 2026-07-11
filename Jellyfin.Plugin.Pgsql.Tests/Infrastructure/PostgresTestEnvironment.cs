using System;

namespace Jellyfin.Plugin.Pgsql.Tests.Infrastructure;

internal static class PostgresTestEnvironment
{
    public static string ConnectionString =>
        Environment.GetEnvironmentVariable("ConnectionStrings__Default")
        ?? string.Empty;
}
