using System.Text.Json;
using System.Text.Json.Serialization;
using Jellyfin.Plugin.Seerr.Models;
using Xunit;

namespace Jellyfin.Plugin.Seerr.Tests;

public sealed class SeerrDtoJsonContractTests
{
    /// <summary>
    /// Mimics Jellyfin's default API formatter (PascalCase naming policy).
    /// JsonPropertyName attributes must still force camelCase for web clients.
    /// </summary>
    private static readonly JsonSerializerOptions PascalCaseOptions = new()
    {
        PropertyNamingPolicy = null,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Converters = { new JsonStringEnumConverter() }
    };

    [Fact]
    public void StatusResponse_SerializesCamelCase_UnderPascalCasePolicy()
    {
        var json = JsonSerializer.Serialize(new SeerrStatusResponse { Enabled = true }, PascalCaseOptions);

        Assert.Contains("\"enabled\":true", json, System.StringComparison.Ordinal);
        Assert.DoesNotContain("\"Enabled\"", json, System.StringComparison.Ordinal);
    }

    [Fact]
    public void SearchResponse_SerializesCamelCaseItemFields_UnderPascalCasePolicy()
    {
        var payload = new SeerrSearchResponse
        {
            Items =
            [
                new SeerrSearchItem
                {
                    MediaType = "movie",
                    MediaId = 42,
                    Title = "Backrooms",
                    Year = 2026,
                    Overview = "Liminal spaces.",
                    PosterUrl = "https://example.com/poster.jpg",
                    Status = SeerrMediaStatus.Unknown,
                    CanRequest = true
                }
            ]
        };

        var json = JsonSerializer.Serialize(payload, PascalCaseOptions);

        Assert.Contains("\"items\":", json, System.StringComparison.Ordinal);
        Assert.Contains("\"mediaType\":\"movie\"", json, System.StringComparison.Ordinal);
        Assert.Contains("\"mediaId\":42", json, System.StringComparison.Ordinal);
        Assert.Contains("\"title\":\"Backrooms\"", json, System.StringComparison.Ordinal);
        Assert.Contains("\"year\":2026", json, System.StringComparison.Ordinal);
        Assert.Contains("\"overview\":\"Liminal spaces.\"", json, System.StringComparison.Ordinal);
        Assert.Contains("\"posterUrl\":", json, System.StringComparison.Ordinal);
        Assert.Contains("\"status\":\"Unknown\"", json, System.StringComparison.Ordinal);
        Assert.Contains("\"canRequest\":true", json, System.StringComparison.Ordinal);

        Assert.DoesNotContain("\"Items\"", json, System.StringComparison.Ordinal);
        Assert.DoesNotContain("\"MediaType\"", json, System.StringComparison.Ordinal);
        Assert.DoesNotContain("\"CanRequest\"", json, System.StringComparison.Ordinal);
    }

    [Fact]
    public void RequestAndTestResponses_SerializeCamelCase_UnderPascalCasePolicy()
    {
        var requestJson = JsonSerializer.Serialize(
            new SeerrRequestResponse { RequestId = 7, Message = "Requested" },
            PascalCaseOptions);
        var testJson = JsonSerializer.Serialize(
            new SeerrTestResponse { Version = "2.0.0", Message = "ok" },
            PascalCaseOptions);

        Assert.Contains("\"requestId\":7", requestJson, System.StringComparison.Ordinal);
        Assert.Contains("\"message\":\"Requested\"", requestJson, System.StringComparison.Ordinal);
        Assert.Contains("\"version\":\"2.0.0\"", testJson, System.StringComparison.Ordinal);
        Assert.Contains("\"message\":\"ok\"", testJson, System.StringComparison.Ordinal);

        Assert.DoesNotContain("\"RequestId\"", requestJson, System.StringComparison.Ordinal);
        Assert.DoesNotContain("\"Version\"", testJson, System.StringComparison.Ordinal);
    }

    [Fact]
    public void RequestBody_DeserializesCamelCase()
    {
        const string json = """{"mediaType":"tv","mediaId":99}""";
        var body = JsonSerializer.Deserialize<SeerrRequestBody>(json, PascalCaseOptions);

        Assert.NotNull(body);
        Assert.Equal("tv", body.MediaType);
        Assert.Equal(99, body.MediaId);
    }
}
