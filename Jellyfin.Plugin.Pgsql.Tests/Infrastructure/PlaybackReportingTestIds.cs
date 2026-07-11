using System;

namespace Jellyfin.Plugin.Pgsql.Tests.Infrastructure;

internal static class PlaybackReportingTestIds
{
    public static readonly Guid UserId = Guid.Parse("a060ed14-b64a-41aa-b140-9f66276f0885");

    public static readonly Guid MovieItemId = Guid.Parse("11111111-1111-1111-1111-111111111111");

    public static readonly Guid OtherItemId = Guid.Parse("22222222-2222-2222-2222-222222222222");

    public const string DeviceClientId = "playback-test-device";
}
