using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.Pgsql.Search;
using Jellyfin.Plugin.Pgsql.Tests.Infrastructure;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Persistence;
using Microsoft.EntityFrameworkCore;
using Moq;
using Xunit;

namespace Jellyfin.Plugin.Pgsql.Tests.Search;

[Collection(PostgresCollection.Name)]
public sealed class PostgresFuzzySearchProviderIntegrationTests
{
    private static readonly Guid ExactTitleId = Guid.Parse("aaaaaaaa-bbbb-cccc-dddd-000000000001");
    private static readonly Guid TypoTitleId = Guid.Parse("aaaaaaaa-bbbb-cccc-dddd-000000000002");
    private static readonly Guid FamilyGenreId = Guid.Parse("aaaaaaaa-bbbb-cccc-dddd-000000000003");
    private static readonly Guid PunctuationTitleId = Guid.Parse("aaaaaaaa-bbbb-cccc-dddd-000000000004");
    private static readonly Guid UnrelatedId = Guid.Parse("aaaaaaaa-bbbb-cccc-dddd-000000000099");

    private readonly PostgresDatabaseFixture _fixture;

    public PostgresFuzzySearchProviderIntegrationTests(PostgresDatabaseFixture fixture)
    {
        _fixture = fixture;
    }

    [PostgresTestFact]
    public async Task SearchAsync_RejectsShortTerms_WithoutMatchingLongerNoise()
    {
        Assert.True(_fixture.IsAvailable, $"PostgreSQL fixture failed to initialize: {_fixture.InitializationError}");

        var factory = new TestDbContextFactory(_fixture.ConnectionString);
        await using var dbContext = await factory.CreateDbContextAsync().ConfigureAwait(false);
        await SeedSearchCorpusAsync(dbContext).ConfigureAwait(false);

        var provider = CreateProvider(factory);

        var shortResults = await provider.SearchAsync(
            new SearchProviderQuery { SearchTerm = "fa", EnableTotalRecordCount = false },
            default).ConfigureAwait(false);

        Assert.Empty(shortResults.Items);
        Assert.False(provider.CanSearch(new SearchProviderQuery { SearchTerm = "fa" }));
    }

    [PostgresTestFact]
    public async Task SearchAsync_RanksExactTitle_AboveGenreOnlyMatch()
    {
        Assert.True(_fixture.IsAvailable, $"PostgreSQL fixture failed to initialize: {_fixture.InitializationError}");

        var factory = new TestDbContextFactory(_fixture.ConnectionString);
        await using var dbContext = await factory.CreateDbContextAsync().ConfigureAwait(false);
        await SeedSearchCorpusAsync(dbContext).ConfigureAwait(false);

        var provider = CreateProvider(factory);
        var results = await provider.SearchAsync(
            new SearchProviderQuery { SearchTerm = "Family", EnableTotalRecordCount = false },
            default).ConfigureAwait(false);

        Assert.Contains(results.Items, r => r.ItemId == ExactTitleId);
        Assert.Contains(results.Items, r => r.ItemId == FamilyGenreId);

        var exactScore = results.Items.First(r => r.ItemId == ExactTitleId).Score;
        var genreScore = results.Items.First(r => r.ItemId == FamilyGenreId).Score;
        Assert.True(exactScore > genreScore, $"Expected exact title score {exactScore} > genre score {genreScore}");
    }

    [PostgresTestFact]
    public async Task SearchAsync_MatchesTypoViaTrigram()
    {
        Assert.True(_fixture.IsAvailable, $"PostgreSQL fixture failed to initialize: {_fixture.InitializationError}");

        var factory = new TestDbContextFactory(_fixture.ConnectionString);
        await using var dbContext = await factory.CreateDbContextAsync().ConfigureAwait(false);
        await SeedSearchCorpusAsync(dbContext).ConfigureAwait(false);

        var provider = CreateProvider(factory);
        var results = await provider.SearchAsync(
            new SearchProviderQuery { SearchTerm = "batmn", EnableTotalRecordCount = false },
            default).ConfigureAwait(false);

        Assert.Contains(results.Items, r => r.ItemId == TypoTitleId);
    }

    [PostgresTestFact]
    public async Task SearchAsync_MatchesPunctuationNormalizedTitle()
    {
        Assert.True(_fixture.IsAvailable, $"PostgreSQL fixture failed to initialize: {_fixture.InitializationError}");

        var factory = new TestDbContextFactory(_fixture.ConnectionString);
        await using var dbContext = await factory.CreateDbContextAsync().ConfigureAwait(false);
        await SeedSearchCorpusAsync(dbContext).ConfigureAwait(false);

        var provider = CreateProvider(factory);
        var results = await provider.SearchAsync(
            new SearchProviderQuery { SearchTerm = "mr robot", EnableTotalRecordCount = false },
            default).ConfigureAwait(false);

        Assert.Contains(results.Items, r => r.ItemId == PunctuationTitleId);
    }

    [PostgresTestFact]
    public async Task SearchAsync_DoesNotReturnUnrelatedItems()
    {
        Assert.True(_fixture.IsAvailable, $"PostgreSQL fixture failed to initialize: {_fixture.InitializationError}");

        var factory = new TestDbContextFactory(_fixture.ConnectionString);
        await using var dbContext = await factory.CreateDbContextAsync().ConfigureAwait(false);
        await SeedSearchCorpusAsync(dbContext).ConfigureAwait(false);

        var provider = CreateProvider(factory);
        var results = await provider.SearchAsync(
            new SearchProviderQuery { SearchTerm = "Family", EnableTotalRecordCount = false },
            default).ConfigureAwait(false);

        Assert.DoesNotContain(results.Items, r => r.ItemId == UnrelatedId);
    }

    private static PostgresFuzzySearchProvider CreateProvider(TestDbContextFactory factory)
    {
        var itemTypeLookup = new Mock<IItemTypeLookup>();
        itemTypeLookup.SetupGet(l => l.BaseItemKindNames).Returns(new Dictionary<BaseItemKind, string>
        {
            [BaseItemKind.Movie] = "Movie",
        });

        var libraryManager = new Mock<ILibraryManager>(MockBehavior.Strict);
        var userManager = new Mock<IUserManager>(MockBehavior.Strict);
        var queryHelpers = new Mock<IItemQueryHelpers>(MockBehavior.Strict);

        return new PostgresFuzzySearchProvider(
            factory,
            itemTypeLookup.Object,
            libraryManager.Object,
            userManager.Object,
            queryHelpers.Object);
    }

    private static async Task SeedSearchCorpusAsync(JellyfinDbContext dbContext)
    {
        Guid[] ids = [ExactTitleId, TypoTitleId, FamilyGenreId, PunctuationTitleId, UnrelatedId];
        var existing = await dbContext.BaseItems
            .Where(i => ids.Contains(i.Id))
            .Select(i => i.Id)
            .ToListAsync()
            .ConfigureAwait(false);

        if (existing.Count == ids.Length
            && await dbContext.ItemValuesMap.AnyAsync(m => m.ItemId == FamilyGenreId).ConfigureAwait(false))
        {
            return;
        }

        await dbContext.ItemValuesMap.Where(m => ids.Contains(m.ItemId)).ExecuteDeleteAsync().ConfigureAwait(false);
        await dbContext.BaseItems.Where(i => ids.Contains(i.Id)).ExecuteDeleteAsync().ConfigureAwait(false);

        var orphanValues = await dbContext.ItemValues
            .Where(v => !dbContext.ItemValuesMap.Any(m => m.ItemValueId == v.ItemValueId))
            .Where(v => v.CleanValue == "family")
            .ToListAsync()
            .ConfigureAwait(false);
        if (orphanValues.Count > 0)
        {
            dbContext.ItemValues.RemoveRange(orphanValues);
            await dbContext.SaveChangesAsync().ConfigureAwait(false);
        }

        dbContext.BaseItems.AddRange(
            Movie(ExactTitleId, "Family", "family"),
            Movie(TypoTitleId, "Batman", "batman"),
            Movie(FamilyGenreId, "The Incredibles", "the incredibles"),
            Movie(PunctuationTitleId, "Mr. Robot", "mr robot"),
            Movie(UnrelatedId, "Quantum Physics Lecture", "quantum physics lecture"));

        var familyGenre = new ItemValue
        {
            ItemValueId = Guid.Parse("bbbbbbbb-cccc-dddd-eeee-000000000001"),
            Type = ItemValueType.Genre,
            Value = "Family",
            CleanValue = "family",
        };

        if (!await dbContext.ItemValues.AnyAsync(v => v.ItemValueId == familyGenre.ItemValueId).ConfigureAwait(false))
        {
            dbContext.ItemValues.Add(familyGenre);
        }

        await dbContext.SaveChangesAsync().ConfigureAwait(false);

        if (!await dbContext.ItemValuesMap.AnyAsync(m => m.ItemId == FamilyGenreId && m.ItemValueId == familyGenre.ItemValueId).ConfigureAwait(false))
        {
            var item = await dbContext.BaseItems.SingleAsync(i => i.Id == FamilyGenreId).ConfigureAwait(false);
            var value = await dbContext.ItemValues.SingleAsync(v => v.ItemValueId == familyGenre.ItemValueId).ConfigureAwait(false);
            dbContext.ItemValuesMap.Add(new ItemValueMap
            {
                ItemId = FamilyGenreId,
                ItemValueId = familyGenre.ItemValueId,
                Item = item,
                ItemValue = value,
            });
            await dbContext.SaveChangesAsync().ConfigureAwait(false);
        }
    }

    private static BaseItemEntity Movie(Guid id, string name, string cleanName)
    {
        return new BaseItemEntity
        {
            Id = id,
            Type = "Movie",
            Name = name,
            CleanName = cleanName,
            MediaType = "Video",
            IsVirtualItem = false,
        };
    }
}
