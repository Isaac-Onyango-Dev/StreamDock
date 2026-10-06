import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  detectEpisodePattern, firstVariantUrl, inspectUrl, manifestProtection, parseSeriesApiCount, parseSeriesInfo, pickThumbnail, probeVerdict,
} from './playlist-inspector';

const mocks = vi.hoisted(() => ({ runProbeChild: vi.fn(), fetchWithDeadline: vi.fn(), extractManifest: vi.fn() }));
vi.mock('./probe-support', () => ({
  runProbeChild: mocks.runProbeChild,
  fetchWithDeadline: mocks.fetchWithDeadline,
  removeTempFile: vi.fn(),
}));
vi.mock('./manifest-extractor', () => ({ extractManifest: mocks.extractManifest }));
vi.mock('./binary-resolver', () => ({
  resolveYtDlpCommand: () => ({ command: 'yt-dlp', args: [] }),
  buildPluginDirArgs: () => [],
}));

/**
 * Markup shapes taken from the live anikoto.cz series page for Bleach — the
 * series behind the "probe returns 400-500+ episodes for a show that has 366"
 * report. The count is stated in the page itself; the previous probe never read
 * it, generating a fixed 200 synthetic entries and reporting `itemCount: 999`
 * whatever the series actually was.
 */
const REAL_PAGE = `
<meta property="og:image" content="https://cdn.anipixcdn.co/thumbnail/d58072be.jpg" />
<h1 itemprop="name" class="title d-title" data-jp="Bleach"> Bleach </h1>
<div class="meta">
  <div> MAL: <span> 7.8 </span> </div>
  <div>Duration: <span> 24m min</span></div>
  <div>Episodes: <span> 366</span></div>
</div>`;

describe('parseSeriesInfo', () => {
  it('reads the real episode count out of the page', () => {
    expect(parseSeriesInfo(REAL_PAGE).totalEpisodes).toBe(366);
  });

  it('reads the series title and poster', () => {
    const info = parseSeriesInfo(REAL_PAGE);
    expect(info.title).toBe('Bleach');
    expect(info.thumbnail).toBe('https://cdn.anipixcdn.co/thumbnail/d58072be.jpg');
  });

  it('reads schema.org numberOfEpisodes when a site publishes it instead', () => {
    expect(parseSeriesInfo('{"@type":"TVSeries","numberOfEpisodes":"1122"}').totalEpisodes).toBe(1122);
  });

  it('reports no count rather than guessing one when the page states none', () => {
    const info = parseSeriesInfo('<html><body><p>Watch now</p></body></html>');
    expect(info.totalEpisodes).toBeUndefined();
  });

  it('rejects an implausible count instead of trusting it', () => {
    // A stray five-digit number must not become an episode list.
    expect(parseSeriesInfo('Episodes: <span>99999</span>').totalEpisodes).toBeUndefined();
    expect(parseSeriesInfo('Episodes: <span>0</span>').totalEpisodes).toBeUndefined();
  });

  it('decodes HTML entities in the title', () => {
    const html = '<meta property="og:title" content="Fate&#039;s Edge &amp; Beyond" />';
    expect(parseSeriesInfo(html).title).toBe("Fate's Edge & Beyond");
  });

  it('falls back to og:title when the page has no itemprop title', () => {
    const html = '<meta property="og:title" content="One Piece" />';
    expect(parseSeriesInfo(html).title).toBe('One Piece');
  });
});

describe('pickThumbnail', () => {
  it('uses the scalar thumbnail when the extractor provides one', () => {
    expect(pickThumbnail({ thumbnail: 'https://img/one.jpg' })).toBe('https://img/one.jpg');
  });

  it('falls back to the thumbnails[] array --flat-playlist entries carry instead', () => {
    // Playlist rows showed a placeholder icon because only the scalar was read,
    // and flat entries never have one.
    const entry = {
      thumbnails: [
        { url: 'https://img/small.jpg' },
        { url: 'https://img/medium.jpg' },
        { url: 'https://img/large.jpg' },
      ],
    };
    expect(pickThumbnail(entry)).toBe('https://img/large.jpg');
  });

  it('skips trailing entries with no url rather than returning undefined', () => {
    const entry = { thumbnails: [{ url: 'https://img/real.jpg' }, {}] };
    expect(pickThumbnail(entry)).toBe('https://img/real.jpg');
  });

  it('returns undefined when there is genuinely nothing', () => {
    expect(pickThumbnail(null)).toBeUndefined();
    expect(pickThumbnail({})).toBeUndefined();
    expect(pickThumbnail({ thumbnails: [] })).toBeUndefined();
  });
});

/**
 * Episode patterns used to be two literal host regexes inside
 * detectEpisodePattern. anikototv.to is listed in every host array in
 * host-config.json and uses byte-for-byte the same URL shape as anikoto.cz,
 * but only anikoto.cz was written into that function — so the host Isaac
 * actually pastes never produced an episode range. The patterns are data now.
 *
 * These run against the hardcoded fallback config, because `electron` is mocked
 * in tests and the real host-config.json cannot be read; verify-engine asserts
 * the shipped file separately.
 */
describe('detectEpisodePattern', () => {
  it('resolves anikototv.to — the host that silently never matched', () => {
    const pattern = detectEpisodePattern('https://anikototv.to/watch/one-piece-odmau/ep-7');
    expect(pattern).not.toBeNull();
    expect(pattern?.currentEpisode).toBe(7);
    expect(pattern?.title).toBe('One Piece Odmau');
    expect(pattern?.createUrl(8)).toBe('https://anikototv.to/watch/one-piece-odmau/ep-8');
  });

  it('still resolves anikoto.cz', () => {
    const pattern = detectEpisodePattern('https://anikoto.cz/watch/bleach-yaa9n/ep-366');
    expect(pattern?.currentEpisode).toBe(366);
    expect(pattern?.createUrl(2)).toBe('https://anikoto.cz/watch/bleach-yaa9n/ep-2');
  });

  it('reads shuttletv episodes from the query parameter', () => {
    const pattern = detectEpisodePattern('https://shuttletv.su/watch/1368337?e=4');
    expect(pattern?.currentEpisode).toBe(4);
    expect(pattern?.title).toBe('ShuttleTV 1368337');
    expect(pattern?.createUrl(5)).toBe('https://shuttletv.su/watch/1368337?e=5');
  });

  it('declines a shuttletv URL with no episode parameter', () => {
    // The exact sample URL from the handover: it is in manifestProbeHosts but
    // carries no ?e=, so it is a single page and not an episode range.
    expect(detectEpisodePattern('https://shuttletv.su/watch/1368337')).toBeNull();
  });

  it('declines hosts with no configured pattern', () => {
    expect(detectEpisodePattern('https://youtube.com/watch?v=abc')).toBeNull();
    expect(detectEpisodePattern('https://reanime.to/watch/something/ep-1')).toBeNull();
  });

  it('declines an episode number of zero or below', () => {
    expect(detectEpisodePattern('https://shuttletv.su/watch/1368337?e=0')).toBeNull();
    expect(detectEpisodePattern('https://anikototv.to/watch/show-abc/ep-0')).toBeNull();
  });
});

/**
 * Markup copied verbatim from anikototv.to's One Piece episode 1 page.
 *
 * The page states no series total anywhere — this is the only "Episode <n>" on
 * it, and it is the episode you are looking at. The old count pattern allowed a
 * singular "Episode" with an optional colon, so it matched here and reported
 * "One Piece has 1 episodes", which both stated a falsehood and collapsed the
 * episode range to a single item.
 */
const EPISODE_PAGE = `
<div class="detail"> <div class="title">One Piece</div>
<div class="episode">Episode <span id="report-episode">1</span></div> </div>
<div class="server" data-id="1642"></div>`;

describe('parseSeriesInfo on an episode page', () => {
  it('does not read the current episode number as the series total', () => {
    expect(parseSeriesInfo(EPISODE_PAGE).totalEpisodes).toBeUndefined();
  });

  it('still reads a real "Episodes:" count from a series page', () => {
    expect(parseSeriesInfo('<div>Episodes: <span> 366</span></div>').totalEpisodes).toBe(366);
    expect(parseSeriesInfo('<div>Episodes:<b>1177</b></div>').totalEpisodes).toBe(1177);
  });
});

/**
 * Response shape from anikoto's own series API, which the episode page points
 * at via `data-id`. Counts here are the real ones measured for One Piece
 * (series 1642) on 2026-09-08.
 */
describe('parseSeriesApiCount', () => {
  it('prefers the listed episodes, which are the ones that actually exist', () => {
    const body = JSON.stringify({
      data: { anime: { is_sub: 1177, is_dub: 1155, episodes: '' }, episodes: Array.from({ length: 1177 }, (_, i) => ({ number: i + 1 })) },
    });
    expect(parseSeriesApiCount(body)).toBe(1177);
  });

  it('falls back to the highest per-language count when no list is present', () => {
    const body = JSON.stringify({ data: { anime: { is_sub: 1177, is_dub: 1155, episodes: '' } } });
    expect(parseSeriesApiCount(body)).toBe(1177);
  });

  it('returns undefined rather than throwing on anything unusable', () => {
    expect(parseSeriesApiCount('not json')).toBeUndefined();
    expect(parseSeriesApiCount('{}')).toBeUndefined();
    expect(parseSeriesApiCount(JSON.stringify({ data: { anime: {} } }))).toBeUndefined();
    expect(parseSeriesApiCount(JSON.stringify({ data: { anime: { is_sub: 0 } } }))).toBeUndefined();
  });
});

describe('the anikoto series-id lookup is configured', () => {
  it('extracts the series id the episode page carries', () => {
    // The pattern lives in host-config.json; this asserts the shape it targets.
    expect(EPISODE_PAGE.match(/data-id="(\d{1,10})"/i)?.[1]).toBe('1642');
  });
});

/**
 * The first bytes of a master playlist, captured 2026-10-06 from the embed
 * provider behind a reported URL, fetched with the referer its player sends.
 * HTTP 200 — and ciphertext, which only the page's own script can read. yt-dlp
 * calls it "Response data has no m3u header".
 */
const ENCRYPTED_MASTER =
  'UqGWqdAuZe8PLnsePbJatYGmj7ySL2AhJbzup81pOSA8oYq03CdkvHwuHgtFrj6s6LOOuogxd1troome7CAIYlPIgrzTWmWkay4eaHqaGcHoup24mFx4XE7rwon8Zk1JNKKPqNFJDbxpOA8LRb44sIG4mbaJ';

/** Playlist lines as the lab fixtures (and real players) write them. */
const FAIRPLAY_KEY = '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://lab-key",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"';
const WIDEVINE_HLS_KEY = '#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="data:text/plain;base64,AAAA",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"';
const AES128_KEY = '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x00000000000000000000000000000000';
const media = (key: string) => `#EXTM3U\n#EXT-X-VERSION:3\n${key}\n#EXTINF:2.0,\nseg000.ts\n#EXT-X-ENDLIST\n`;
const mpd = (protection: string) =>
  `<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011"><Period><AdaptationSet>${protection}</AdaptationSet></Period></MPD>`;

describe('manifestProtection', () => {
  it('calls a playlist only the page can read encrypted', () => {
    expect(manifestProtection(ENCRYPTED_MASTER)).toEqual({ kind: 'encrypted' });
  });

  it('passes real HLS and DASH, with or without a byte-order mark', () => {
    expect(manifestProtection('#EXTM3U\n#EXT-X-VERSION:3\n')).toBeNull();
    expect(manifestProtection(`${String.fromCharCode(0xfeff)}#EXTM3U`)).toBeNull();
    expect(manifestProtection(mpd(''))).toBeNull();
  });

  // The lab's AES-128 fixture downloads and decodes to the source's frames:
  // a key URI in the playlist is the standard, and yt-dlp handles it.
  it('passes standard AES-128, whose key the playlist itself points to', () => {
    expect(manifestProtection(media(AES128_KEY))).toBeNull();
    expect(manifestProtection(media(AES128_KEY.replace(',IV', ',KEYFORMAT="identity",IV')))).toBeNull();
  });

  it('names the DRM a playlist declares', () => {
    expect(manifestProtection(media(FAIRPLAY_KEY))).toEqual({ kind: 'drm', systems: ['FairPlay'] });
    expect(manifestProtection(media(WIDEVINE_HLS_KEY))).toEqual({ kind: 'drm', systems: ['Widevine'] });
    expect(manifestProtection(mpd('<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>' +
      '<ContentProtection schemeIdUri="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95"/>')))
      .toEqual({ kind: 'drm', systems: ['Widevine', 'PlayReady'] });
  });

  it('treats an unnamed protection scheme as DRM all the same', () => {
    expect(manifestProtection(media('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key.bin"'))).toEqual({ kind: 'drm', systems: [] });
    expect(manifestProtection(mpd('<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/>')))
      .toEqual({ kind: 'drm', systems: [] });
  });

  it('does not mistake a block page or an empty answer for protection', () => {
    expect(manifestProtection('<!DOCTYPE html><title>Attention Required! | Cloudflare</title>')).toBeNull();
    expect(manifestProtection('')).toBeNull();
    expect(manifestProtection(null)).toBeNull();
  });
});

describe('firstVariantUrl', () => {
  it('resolves the first variant of a master playlist against it', () => {
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=600000\nindex.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow.m3u8\n';
    expect(firstVariantUrl(master, 'https://cdn.example/v/master.m3u8?t=1')).toBe('https://cdn.example/v/index.m3u8');
  });

  it('has nothing to follow in a media playlist', () => {
    expect(firstVariantUrl(media(''), 'https://cdn.example/v/index.m3u8')).toBeNull();
  });
});

/**
 * One verdict on whether a URL can be downloaded.
 *
 * yt-dlp's "Unsupported URL" used to become support 'unknown' with that stderr
 * pasted in as a note: the preview said unsupported, the Download button stayed
 * enabled, and the engine queued the URL only to fail it with the same words.
 * The hidden browser that finds streams behind page players also never looked
 * at such a page, because it only opened for hosts listed in host-config.
 */
describe('inspectUrl verdict for a page no extractor claims', () => {
  const PAGE = 'https://videos.example/watch/clip-1?ep=1&lang=dub';
  const MASTER = 'https://cdn.videos.example/v/abc/master.m3u8?token=t';
  // exit 1, stdout "null", and this one line: the bundled yt-dlp on the reported URL.
  const NO_EXTRACTOR = { code: 1, stdout: 'null', stderr: `ERROR: Unsupported URL: ${PAGE}` };

  beforeEach(() => {
    mocks.runProbeChild.mockReset().mockResolvedValue(NO_EXTRACTOR);
    mocks.extractManifest.mockReset();
    mocks.fetchWithDeadline.mockReset();
  });

  const found = (extra: Record<string, unknown> = {}) =>
    ({ originalUrl: PAGE, manifestUrl: MASTER, type: 'm3u8', referer: 'https://player.example/', ...extra });
  const answer = (...bodies: string[]) => {
    for (const body of bodies) mocks.fetchWithDeadline.mockResolvedValueOnce({ status: 200, body, setCookies: [] });
  };

  it('blocks a stream its player loads encrypted, and says that is why', async () => {
    mocks.extractManifest.mockResolvedValue(found());
    answer(ENCRYPTED_MASTER);

    const probe = await inspectUrl(PAGE);
    expect(probe.support).toBe('unsupported');
    expect(probe.blocked).toBe('encrypted');
    expect(probe.notes).toEqual([expect.stringContaining('encrypted in a way only its own player can read')]);
    expect(probeVerdict(PAGE)).toEqual({ support: 'unsupported', reason: probe.notes[0] });
    // Checked the way the player fetched it, or a referer-gated CDN's block
    // page would be all there was to judge.
    expect(mocks.fetchWithDeadline).toHaveBeenCalledWith(MASTER, expect.objectContaining({ headers: { Referer: 'https://player.example/' } }));
  });

  // The lab's DRM fixture: the master is plain and the key lives in the variant.
  // It used to be queued and fail at download with "DRM-protected".
  it('blocks DRM declared in the first variant when the master declares none', async () => {
    mocks.extractManifest.mockResolvedValue(found());
    answer('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=600000\nindex.m3u8\n', media(FAIRPLAY_KEY));

    const probe = await inspectUrl(PAGE);
    expect(probe.blocked).toBe('drm');
    expect(probe.notes[0]).toMatch(/protected by FairPlay DRM/);
    expect(mocks.fetchWithDeadline).toHaveBeenLastCalledWith('https://cdn.videos.example/v/abc/index.m3u8', expect.anything());
  });

  // The lab's cookie fixture: the CDN serves only a session its player was given.
  it('checks the stream with the cookies the player had', async () => {
    mocks.extractManifest.mockResolvedValue(found({ cookieHeader: 'lab_session=granted' }));
    answer(media(''));
    await inspectUrl(PAGE);
    expect(mocks.fetchWithDeadline).toHaveBeenCalledWith(MASTER, expect.objectContaining({
      headers: { Referer: 'https://player.example/', Cookie: 'lab_session=granted' },
    }));
  });

  it('says no video was found, not that the site is unsupported, when the page loads no stream', async () => {
    mocks.extractManifest.mockResolvedValue(null);
    const probe = await inspectUrl(PAGE);
    expect(probe.support).toBe('unsupported');
    expect(probe.blocked).toBe('no-media');
    expect(probe.notes[0]).toMatch(/No video found/);
    expect(probe.notes[0]).not.toMatch(/not supported/);
  });

  it('cannot judge a stream that refuses the check, so leaves it downloadable', async () => {
    mocks.extractManifest.mockResolvedValue(found());
    mocks.fetchWithDeadline.mockResolvedValue({ status: 403, body: 'forbidden', setCookies: [] });
    expect((await inspectUrl(PAGE)).support).toBe('manifest-probe');
  });

  it('is a browser-resolved stream when its player loads a playlist yt-dlp can read', async () => {
    mocks.extractManifest.mockResolvedValue(found({ pageTitle: 'Clip 1 | Videos' }));
    answer('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n', media(AES128_KEY));
    const probe = await inspectUrl(PAGE);
    expect(probe.support).toBe('manifest-probe');
    expect(probe.blocked).toBeUndefined();
    expect(probeVerdict(PAGE)?.support).toBe('manifest-probe');
    // The single preview item names the file; it used to be placeholder text.
    expect(probe.preview).toEqual([{ title: 'Clip 1 | Videos' }]);
    // The track probe is handed this stream instead of opening the page in a
    // second hidden browser of its own.
    expect(probe.stream).toEqual({ url: MASTER, referer: 'https://player.example/' });
  });

  it('leaves a probe that failed for another reason undecided, and opens no browser for it', async () => {
    mocks.runProbeChild.mockResolvedValue({ code: 1, stdout: '', stderr: 'ERROR: [generic] Unable to download webpage: HTTP Error 403: Forbidden' });
    const probe = await inspectUrl(PAGE);
    expect(probe.support).toBe('unknown');
    expect(mocks.extractManifest).not.toHaveBeenCalled();
  });

  it('calls a reference index unsupported instead of leaving Download enabled for it', async () => {
    const probe = await inspectUrl('https://everythingmoe.com/anime/one-piece/episode-5');
    expect(probe.support).toBe('unsupported');
    expect(probe.blocked).toBe('reference-index');
    expect(mocks.runProbeChild).not.toHaveBeenCalled();
  });
});
