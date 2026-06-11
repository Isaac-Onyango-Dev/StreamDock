__version__ = '2026.5.25'

from collections.abc import Iterator
from typing import Any

from yt_dlp.extractor.common import SearchInfoExtractor
from yt_dlp.utils import (
    ExtractorError,
    LazyList,
    get_element_by_id,
)

from .common import AnimepaheBaseIE as PaheIE


class AnimepaheIE(PaheIE):
    IE_DESC = 'extractor for animepahe'
    IE_NAME = 'animepahe'
    _VALID_URL = PaheIE.PAHE_BASE_URL_RE % r'/play/(?P<pid>[^/]+)/(?P<id>[\w-]+)$'
    _TESTS = [
        {
            'url': 'https://animepahe.pw/play/4345ecb4-38a3-3659-dfbb-bf096dc824f7/ef8cf522fbee44f1310aba148ee74347c43082072739aeadbf552723632178d0',
            'info_dict': {
                'id': 'ef8cf522fbee44f1310aba148ee74347c43082072739aeadbf552723632178d0',
                'ext': 'mp4',
                'title': 'I Made Friends with the Second Prettiest Girl in My Class Ep 3',
                'fulltitle': 'I Made Friends with the Second Prettiest Girl in My Class Ep 3',
                'series': 'I Made Friends with the Second Prettiest Girl in My Class',
                'episode_number': 3,
                'episode': 'Episode 3',
                'display_id': 'ef8cf522fbee44f1310aba148ee74347c43082072739aeadbf552723632178d0',
                'playlist_id': '4345ecb4-38a3-3659-dfbb-bf096dc824f7',
            },
            'params': {'skip_download': True},
        },
        {
            'url': 'https://animepahe.pw/play/31e2b443-9988-8d32-44e2-0c153d9292ca/61684fba52afe21da41641c07b6a330712de4337ab23e7feda7315787a4d04f2',
            'info_dict': {
                'id': '61684fba52afe21da41641c07b6a330712de4337ab23e7feda7315787a4d04f2',
                'ext': 'mp4',
                'title': 'Jujutsu Kaisen Ep 24',
                'episode_id': '61684fba52afe21da41641c07b6a330712de4337ab23e7feda7315787a4d04f2',
                'playlist_id': '31e2b443-9988-8d32-44e2-0c153d9292ca',
                'series': 'Jujutsu Kaisen',
                'episode_number': 24,
            },
            'params': {'skip_download': True},
        },
    ]

    def _real_extract(self, url: str) -> dict[str, Any]:
        playlist_id, video_id = self._match_valid_url(url).groups()
        episode_page = self._download_webpage(url, video_id[:5])
        if (content := get_element_by_id('resolutionMenu', episode_page)) is None:
            raise ExtractorError('No results found; maybe a wrong ID?', expected=True)

        return {
            'id': video_id,
            'title': (title := self.title(self._html_extract_title(episode_page))),
            'episode_id': video_id,
            'playlist_id': playlist_id,
            'series': self.series(title),
            'thumbnail': self._get_thumbnail(episode_page),
            'episode_number': self.episode_num(title),
            'formats': LazyList(self._yield_formats(content)),
        }


class AnimepahePlaylistIE(PaheIE):
    IE_NAME = AnimepaheIE.IE_NAME + ':playlist'
    _VALID_URL = PaheIE.PAHE_BASE_URL_RE % r'/anime/(?P<id>[\w-]+)$'
    _TESTS = [
        {
            'url': 'https://animepahe.pw/anime/4345ecb4-38a3-3659-dfbb-bf096dc824f7',
            'playlist_mincount': 3,
            'info_dict': {
                'id': '4345ecb4-38a3-3659-dfbb-bf096dc824f7',
                'title': 'I Made Friends with the Second Prettiest Girl in My Class',
                'description': 'I, Maehara Maki, struggled to connect with anyone during my high school years, finding it hard to make friends.',
            },
            'params': {'skip_download': True},
        },
        {
            'url': 'https://animepahe.pw/anime/9a7915f2-bce3-9c73-cd10-4d8c4aaa46d3',
            'playlist_count': 12,
            'info_dict': {
                'id': '9a7915f2-bce3-9c73-cd10-4d8c4aaa46d3',
                'title': 'A Bridge to the Starry Skies',
                'description': 'Kazuma Hoshino is preparing himself for a new stage of his life as a teenager.',
            },
            'params': {'skip_download': True},
        },
        {
            'url': 'https://animepahe.pw/anime/31e2b443-9988-8d32-44e2-0c153d9292ca',
            'playlist_count': 24,
            'info_dict': {
                'id': '31e2b443-9988-8d32-44e2-0c153d9292ca',
                'title': 'Jujutsu Kaisen',
                'description': 'Idly indulging in baseless paranormal activities with the Occult Club, high schooler Yuuji Itadori spends his days at either the clubroom or the hospital, where he visits his bedridden grandfather.',
            },
            'params': {'skip_download': True},
        },
    ]

    def _real_extract(self, url: str) -> dict[str, Any]:
        playlist_id = self._match_id(url)
        playlist_page = self._download_webpage(url, playlist_id[:5])
        playlist_title = self.title(self._og_search_title(playlist_page))
        return self.playlist_result(
            entries=self._yield_entries(url, playlist_id, playlist_title, AnimepaheIE),
            playlist_id=playlist_id,
            playlist_title=playlist_title,
            playlist_description=self._og_search_description(playlist_page),
        )


class AnimepaheSearchIE(SearchInfoExtractor, PaheIE):
    IE_NAME = AnimepaheIE.IE_NAME + ':search'
    _SEARCH_KEY = r'(?:anime)?pahe(?:search)?'
    _TESTS = [
        {
            'url': 'animepahe:higehiro',
            'playlist_count': 1,
            'info_dict': {
                'id': 'higehiro',
                'title': 'higehiro',
            },
            'params': {'skip_download': True},
        },
        {
            'url': 'animepahe3:jujutsu kaisen',
            'playlist_count': 3,
            'info_dict': {
                'id': 'jujutsu kaisen',
                'title': 'jujutsu kaisen',
            },
            'params': {'skip_download': True},
        },
        {
            'url': 'animepahesearch:marriagetoxin',
            'playlist_count': 1,
            'info_dict': {
                'id': 'marriagetoxin',
                'title': 'marriagetoxin',
            },
            'params': {'skip_download': True},
        },
    ]

    def _search_results(self, query: str) -> Iterator[dict[str, Any]]:
        result = self._download_json('https://animepahe.pw/api', query, query={'m': 'search', 'q': query})
        if result.get('from') is None:
            raise ExtractorError(f'unable to search {query}', expected=True)

        for data_json in self._yield_json(result):
            yield self.url_result(
                url=f'https://animepahe.pw/anime/{data_json.get("session")}',
                ie=AnimepahePlaylistIE.ie_key(),
                video_id=data_json.get('id'),
                video_title=data_json.get('title'),
            )
