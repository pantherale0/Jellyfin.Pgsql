using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Emby.Server.Implementations.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Extensions;
using Jellyfin.Plugin.Pgsql.Configuration;
using Jellyfin.Plugin.Pgsql.Query;
using Jellyfin.Plugin.Pgsql.Tests.Infrastructure;
using Jellyfin.Server.Implementations.Item;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Model.Configuration;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;

namespace Jellyfin.Plugin.Pgsql.Tests.Query;

internal sealed class ResumeQueryTestFixture : IDisposable
{
    private readonly Guid _prefix = Guid.NewGuid();
    private int _dataKey;
    private readonly List<Guid> _extraUsers = [];
    private readonly List<Guid> _tagValues = [];

    public ResumeQueryTestFixture(PostgresDatabaseFixture database, params IInterceptor[] interceptors)
    {
        if (!database.IsAvailable)
        {
            throw new InvalidOperationException(database.InitializationError);
        }

        Factory = new TestDbContextFactory(database.ConnectionString, interceptors);
        User = new User("resume-" + _prefix.ToString("N"), "auth", "reset");
        LibraryId = Guid.NewGuid();
        using var context = Factory.CreateDbContext();
        context.Users.Add(User);
        context.SaveChanges();
        var configuration = new Mock<IServerConfigurationManager>();
        configuration.Setup(c => c.Configuration).Returns(new ServerConfiguration());
        Core = new BaseItemRepository(Factory, new Mock<IServerApplicationHost>().Object,
            new ItemTypeLookup(), configuration.Object, NullLogger<BaseItemRepository>.Instance);
        Loader = new CachedItemLoader(Factory, Core, NullLogger<CachedItemLoader>.Instance);
    }

    public TestDbContextFactory Factory { get; }

    public User User { get; }

    public Guid LibraryId { get; }

    public BaseItemRepository Core { get; }

    public CachedItemLoader Loader { get; }

    public Guid Id(int value) => Guid.Parse(_prefix.ToString("N")[..24] + value.ToString("x8", CultureInfo.InvariantCulture));

    public InternalItemsQuery Query() => new(User)
    {
        IsResumable = true,
        IsVirtualItem = false,
        IncludeOwnedItems = true,
        OrderBy = [(ItemSortBy.DatePlayed, SortOrder.Descending)],
        MediaTypes = [MediaType.Video],
        TopParentIds = [LibraryId],
        Limit = 12,
        SkipDeserialization = true,
        DtoOptions = new DtoOptions(false),
    };

    public PgResumeQuery Selector(PluginConfiguration? configuration = null) => new(
        Factory, Core, Loader, PgsqlQueryOptions.Resolve(configuration ?? new PluginConfiguration()),
        NullLogger<PgResumeQuery>.Instance);

    public void AddItem(int id, int? primary = null, int? rating = 100, bool folder = false)
    {
        using var context = Factory.CreateDbContext();
        context.BaseItems.Add(new BaseItemEntity
        {
            Id = Id(id),
            Type = folder ? typeof(MediaBrowser.Controller.Entities.TV.Series).FullName! : typeof(MediaBrowser.Controller.Entities.Movies.Movie).FullName!,
            Name = "Item " + id.ToString(CultureInfo.InvariantCulture),
            SortName = id.ToString("D4", CultureInfo.InvariantCulture),
            MediaType = "Video",
            TopParentId = LibraryId,
            PrimaryVersionId = primary.HasValue ? Id(primary.Value) : null,
            InheritedParentalRatingValue = rating,
            UnratedType = "Movie",
            IsFolder = folder,
            PresentationUniqueKey = Id(primary ?? id).ToString("N"),
            Data = "{}",
        });
        context.SaveChanges();
    }

    public void AddProgress(int id, int? day, Guid? userId = null)
    {
        using var context = Factory.CreateDbContext();
        context.UserData.Add(new UserData
        {
            ItemId = Id(id),
            UserId = userId ?? User.Id,
            CustomDataKey = "resume-" + (++_dataKey).ToString(CultureInfo.InvariantCulture),
            PlaybackPositionTicks = 100,
            LastPlayedDate = day.HasValue ? new DateTime(2026, 10, day.Value, 0, 0, 0, DateTimeKind.Utc) : null,
            Item = null!,
            User = null!,
        });
        context.SaveChanges();
    }

    public User AddUser()
    {
        var user = new User("resume-other-" + Guid.NewGuid().ToString("N"), "auth", "reset");
        using var context = Factory.CreateDbContext();
        context.Users.Add(user);
        context.SaveChanges();
        _extraUsers.Add(user.Id);
        return user;
    }

    public void AddTag(int id, string tag)
    {
        using var context = Factory.CreateDbContext();
        var value = context.ItemValues.FirstOrDefault(v => v.Type == ItemValueType.Tags && v.Value == tag);
        if (value is null)
        {
            value = new ItemValue { ItemValueId = Guid.NewGuid(), Type = ItemValueType.Tags, Value = tag, CleanValue = tag.GetCleanValue() };
            _tagValues.Add(value.ItemValueId);
        }

        context.ItemValuesMap.Add(new ItemValueMap
        {
            ItemId = Id(id), ItemValueId = value.ItemValueId,
            Item = context.BaseItems.Single(i => i.Id == Id(id)), ItemValue = value,
        });
        context.SaveChanges();
    }

    public void AddUnrelatedItems(int count, int start)
    {
        using var context = Factory.CreateDbContext();
        context.BaseItems.AddRange(Enumerable.Range(start, count).Select(i => new BaseItemEntity
        {
            Id = Id(i), Type = typeof(MediaBrowser.Controller.Entities.Movies.Movie).FullName!,
            Name = "Unwatched", SortName = "Unwatched", MediaType = "Video", TopParentId = LibraryId,
            InheritedParentalRatingValue = 100, PresentationUniqueKey = Id(i).ToString("N"), Data = "{}",
        }));
        context.SaveChanges();
    }

    public void Dispose()
    {
        using var context = Factory.CreateDbContext();
        context.Users.Where(u => u.Id == User.Id).ExecuteDelete();
        context.Users.Where(u => _extraUsers.Contains(u.Id)).ExecuteDelete();
        context.LinkedChildren.Where(lc => context.BaseItems.Any(i => i.TopParentId == LibraryId && (i.Id == lc.ParentId || i.Id == lc.ChildId))).ExecuteDelete();
        context.AncestorIds.Where(a => context.BaseItems.Any(i => i.TopParentId == LibraryId && (i.Id == a.ItemId || i.Id == a.ParentItemId))).ExecuteDelete();
        context.BaseItems.Where(i => i.TopParentId == LibraryId).ExecuteDelete();
        context.ItemValues.Where(v => _tagValues.Contains(v.ItemValueId)).ExecuteDelete();
    }
}
