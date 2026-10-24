using System;
using Jellyfin.Plugin.Pgsql.Configuration;
using Jellyfin.Plugin.Pgsql.Query;
using Xunit;

namespace Jellyfin.Plugin.Pgsql.Tests.Query;

[Collection(ResumeEnvironmentCollection.Name)]
public sealed class ResumeQueryOptionsTests
{
    [Fact]
    public void Resolve_UsesConfiguredResumeOptimization()
    {
        WithOverride(null, () =>
        {
            Assert.True(PgsqlQueryOptions.Resolve(new PluginConfiguration()).OptimizeResume);
            Assert.False(PgsqlQueryOptions.Resolve(new PluginConfiguration { OptimizeResumeQueries = false }).OptimizeResume);
        });
    }

    [Theory]
    [InlineData("true", false, true)]
    [InlineData("false", true, false)]
    public void Resolve_EnvironmentOverridesConfiguration(string value, bool configured, bool expected)
        => WithOverride(value, () => Assert.Equal(expected,
            PgsqlQueryOptions.Resolve(new PluginConfiguration { OptimizeResumeQueries = configured }).OptimizeResume));

    private static void WithOverride(string? value, Action action)
    {
        const string name = "Pgsql_PG_OPTIMIZE_RESUME";
        var previous = Environment.GetEnvironmentVariable(name);
        try
        {
            Environment.SetEnvironmentVariable(name, value);
            action();
        }
        finally
        {
            Environment.SetEnvironmentVariable(name, previous);
        }
    }
}

[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class ResumeEnvironmentCollection
{
    public const string Name = "Resume option environment";
}
