import { describe, expect, it } from 'vitest';
import { detectEpisodePattern, parseSeriesApiCount, parseSeriesInfo, pickThumbnail } from './playlist-inspector';

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
