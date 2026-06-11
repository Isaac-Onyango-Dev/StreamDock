from .animepahe import (
    AnimepaheIE,
    AnimepahePlaylistIE,
    AnimepaheSearchIE,
)

for _cls in (
    AnimepaheIE,
    AnimepahePlaylistIE,
    AnimepaheSearchIE,
):
    _cls.__module__ = 'yt_dlp_plugins.extractor.animepahe'
    # Default :  yt_dlp_plugins.extractor.animepahe.animepahe
