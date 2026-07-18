using System;
using System.IO;
using System.Linq;
using System.Reflection;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Persistence;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.Pgsql.Query;

/// <summary>
/// Creates the core <see cref="INextUpService"/> without referencing
/// <c>Jellyfin.Server.Implementations</c> at compile time.
/// </summary>
internal static class CoreNextUpServiceAccessor
{
    private const string NextUpServiceTypeName = "Jellyfin.Server.Implementations.Item.NextUpService";

    /// <summary>
    /// Creates a core next-up service instance from the host DI container.
    /// </summary>
    /// <param name="serviceProvider">The service provider.</param>
    /// <returns>The core next-up service.</returns>
    public static INextUpService Create(IServiceProvider serviceProvider)
    {
        var type = AppDomain.CurrentDomain.GetAssemblies()
            .SelectMany(static assembly =>
            {
                try
                {
                    return assembly.GetTypes();
                }
                catch (ReflectionTypeLoadException)
                {
                    return Array.Empty<Type>();
                }
                catch (FileNotFoundException)
                {
                    return Array.Empty<Type>();
                }
                catch (FileLoadException)
                {
                    return Array.Empty<Type>();
                }
                catch (BadImageFormatException)
                {
                    return Array.Empty<Type>();
                }
            })
            .FirstOrDefault(candidate => string.Equals(candidate.FullName, NextUpServiceTypeName, StringComparison.Ordinal))
            ?? throw new InvalidOperationException($"Could not find {NextUpServiceTypeName}");

        return (INextUpService)ActivatorUtilities.CreateInstance(serviceProvider, type);
    }
}
