import { describe, expect, it } from 'vitest';
import { parseSeriesInfo, pickThumbnail } from './playlist-inspector';

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
