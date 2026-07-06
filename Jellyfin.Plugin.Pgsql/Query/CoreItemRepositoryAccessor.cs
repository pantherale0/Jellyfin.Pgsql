using System;
using System.Linq;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.Pgsql.Query;

/// <summary>
/// Locates the core <c>BaseItemRepository</c> registration. The concrete type lives in
/// <c>Jellyfin.Server.Implementations</c>, which this plugin does not reference at compile
/// time, so it is discovered from the host's service collection at registration time.
/// </summary>
internal static class CoreItemRepositoryAccessor
{
    private const string CoreRepositoryTypeName = "Jellyfin.Server.Implementations.Item.BaseItemRepository";

    /// <summary>
    /// Finds the concrete core item repository type registered by the server.
    /// </summary>
    /// <param name="serviceCollection">The host service collection.</param>
    /// <returns>The concrete repository type, or <c>null</c> when the server layout changed.</returns>
    public static Type? FindCoreRepositoryType(IServiceCollection serviceCollection)
    {
        return serviceCollection
            .LastOrDefault(descriptor => string.Equals(descriptor.ServiceType.FullName, CoreRepositoryTypeName, StringComparison.Ordinal))
            ?.ServiceType;
    }
}
