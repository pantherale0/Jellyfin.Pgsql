using System;
using Jellyfin.Plugin.Pgsql.Similar;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Configuration;
using Xunit;

namespace Jellyfin.Plugin.Pgsql.Tests.Similar;

public sealed class PostgresMovieSimilarItemsProviderUnitTests
{
    [Fact]
    public void Provider_ImplementsLocalAndBatchInterfaces()
    {
        Assert.True(typeof(ILocalSimilarItemsProvider).IsAssignableFrom(typeof(PostgresMovieSimilarItemsProvider)));
        Assert.True(typeof(ILocalSimilarItemsProvider<Movie>).IsAssignableFrom(typeof(PostgresMovieSimilarItemsProvider)));
        Assert.True(typeof(ILocalSimilarItemsProvider<Trailer>).IsAssignableFrom(typeof(PostgresMovieSimilarItemsProvider)));
        Assert.True(typeof(IBatchLocalSimilarItemsProvider).IsAssignableFrom(typeof(PostgresMovieSimilarItemsProvider)));
    }

    [Fact]
    public void Provider_IsLocalSimilarityPlugin_WithDistinctName()
    {
        var provider = CreateProviderWithoutDeps();
        Assert.Equal("PostgreSQL Similarity", provider.Name);
        Assert.Equal(MetadataPluginType.LocalSimilarityProvider, provider.Type);
        Assert.NotEqual("Local Genre/Tag", provider.Name);
    }

    [Fact]
    public void Supports_MovieAndTrailer_Only()
    {
        ILocalSimilarItemsProvider provider = CreateProviderWithoutDeps();
        Assert.True(provider.Supports(typeof(Movie)));
        Assert.True(provider.Supports(typeof(Trailer)));
        Assert.False(provider.Supports(typeof(MediaBrowser.Controller.Entities.TV.Series)));
    }

    private static PostgresMovieSimilarItemsProvider CreateProviderWithoutDeps()
        => new(null!, null!, null!, null!);
}
