export const FIXTURE_CREDENTIALS = Object.freeze({
    username: 'e2e-user',
    password: 'e2e-password',
    accessToken: 'e2e-access-token',
    serverId: 'e2e-server-id'
});

const movie = (index, name, year, extra = {}) => ({
    Id: `e2e-movie-${index}`,
    Name: name,
    Type: 'Movie',
    MediaType: 'Video',
    ParentId: 'e2e-movies-library',
    ProductionYear: year,
    RunTimeTicks: 300_000_000,
    ImageTags: { Primary: `movie-${index}-image` },
    UserData: { Played: false, IsFavorite: false, PlaybackPositionTicks: 0 },
    ...extra
});

const episode = (index, seasonIndex, episodeIndex) => ({
    Id: `e2e-episode-${index}`,
    Name: episodeIndex === 1 && seasonIndex === 1 ? 'E2E Episode One' : `E2E Episode ${[ 'Zero', 'One', 'Two', 'Three' ][episodeIndex] || episodeIndex}`,
    Type: 'Episode',
    MediaType: 'Video',
    ParentId: `e2e-season-${seasonIndex}`,
    SeriesId: 'e2e-series-1',
    SeriesName: 'E2E Series',
    ParentIndexNumber: seasonIndex,
    IndexNumber: episodeIndex,
    Overview: 'A deterministic episode.',
    RunTimeTicks: 300_000_000,
    ImageTags: { Primary: `episode-${index}-image` },
    UserData: { Played: false, IsFavorite: false, PlaybackPositionTicks: 0 }
});

const defaultState = {
    serverInfo: {
        Id: FIXTURE_CREDENTIALS.serverId,
        ServerName: 'UI Next E2E',
        Version: '10.11.0',
        StartupWizardCompleted: true,
        ProductName: 'Jellyfin'
    },
    user: {
        Id: 'e2e-user-id',
        Name: 'E2E User',
        ServerId: FIXTURE_CREDENTIALS.serverId,
        HasPassword: true,
        Configuration: {
            EnableNextEpisodeAutoPlay: true,
            DisplayCollectionsView: false
        },
        Policy: {
            IsAdministrator: false,
            IsHidden: false,
            EnableMediaPlayback: true,
            EnableAudioPlayback: true,
            EnableVideoPlayback: true
        }
    },
    publicUsers: [
        { Id: 'e2e-user-id', Name: 'E2E User', HasPassword: true }
    ],
    views: [
        {
            Id: 'e2e-movies-library',
            Name: 'Movies',
            Type: 'CollectionFolder',
            CollectionType: 'movies',
            IsFolder: true,
            ImageTags: { Primary: 'movies-image' }
        },
        {
            Id: 'e2e-shows-library',
            Name: 'Shows',
            Type: 'CollectionFolder',
            CollectionType: 'tvshows',
            IsFolder: true,
            ImageTags: { Primary: 'shows-image' }
        }
    ],
    // Six movies fill a 5-column TV grid across two rows; two seasons give the
    // show detail a season sidebar and an episode feed to navigate.
    items: [
        movie(1, 'E2E Movie One', 2024, { Overview: 'A deterministic movie for browser playback tests.' }),
        movie(2, 'E2E Movie Two', 2023, { Overview: 'A second movie for the generated catalog.', UserData: { Played: false, IsFavorite: true, PlaybackPositionTicks: 0 } }),
        movie(3, 'E2E Movie Three', 2022),
        movie(4, 'E2E Movie Four', 2021),
        movie(5, 'E2E Movie Five', 2020),
        movie(6, 'E2E Movie Six', 2019),
        {
            Id: 'e2e-series-1',
            Name: 'E2E Series',
            Type: 'Series',
            MediaType: 'Video',
            ParentId: 'e2e-shows-library',
            Overview: 'A series for the generated catalog.',
            ProductionYear: 2022,
            ImageTags: { Primary: 'series-image' },
            UserData: { Played: false, IsFavorite: false, PlaybackPositionTicks: 0 }
        },
        {
            Id: 'e2e-season-1',
            Name: 'Season 1',
            Type: 'Season',
            ParentId: 'e2e-series-1',
            SeriesId: 'e2e-series-1',
            SeriesName: 'E2E Series',
            IndexNumber: 1,
            ChildCount: 2,
            ImageTags: { Primary: 'season-one-image' },
            UserData: { Played: false }
        },
        {
            Id: 'e2e-season-2',
            Name: 'Season 2',
            Type: 'Season',
            ParentId: 'e2e-series-1',
            SeriesId: 'e2e-series-1',
            SeriesName: 'E2E Series',
            IndexNumber: 2,
            ChildCount: 1,
            ImageTags: { Primary: 'season-two-image' },
            UserData: { Played: false }
        },
        episode(1, 1, 1),
        episode(2, 1, 2),
        episode(3, 2, 1)
    ],
    resumeItems: [],
    latestItems: [],
    nextUpItems: [],
    recommendationGroups: [],
    playbackInfo: {
        PlaySessionId: 'e2e-play-session',
        MediaSources: [
            {
                Id: 'e2e-media-source',
                Name: 'E2E WebM',
                Container: 'webm',
                SupportsDirectPlay: true,
                SupportsDirectStream: true,
                SupportsTranscoding: true,
                Bitrate: 500_000,
                RunTimeTicks: 300_000_000,
                DefaultAudioStreamIndex: 1,
                MediaStreams: [
                    {
                        Type: 'Video',
                        Codec: 'vp8',
                        Index: 0,
                        IsDefault: true,
                        Width: 320,
                        Height: 180,
                        BitRate: 350_000
                    },
                    {
                        Type: 'Audio',
                        Codec: 'opus',
                        Index: 1,
                        IsDefault: true,
                        Channels: 2,
                        SampleRate: 48_000,
                        BitRate: 96_000
                    }
                ]
            }
        ]
    }
};

defaultState.resumeItems = [
    { ...defaultState.items[0], UserData: { ...defaultState.items[0].UserData, PlaybackPositionTicks: 30_000_000 } }
];
defaultState.latestItems = defaultState.items.slice(0, 3);
defaultState.nextUpItems = [ defaultState.items.find(item => item.Id === 'e2e-episode-1') ];

export function createFixtureState() {
    return structuredClone(defaultState);
}
