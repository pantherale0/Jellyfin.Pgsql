using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics.CodeAnalysis;
using System.Linq;
using System.Reflection;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Controller.Entities;

namespace Jellyfin.Plugin.Pgsql.Query;

/// <summary>
/// Separates supported Resume criteria from the generic core resumability expression.
/// </summary>
internal static class ResumeQueryFilter
{
    private static readonly HashSet<string> HandledProperties = new(
        "User Recursive ParentId ParentType TopParentIds AncestorIds LinkedChildAncestorIds DescendantOfId ItemIds ExcludeItemIds IncludeItemTypes ExcludeItemTypes MediaTypes IsFolder IsVirtualItem IncludeOwnedItems IncludeAlternateVersions MaxParentalRating BlockUnratedItems ExcludeInheritedTags IncludeInheritedTags IsResumable OrderBy GroupByPresentationUniqueKey GroupBySeriesPresentationUniqueKey EnableGroupByMetadataKey CollapseBoxSetItems StartIndex Limit EnableTotalRecordCount DtoOptions SkipDeserialization HasFilters UserHasContentRestrictions".Split(' '),
        StringComparer.Ordinal);

    private static readonly string[] UnsupportedPropertyNames = "IsFavorite IsFavoriteOrLiked IsLiked IsPlayed IncludeItemsByName ExcludeTags Genres IsSpecialSeason IsMissing IsUnaired CollapseBoxSetItemTypes NameStartsWithOrGreater NameStartsWith NameLessThan NameContains MinSortName PresentationUniqueKey Path Name Person PersonIds OwnerIds ExtraTypes AdjacentTo PersonTypes Is3D IsHD IsLocked IsPlaceHolder HasImdbId HasOverview HasTmdbId HasOfficialRating HasTvdbId HasThemeSong HasThemeVideo HasSubtitles HasSpecialFeature HasTrailer HasParentalRating StudioIds GenreIds ImageTypes VideoTypes Years Tags OfficialRatings MinPremiereDate MaxPremiereDate MinStartDate MaxStartDate MinEndDate MaxEndDate IsAiring IsMovie IsSports IsKids IsNews IsSeries MinIndexNumber MinParentAndIndexNumber AiredDuringSeason MinCriticRating MinCommunityRating ChannelIds ParentIndexNumber ParentIndexNumberNotEquals IndexNumber MinParentalRating HasDeadParentId PresetViews TrailerTypes SourceTypes SeriesStatuses ExternalSeriesId ExternalId AlbumIds ArtistIds ExcludeArtistIds AncestorWithPresentationUniqueKey SeriesPresentationUniqueKey ForceDirect ExcludeProviderIds HasChapterImages MinDateCreated MinDateLastSaved MinDateLastSavedForUser HasNoAudioTrackWithLanguage HasNoInternalSubtitleTrackWithLanguage HasNoExternalSubtitleTrackWithLanguage HasNoSubtitleTrackWithLanguage IsDeadArtist IsDeadStudio IsDeadGenre IsDeadPerson DisplayAlbumFolders HasAnyProviderId HasAnyProviderIds AlbumArtistIds BoxSetLibraryFolders ContributingArtistIds HasAired HasOwnerId Is4K MaxHeight MaxWidth MinHeight MinWidth SearchTerm SeriesTimerId IncludeExtras AudioLanguages SubtitleLanguages".Split(' ');

    private static readonly PropertyInfo[] OtherProperties = typeof(InternalItemsQuery).GetProperties()
        .Where(p => p.CanRead && !HandledProperties.Contains(p.Name)).ToArray();

    /// <summary>Gets the explicitly reviewed public query property names.</summary>
    internal static IEnumerable<string> ClassifiedProperties => HandledProperties.Concat(UnsupportedPropertyNames);

    /// <summary>Copies supported restrictions without changing the caller's query.</summary>
    /// <param name="source">The original Resume request.</param>
    /// <param name="translatedFilter">Independent filter for core translation.</param>
    /// <returns>Whether this request can use candidate-first selection.</returns>
    internal static bool TryCreate(InternalItemsQuery source, [NotNullWhen(true)] out InternalItemsQuery? translatedFilter)
    {
        translatedFilter = null;
        if (source.User is null || source.IsResumable != true || source.IsFolder == true
            || source.IsVirtualItem == true || source.StartIndex < 0 || source.Limit < 0
            || source.GroupBySeriesPresentationUniqueKey || source.EnableGroupByMetadataKey
            || source.CollapseBoxSetItems == true || source.OrderBy.Count != 1
            || source.OrderBy[0] != (ItemSortBy.DatePlayed, SortOrder.Descending))
        {
            return false;
        }

        var defaults = new InternalItemsQuery(source.User);
        if (source.UserHasContentRestrictions != defaults.UserHasContentRestrictions
            || OtherProperties.Any(p => !SameValue(p.GetValue(source), p.GetValue(defaults))))
        {
            return false;
        }

        translatedFilter = new InternalItemsQuery(source.User)
        {
            Recursive = source.Recursive,
            ParentId = source.ParentId,
            ParentType = source.ParentType,
            TopParentIds = source.TopParentIds.ToArray(),
            AncestorIds = source.AncestorIds.ToArray(),
            LinkedChildAncestorIds = source.LinkedChildAncestorIds.ToArray(),
            DescendantOfId = source.DescendantOfId,
            ItemIds = source.ItemIds.ToArray(),
            ExcludeItemIds = source.ExcludeItemIds.ToArray(),
            IncludeItemTypes = source.IncludeItemTypes.ToArray(),
            ExcludeItemTypes = source.ExcludeItemTypes.ToArray(),
            MediaTypes = source.MediaTypes.ToArray(),
            IsFolder = source.IsFolder,
            IsVirtualItem = false,
            IncludeOwnedItems = source.IncludeOwnedItems,
            IncludeAlternateVersions = true,
            MaxParentalRating = source.MaxParentalRating,
            BlockUnratedItems = source.BlockUnratedItems.ToArray(),
            ExcludeInheritedTags = source.ExcludeInheritedTags.ToArray(),
            IncludeInheritedTags = source.IncludeInheritedTags.ToArray(),
        };
        return true;
    }

    private static bool SameValue(object? left, object? right)
    {
        if (left is IEnumerable a && right is IEnumerable b && left is not string)
        {
            return a.Cast<object?>().SequenceEqual(b.Cast<object?>());
        }

        return Equals(left, right);
    }
}
