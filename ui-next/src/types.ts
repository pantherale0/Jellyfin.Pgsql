export interface JellyfinUser {
    Id: string;
    Name: string;
    PrimaryImageTag?: string;
    HasPassword?: boolean;
    Policy?: { IsAdministrator?: boolean; IsDisabled?: boolean; EnableCollectionManagement?: boolean; EnableContentDeletion?: boolean; EnableContentDownloading?: boolean; EnableSubtitleManagement?: boolean; EnableLyricManagement?: boolean };
    Configuration?: UserConfiguration;
}

export interface UserConfiguration {
    EnableLocalPassword?: boolean;
    AudioLanguagePreference?: string;
    PlayDefaultAudioTrack?: boolean;
    RememberAudioSelections?: boolean;
    RememberSubtitleSelections?: boolean;
    EnableNextEpisodeAutoPlay?: boolean;
    SubtitleLanguagePreference?: string;
    SubtitleMode?: number | string;
    DisplayMissingEpisodes?: boolean;
    GroupedFolders?: string[];
    DisplayCollectionsView?: boolean;
    OrderedViews?: string[];
    LatestItemsExcludes?: string[];
    MyMediaExcludes?: string[];
    HidePlayedInLatest?: boolean;
    CastReceiverId?: string | null;
    [key: string]: unknown;
}

export interface TasteWeight {
    Label?: string;
    Weight?: number;
}

export interface TasteProfile {
    HasProfile?: boolean;
    SampleCount?: number;
    UpdatedAt?: string;
    Persona?: { Title?: string; Blurb?: string; Focus?: string; Bar?: string };
    Genres?: TasteWeight[];
    Tags?: TasteWeight[];
    Studios?: TasteWeight[];
    People?: Array<{ Name?: string; Role?: string }>;
    RatingMean?: number;
    RatingP25?: number | null;
}

export interface MediaItem {
    Id: string;
    Name: string;
    Type?: string;
    MediaType?: string;
    SortName?: string;
    CollectionType?: string;
    SeriesId?: string;
    SeriesName?: string;
    SeasonId?: string;
    IndexNumber?: number;
    ParentIndexNumber?: number;
    ChildCount?: number;
    PremiereDate?: string;
    DateCreated?: string;
    EndDate?: string;
    CumulativeRunTimeTicks?: number;
    Overview?: string;
    ProductionYear?: number;
    RunTimeTicks?: number;
    CommunityRating?: number;
    RecommendationType?: number;
    /** Hero eyebrow label stamped by the recommendation topic composer. */
    RecommendationLabel?: string;
    /** Pgsql taste match tier (`high` or `mid`) for For You items. */
    TasteTier?: string;
    BaselineItemName?: string;
    People?: Array<{ Name?: string; Type?: string; Id?: string; Role?: string; PrimaryImageTag?: string }>;
    OfficialRating?: string;
    CriticRating?: number;
    Taglines?: string[];
    ExternalUrls?: Array<{ Name?: string; Url?: string }>;
    Genres?: string[];
    GenreItems?: Array<{ Name?: string; Id?: string }>;
    Studios?: Array<{ Name?: string; Id?: string }>;
    Tags?: string[];
    AlbumArtists?: Array<{ Name?: string; Id?: string }>;
    AlbumArtist?: string;
    ArtistItems?: Array<{ Name?: string; Id?: string }>;
    Artists?: string[];
    Album?: string;
    AlbumId?: string;
    AlbumPrimaryImageTag?: string;
    /** LUFS-scan gain in dB (negative attenuates); albums carry their own album-level value. */
    NormalizationGain?: number;
    PlaylistItemId?: string;
    CanDelete?: boolean;
    CanDownload?: boolean;
    LocalTrailerCount?: number;
    RemoteTrailers?: Array<{ Url?: string; Name?: string }>;
    SpecialFeatureCount?: number;
    PartCount?: number;
    ExtraType?: string;
    Status?: string;
    PlayCount?: number;
    ImageTags?: { [key: string]: string };
    BackdropImageTags?: string[];
    UserData?: { PlayedPercentage?: number; Played?: boolean; PlaybackPositionTicks?: number; PlayedItemCount?: number; UnplayedItemCount?: number; IsFavorite?: boolean; PlayCount?: number };
    MediaSources?: Array<{ Id: string; Name?: string; Container?: string; Size?: number; Bitrate?: number; SupportsDirectPlay?: boolean; TranscodingUrl?: string; MediaStreams?: MediaItem['MediaStreams'] }>;
    MediaStreams?: Array<{ Type?: string | number; Codec?: string; DisplayTitle?: string; Profile?: string; Channels?: number; Width?: number; Height?: number; VideoRange?: string; VideoRangeType?: string; IsDefault?: boolean; Language?: string; BitRate?: number; Index?: number; IsExternal?: boolean; IsForced?: boolean; IsHearingImpaired?: boolean; Title?: string }>;
    ChannelId?: string;
    ChannelName?: string;
    ChannelNumber?: string;
    StartDate?: string;
    Width?: number;
    Height?: number;
    IsLive?: boolean;
    IsPremiere?: boolean;
    IsRepeat?: boolean;
    IsMovie?: boolean;
    IsSports?: boolean;
    IsSeries?: boolean;
    IsNews?: boolean;
    IsKids?: boolean;
    TimerId?: string;
    SeriesTimerId?: string;
    CurrentProgram?: MediaItem;
    Path?: string;
    IsFolder?: boolean;
    OriginalTitle?: string;
    ForcedSortName?: string;
    CustomRating?: string;
    ProviderIds?: Record<string, string>;
    LockData?: boolean;
    LockedFields?: string[];
    PreferredMetadataLanguage?: string;
    PreferredMetadataCountryCode?: string;
    AirsBeforeSeasonNumber?: number;
    AirsAfterSeasonNumber?: number;
    AirsBeforeEpisodeNumber?: number;
    AirDays?: string[];
    AirTime?: string;
    DisplayOrder?: string;
    Video3DFormat?: string;
    AspectRatio?: string;
}

export interface ItemResponse {
    Items: MediaItem[];
    TotalRecordCount?: number;
    StartIndex?: number;
}

export interface RecommendationGroup {
    Items: MediaItem[];
    RecommendationType: number;
    BaselineItemName?: string;
    CategoryId?: string;
}

export interface Session {
    server: string;
    token: string;
    user: JellyfinUser;
    serverId: string;
}

export type LiveTab = 'now' | 'guide' | 'channels' | 'dvr';

export type LiveChannelFilter = 'all' | 'favorites' | 'sports' | 'news' | 'movies' | 'kids';

export interface GuideInfo {
    StartDate?: string;
    EndDate?: string;
}

export interface LiveTimer {
    Id: string;
    Name?: string;
    Overview?: string;
    ChannelId?: string;
    ChannelName?: string;
    ProgramId?: string;
    StartDate?: string;
    EndDate?: string;
    Status?: string;
    SeriesTimerId?: string;
    PrePaddingSeconds?: number;
    PostPaddingSeconds?: number;
    IsPrePaddingRequired?: boolean;
    IsPostPaddingRequired?: boolean;
    RecordNewOnly?: boolean;
    RecordAnyChannel?: boolean;
    RecordAnyTime?: boolean;
    KeepUpTo?: number;
    [key: string]: unknown;
}
