using System;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.Seerr.Services;

/// <summary>
/// Registers Seerr gateway services with the Jellyfin DI container.
/// </summary>
public sealed class SeerrServiceRegistrator : IPluginServiceRegistrator
{
    /// <inheritdoc/>
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        serviceCollection.AddMemoryCache();
        serviceCollection.AddHttpClient(nameof(SeerrClient), client =>
        {
            client.Timeout = TimeSpan.FromSeconds(30);
        });
        serviceCollection.AddSingleton<SeerrClient>();
        serviceCollection.AddSingleton<SeerrUserResolver>();
        serviceCollection.AddSingleton<SeerrParentalFilter>();
    }
}
