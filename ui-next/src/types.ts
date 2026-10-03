export interface JellyfinUser {
    Id: string;
    Name: string;
    PrimaryImageTag?: string;
    HasPassword?: boolean;
    Policy?: { IsAdministrator?: boolean; IsDisabled?: boolean };
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
}

export interface MediaItem {
    Id: string;
    Name: string;
    Type?: string;
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
    BaselineItemName?: string;
    People?: Array<{ Name?: string; Type?: string }>;
    ImageTags?: { [key: string]: string };
    BackdropImageTags?: string[];
    UserData?: { PlayedPercentage?: number; Played?: boolean; PlaybackPositionTicks?: number; PlayedItemCount?: number; UnplayedItemCount?: number; IsFavorite?: boolean };
    MediaSources?: Array<{ Id: string; SupportsDirectPlay?: boolean; TranscodingUrl?: string }>;
    MediaStreams?: Array<{ Type?: string | number; Codec?: string; DisplayTitle?: string; Profile?: string; Channels?: number; Width?: number; Height?: number; VideoRange?: string; VideoRangeType?: string; IsDefault?: boolean }>;
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
}
