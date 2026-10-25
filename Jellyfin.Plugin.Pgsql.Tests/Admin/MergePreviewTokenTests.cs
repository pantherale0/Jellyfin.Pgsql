using System;
using System.Security.Claims;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.Pgsql.Admin;
using Jellyfin.Plugin.Pgsql.Api;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Xunit;

namespace Jellyfin.Plugin.Pgsql.Tests.Admin;

public sealed class MergePreviewTokenTests
{
    private static readonly Guid AdministratorId = Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    private static readonly Guid SourceId = Guid.Parse("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    private static readonly Guid TargetId = Guid.Parse("cccccccc-cccc-cccc-cccc-cccccccccccc");
    private static readonly byte[] Key = new byte[32];

    [Fact]
    public void IssueAndValidate_RoundTripsFingerprint()
    {
        var tokens = CreateTokens();
        var token = tokens.Issue(AdministratorId, SourceId, TargetId, "merge", "fingerprint");

        Assert.Equal(
            "fingerprint",
            tokens.Validate(token, AdministratorId, SourceId, TargetId, "merge"));
    }

    [Fact]
    public void Validate_RejectsTamperedSignature()
    {
        var tokens = CreateTokens();
        var token = tokens.Issue(AdministratorId, SourceId, TargetId, "merge", "fingerprint");
        var separator = token.IndexOf('.', StringComparison.Ordinal);
        var tampered = string.Concat(
            token.AsSpan(0, separator + 1),
            token[separator + 1] == 'A' ? "B" : "A",
            token.AsSpan(separator + 2));

        Assert.Throws<UserMergeConflictException>(
            () => tokens.Validate(tampered, AdministratorId, SourceId, TargetId, "merge"));
    }

    [Fact]
    public void Validate_RejectsExpiredToken()
    {
        var time = new TestTimeProvider(DateTimeOffset.Parse("2026-10-15T10:00:00Z"));
        var tokens = new MergePreviewTokens(Key, time);
        var token = tokens.Issue(AdministratorId, SourceId, TargetId, "merge", "fingerprint");
        time.Advance(TimeSpan.FromMinutes(10));

        Assert.Throws<UserMergeConflictException>(
            () => tokens.Validate(token, AdministratorId, SourceId, TargetId, "merge"));
    }

    [Theory]
    [InlineData("administrator")]
    [InlineData("source")]
    [InlineData("target")]
    [InlineData("mode")]
    public void Validate_RejectsAnotherIdentity(string changed)
    {
        var tokens = CreateTokens();
        var token = tokens.Issue(AdministratorId, SourceId, TargetId, "merge", "fingerprint");

        Assert.Throws<UserMergeConflictException>(() => tokens.Validate(
            token,
            changed == "administrator" ? Guid.NewGuid() : AdministratorId,
            changed == "source" ? Guid.NewGuid() : SourceId,
            changed == "target" ? Guid.NewGuid() : TargetId,
            changed == "mode" ? "move" : "merge"));
    }

    [Fact]
    public void Fingerprint_IgnoresResultOnlyFlags()
    {
        var preview = new UserMergeCounts
        {
            UserDataMoved = 2,
            TasteProfileSourceRemoved = true,
            SourceUserDeleted = true
        };
        var result = new UserMergeCounts
        {
            UserDataMoved = 2,
            TasteProfileSourceRemoved = true,
            TasteProfileTargetRebuilt = true
        };

        Assert.Equal(
            MergePreviewTokens.Fingerprint(preview),
            MergePreviewTokens.Fingerprint(result));
    }

    [Fact]
    public void EnsurePreviewStillCurrent_RejectsChangedCounts()
    {
        var fingerprint = MergePreviewTokens.Fingerprint(new UserMergeCounts { UserDataMoved = 1 });

        Assert.Throws<UserMergeConflictException>(
            () => UserMergeService.EnsurePreviewStillCurrent(
                new UserMergeCounts { UserDataMoved = 2 },
                fingerprint));
    }

    [Fact]
    public async Task Merge_MissingPreviewTokenReturnsBadRequest()
    {
        var controller = CreateController();

        var result = await controller.Merge(
            new UserAdminTransferRequest { SourceUserId = SourceId, TargetUserId = TargetId },
            CancellationToken.None);

        Assert.IsType<BadRequestObjectResult>(result.Result);
    }

    [Fact]
    public async Task Merge_InvalidPreviewTokenReturnsConflict()
    {
        var controller = CreateController();

        var result = await controller.Merge(
            new UserAdminTransferRequest
            {
                SourceUserId = SourceId,
                TargetUserId = TargetId,
                PreviewToken = "invalid.token"
            },
            CancellationToken.None);

        Assert.IsType<ConflictObjectResult>(result.Result);
    }

    private static MergePreviewTokens CreateTokens()
        => new(Key, new TestTimeProvider(DateTimeOffset.Parse("2026-10-15T10:00:00Z")));

    private static UserAdminController CreateController()
    {
        var identity = new ClaimsIdentity(
            new[] { new Claim("Jellyfin-UserId", AdministratorId.ToString()) },
            "Test");
        return new UserAdminController(null!, CreateTokens())
        {
            ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext
                {
                    User = new ClaimsPrincipal(identity)
                }
            }
        };
    }

    private sealed class TestTimeProvider : TimeProvider
    {
        private DateTimeOffset _utcNow;

        public TestTimeProvider(DateTimeOffset utcNow)
        {
            _utcNow = utcNow;
        }

        public override DateTimeOffset GetUtcNow() => _utcNow;

        public void Advance(TimeSpan elapsed)
        {
            _utcNow += elapsed;
        }
    }
}
