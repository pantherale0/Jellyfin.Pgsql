using System;
using Jellyfin.Plugin.Pgsql.Similar;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Configuration;
using Xunit;

namespace Jellyfin.Plugin.Pgsql.Tests.Similar;

public sealed class PostgresSeriesSimilarItemsProviderUnitTests
{
    [Fact]
    public void Provider_ImplementsLocalSeriesInterface()
    {
        Assert.True(typeof(ILocalSimilarItemsProvider).IsAssignableFrom(typeof(PostgresSeriesSimilarItemsProvider)));
        Assert.True(typeof(ILocalSimilarItemsProvider<Series>).IsAssignableFrom(typeof(PostgresSeriesSimilarItemsProvider)));
    }

    [Fact]
    public void Provider_IsLocalSimilarityPlugin_WithDistinctName()
    {
        var provider = CreateProviderWithoutDeps();
        Assert.Equal("PostgreSQL Series Similarity", provider.Name);
        Assert.Equal(MetadataPluginType.LocalSimilarityProvider, provider.Type);
        Assert.NotEqual("PostgreSQL Similarity", provider.Name);
    }

    [Fact]
    public void Supports_Series_Only()
    {
        ILocalSimilarItemsProvider provider = CreateProviderWithoutDeps();
        Assert.True(provider.Supports(typeof(Series)));
        Assert.False(provider.Supports(typeof(MediaBrowser.Controller.Entities.Movies.Movie)));
        Assert.False(provider.Supports(typeof(Episode)));
    }

    private static PostgresSeriesSimilarItemsProvider CreateProviderWithoutDeps()
        => new(null!, null!, null!, null!, null!);
}
