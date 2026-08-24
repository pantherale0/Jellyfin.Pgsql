using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Plugin.Pgsql.Similar;
using Jellyfin.Plugin.Pgsql.Taste;
using Xunit;

namespace Jellyfin.Plugin.Pgsql.Tests.Taste;

public sealed class BecauseYouSourcePickerTests
{
    private static readonly Guid FranchiseA = Guid.Parse("aaaaaaaa-0000-0000-0000-000000000001");
    private static readonly Guid FranchiseB = Guid.Parse("bbbbbbbb-0000-0000-0000-000000000001");

    [Fact]
    public void Pick_SkipsSharedBoxSet_UntilFourSourcesThenFills()
    {
        var played = new List<BecauseYouSourceCandidate>
        {
            Movie(1, FranchiseA),
            Movie(2, FranchiseA),
            Movie(3, FranchiseB),
            Movie(4),
            Movie(5),
            Movie(6, FranchiseA),
        };

        var picked = BecauseYouSourcePicker.Pick(played, []);

        Assert.Equal(
            [
                Id(1),
                Id(3),
                Id(4),
                Id(5),
                Id(2),
                Id(6),
            ],
            picked.Select(s => s.ItemId).ToArray());
        Assert.All(picked, s => Assert.Equal(BecauseYouSourceKinds.RecentlyPlayed, s.Kind));
    }

    [Fact]
    public void Pick_RespectsPlayedAndLikedCaps_AndSkipsDuplicates()
    {
        var played = Enumerable.Range(1, 20).Select(i => Movie(i, i <= 3 ? FranchiseA : null)).ToList();
        var liked = new List<BecauseYouSourceCandidate>
        {
            Movie(1),
            Movie(21),
            Movie(22),
        };

        var picked = BecauseYouSourcePicker.Pick(played, liked);

        Assert.Equal(BecauseYouSourcePicker.MaxRecentlyPlayed, picked.Count(s => s.Kind == BecauseYouSourceKinds.RecentlyPlayed));
        Assert.Equal(2, picked.Count(s => s.Kind == BecauseYouSourceKinds.Liked));
        Assert.Equal(picked.Select(s => s.ItemId).Distinct().Count(), picked.Count);
        Assert.Contains(picked, s => s.ItemId == Id(21) && s.Kind == BecauseYouSourceKinds.Liked);
        Assert.DoesNotContain(picked, s => s.ItemId == Id(1) && s.Kind == BecauseYouSourceKinds.Liked);
    }

    [Fact]
    public void SelectTasteRerankIds_TakesTopKPerSource()
    {
        var sourceA = Guid.Parse("11111111-1111-1111-1111-111111111111");
        var sourceB = Guid.Parse("22222222-2222-2222-2222-222222222222");
        var maps = new Dictionary<Guid, Dictionary<Guid, int>>
        {
            [sourceA] = Enumerable.Range(0, 10).ToDictionary(i => Id(100 + i), i => 10 - i),
            [sourceB] = Enumerable.Range(0, 10).ToDictionary(i => Id(200 + i), i => i),
        };

        var ids = PostgresMovieSimilarItemsProvider.SelectTasteRerankIds(maps, capPerSource: 3);

        Assert.Equal(6, ids.Count);
        Assert.Contains(Id(100), ids);
        Assert.Contains(Id(101), ids);
        Assert.Contains(Id(102), ids);
        Assert.DoesNotContain(Id(109), ids);
        Assert.Contains(Id(209), ids);
        Assert.Contains(Id(208), ids);
        Assert.Contains(Id(207), ids);
        Assert.DoesNotContain(Id(200), ids);
    }

    [Fact]
    public void TryPredict_ReturnsNull_WhenUseNeuralIsFalse()
    {
        var result = TasteNeuralScoring.TryPredict(
            store: null!,
            profile: new UserTasteFeaturePayload(),
            featuresByItem: new Dictionary<Guid, TasteCandidateFeatures>(),
            itemIds: [Guid.NewGuid()],
            useNeural: false);

        Assert.Null(result);
    }

    private static Guid Id(int n) => Guid.Parse($"00000000-0000-0000-0000-{n:D12}");

    private static BecauseYouSourceCandidate Movie(int n, Guid? boxSet = null)
        => new(Id(n), boxSet is Guid id ? [id] : []);
}
