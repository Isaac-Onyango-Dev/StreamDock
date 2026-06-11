import itertools
import re
from collections.abc import Iterator
from secrets import token_hex
from yt_dlp.extractor.common import InfoExtractor
from yt_dlp.utils import (
    ExtractorError,
    ISO639Utils,
    decode_packed_codes,
    parse_duration,
    str_to_int,
    get_element_by_class,
)


class AnimepaheBaseIE(InfoExtractor):
    PAHE_BASE_URL_RE = r'https://animepahe\.(?:com|pw|org)%s'
    _DATA_RE = re.compile(
        r'data-src="(?P<url>[^"]+)"\s*data-fansub="(?P<fnsub>[^"]+)"\s*data-resolution="(?P<height>[^"]+)"\s*data-audio="(?P<lang>[^"]+)"'
    )

    def _real_initialize(self) -> None:
        fake_ddg = token_hex(16)
        for s in ('com', 'pw', 'org'):
            self._set_cookie(f'.animepahe.{s}', '__ddg2_', fake_ddg)

    @staticmethod
    def title(title: str) -> str:
        clean = re.sub(r'animepahe|[\.:\',!]', '', title)
        return re.sub(r'\s+', ' ', clean).strip()

    @staticmethod
    def series(title: str) -> str:
        return re.sub(r'(?i)ep\s*\d+', '', title).strip()

    @staticmethod
    def episode_num(title: str) -> int | None:
        match = re.search(r'(?i)ep\s*(?P<num>\d+)', title)
        return str_to_int(match.group('num')) if match else None

    @staticmethod
    def _get_thumbnail(page: str) -> str | None:
        found = False
        for s in ('sequel', 'prequel'):
            src = get_element_by_class(f'{s} hidden-sm-down', page)
            if src is not None:
                found = True
                break
        if found is False:
            return None
        match = re.search(r'data-src="(?P<img>[^"]+)"', src)
        return match.group('img') if match else None

    def _yield_formats(self, content: str) -> Iterator[dict[str, str | int | dict[str, str]]]:
        for data in self._DATA_RE.finditer(content):
            if not (url := self._get_m3u8_url(data.group('url'))):
                continue
            yield {
                'url': url,
                'height': str_to_int(height := data.group('height')),
                'language': ISO639Utils.long2short(lang := data.group('lang')),
                'format_id': f'{height}-{lang}',
                'format_note': data.group('fnsub'),
                'ext': 'mp4',
                'http_headers': {'referer': 'https://kwik.cx/'},
            }

    def _get_m3u8_url(self, url: str) -> str | None:
        fatal = not self.get_param('ignore_no_formats_error')
        if (
            encoded_page := self._download_webpage(
                url,
                self._generic_id(url),
                note='Downloading encoded page',
                fatal=fatal,
                headers={'referer': 'https://animepahe.pw/'},
            )
        ) is False:
            return None
        decoded_page = decode_packed_codes(encoded_page)
        return self._search_regex(
            r'const\s*source\s*=\\\'(?P<url>[^\\]+)\\', decoded_page, name='m3u8 url', group='url', fatal=fatal
        )

    def _yield_entries(
        self, playlist_url: str, playlist_id: str, playlist_title: str, ie: str | object
    ) -> Iterator[dict[str, str | int | float]]:
        base_url = playlist_url.replace('/anime/', '/play/')
        for anime in self._fetch_page_entries(playlist_url, playlist_id):
            episode_num = str_to_int(anime.get('episode'))
            yield self.url_result(
                url_transparent=True,
                url=f'{base_url}/{anime.get("session")}',
                ie=ie,
                video_id=anime.get('id'),
                video_title=f'{playlist_title} Episode {episode_num}',
                episode_number=episode_num,
                duration=parse_duration(anime.get('duration')),
                thumbnail=anime.get('snapshot'),
                language=ISO639Utils.long2short(anime.get('audio')),
                series=playlist_title,
            )

    def _fetch_page_entries(self, url: str, playlist_id: str) -> Iterator[dict[str, str | int]]:
        for page_num in itertools.count(1):
            result = self._download_json(
                url_or_request='https://animepahe.pw/api',
                video_id=playlist_id,
                query={'m': 'release', 'id': playlist_id, 'sort': 'episode_asc', 'page': page_num},
                note=f'Downloading page {page_num}',
            )

            yield from self._yield_json(result)

            # End pagination if no next page is found.
            if not result.get('next_page_url'):
                break

    @staticmethod
    def _yield_json(j: dict) -> Iterator[dict[str, str | int]]:
        if not isinstance(j, dict) or not j:
            raise ExtractorError('Invalid JSON response: expected dict', expected=True)

        # Ensure data is a list before yielding.
        if isinstance(data := j.get('data'), list):
            yield from data


# vim: ft=python:nowrap
