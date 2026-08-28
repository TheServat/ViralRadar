/**
 * Infrastructure-level tests: feed parsing, SSRF guarding and the source
 * adapters' pure parsing helpers. None of these touch the network.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decodeEntities, parseDate, parseFeed, tagText, tagTexts } from '../src/core/xml.ts';
import { assertSafeUrl, isBlockedIPv4, isBlockedIPv6 } from '../src/net/ssrf.ts';
import { parseApproxTraffic } from '../src/sources/googletrends.ts';
import { parseCompactCount, parseChannelPage } from '../src/sources/telegram.ts';
import { parseDuration, rotateTerms } from '../src/sources/youtube.ts';
import { originOf } from '../src/sources/mastodon.ts';
import { rankScore } from '../src/sources/charts.ts';
import { splitTitle } from '../src/sources/googlenews.ts';
import { completeDay, isArticle } from '../src/sources/wikipedia.ts';
import { allPlugins } from '../src/sources/registry.ts';
import { isRadarError } from '../src/errors.ts';

describe('feed parsing', () => {
  const RSS = `<?xml version="1.0"?><rss><channel><title>Example News</title>
    <item>
      <title><![CDATA[Glacier collapse causes flooding]]></title>
      <description>At least 270 people have died.</description>
      <link>https://example.com/a?x=1&amp;y=2</link>
      <guid isPermaLink="false">abc123</guid>
      <pubDate>Thu, 27 Aug 2026 10:17:45 GMT</pubDate>
      <media:thumbnail width="240" url="https://cdn.example.com/t.jpg"/>
      <category>World</category>
    </item></channel></rss>`;

  const ATOM = `<feed><entry><id>yt:video:abc</id><yt:videoId>abc</yt:videoId>
    <title>World's Largest Tennis Match</title>
    <link rel="alternate" href="https://www.youtube.com/shorts/abc"/>
    <author><name>MrBeast</name></author>
    <published>2026-08-23T16:00:04+00:00</published></entry></feed>`;

  test('reads an RSS item including CDATA and entities', () => {
    const [item] = parseFeed(RSS);
    assert.ok(item !== undefined);
    assert.equal(item.title, 'Glacier collapse causes flooding');
    assert.equal(item.link, 'https://example.com/a?x=1&y=2');
    assert.equal(item.guid, 'abc123');
    assert.equal(item.thumbnail, 'https://cdn.example.com/t.jpg');
    assert.deepEqual(item.categories, ['World']);
    assert.equal(item.publishedAt, Math.floor(Date.parse('Thu, 27 Aug 2026 10:17:45 GMT') / 1000));
  });

  test('reads an Atom entry whose link lives in an attribute', () => {
    const [entry] = parseFeed(ATOM);
    assert.ok(entry !== undefined);
    assert.equal(entry.link, 'https://www.youtube.com/shorts/abc');
    assert.equal(entry.author, 'MrBeast');
    assert.equal(tagText(entry.raw, 'videoId'), 'abc');
  });

  test('a missing or unparseable date is null, never "now"', () => {
    assert.equal(parseDate(null), null);
    assert.equal(parseDate('not a date'), null);
  });

  test('decodes numeric and named entities', () => {
    assert.equal(decodeEntities('a &amp; b &#39;c&#39; &#x2014;'), "a & b 'c' —");
  });

  test('collects repeated namespaced tags', () => {
    const xml = '<item><ht:news_item_title>One</ht:news_item_title><ht:news_item_title>Two</ht:news_item_title></item>';
    assert.deepEqual(tagTexts(xml, 'news_item_title'), ['One', 'Two']);
  });
});

describe('SSRF guard', () => {
  test('blocks loopback, private, link-local and metadata addresses', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.169.254', '0.0.0.0']) {
      assert.notEqual(isBlockedIPv4(ip), null, `${ip} should be blocked`);
    }
  });

  test('allows ordinary public addresses', () => {
    assert.equal(isBlockedIPv4('93.184.216.34'), null);
    assert.equal(isBlockedIPv4('8.8.8.8'), null);
  });

  test('blocks IPv6 loopback and unique-local', () => {
    assert.notEqual(isBlockedIPv6('::1'), null);
    assert.notEqual(isBlockedIPv6('fd00::1'), null);
    assert.notEqual(isBlockedIPv6('fe80::1'), null);
    assert.equal(isBlockedIPv6('2606:4700::1111'), null);
  });

  test('rejects non-http protocols', async () => {
    await assert.rejects(
      () => assertSafeUrl('file:///etc/passwd'),
      (e: unknown) => isRadarError(e) && e.kind === 'VALIDATION',
    );
  });

  test('rejects a literal private address without any DNS lookup', async () => {
    await assert.rejects(() => assertSafeUrl('http://169.254.169.254/latest/meta-data/'));
    await assert.rejects(() => assertSafeUrl('http://localhost:7788/api/v1/dashboard'));
  });
});

describe('adapter parsing helpers', () => {
  test('Google Trends traffic bands', () => {
    assert.equal(parseApproxTraffic('20K+'), 20_000);
    assert.equal(parseApproxTraffic('1M+'), 1_000_000);
    assert.equal(parseApproxTraffic('500+'), 500);
    assert.equal(parseApproxTraffic('unknown'), null);
    assert.equal(parseApproxTraffic(null), null);
  });

  test('Telegram compact counters', () => {
    assert.equal(parseCompactCount('14.7M'), 14_700_000);
    assert.equal(parseCompactCount('1.2K'), 1_200);
    assert.equal(parseCompactCount('938'), 938);
    assert.equal(parseCompactCount('n/a'), null);
  });

  test('Telegram channel preview parsing', () => {
    const html = `
      <div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="durov/524">
        <div class="tgme_widget_message_text js-message_text">Telegram is now on <b>Wear OS</b>. #wearos</div>
        <span class="tgme_widget_message_views">14.7M</span>
        <span class="tgme_widget_message_from_author">Pavel Durov</span>
        <time datetime="2026-06-11T17:54:31+00:00" class="time">17:54</time>
      </div></div>`;
    const [post] = parseChannelPage(html);
    assert.ok(post !== undefined);
    assert.equal(post.channel, 'durov');
    assert.equal(post.postId, '524');
    assert.equal(post.views, 14_700_000);
    assert.ok(post.text.includes('Wear OS'));
    assert.equal(post.author, 'Pavel Durov');
    assert.equal(post.publishedAt, Math.floor(Date.parse('2026-06-11T17:54:31+00:00') / 1000));
  });

  test('YouTube ISO-8601 durations', () => {
    assert.equal(parseDuration('PT1M30S'), 90);
    assert.equal(parseDuration('PT45S'), 45);
    assert.equal(parseDuration('PT2H3M4S'), 7384);
    assert.equal(parseDuration(undefined), null);
  });
});

describe('plugin registry', () => {
  test('every plugin declares a unique id and coherent capabilities', () => {
    const ids = new Set<string>();
    for (const plugin of allPlugins()) {
      assert.ok(!ids.has(plugin.id), `duplicate id ${plugin.id}`);
      ids.add(plugin.id);
      assert.ok(plugin.name.length > 0);
      assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
      assert.ok(plugin.capabilities.contentTypes.length > 0);
      assert.ok(plugin.capabilities.engagementReference > 0);
      assert.ok(
        plugin.capabilities.baseReliability >= 0 && plugin.capabilities.baseReliability <= 1,
        `${plugin.id} reliability out of range`,
      );
      // A source that claims to support refresh must actually implement it.
      if (plugin.capabilities.supportsRefresh) {
        assert.equal(typeof plugin.refresh, 'function', `${plugin.id} claims refresh but has none`);
      }
    }
  });

  test('validate() never throws, whatever the configuration', () => {
    for (const plugin of allPlugins()) {
      const result = plugin.validate();
      assert.equal(typeof result.ok, 'boolean');
      assert.ok(result.message.length > 0);
    }
  });

  test('unavailable platforms refuse rather than inventing data', async () => {
    const tiktok = allPlugins().find((p) => p.id === 'tiktok');
    assert.ok(tiktok !== undefined);
    assert.equal(tiktok.validate().ok, false);
    await assert.rejects(
      () =>
        tiktok.discover({
          logger: { debug() {}, info() {}, warn() {}, error() {}, child: () => this as never },
          now: () => 0,
          regions: [],
          languages: [],
          state: {
            get: () => null,
            set: () => {},
            getNumber: (_k: string, fallback: number) => fallback,
            setNumber: () => {},
          },
          // Nothing has earned a place on a watch list inside a unit test.
    provenCreators: () => [],
    knownIds: () => new Set<string>(),
    requireHuman: () => {},
        }),
      (e: unknown) => isRadarError(e) && e.kind === 'CONFIGURATION_REQUIRED',
    );
  });
});

describe('YouTube open discovery', () => {
  test('term rotation covers every seed evenly and wraps around', () => {
    const terms = ['a', 'b', 'c', 'd'];
    assert.deepEqual(rotateTerms(terms, 0, 2), ['a', 'b']);
    assert.deepEqual(rotateTerms(terms, 2, 2), ['c', 'd']);
    assert.deepEqual(rotateTerms(terms, 3, 2), ['d', 'a'], 'must wrap, not run off the end');
    assert.deepEqual(rotateTerms(terms, 0, 10), terms, 'never asks for more terms than exist');
    assert.deepEqual(rotateTerms([], 0, 2), []);
    assert.deepEqual(rotateTerms(terms, 0, 0), []);
  });
});

describe('federated identity', () => {
  test('a Mastodon post is identified by its origin, not by the server read', () => {
    // The same post seen on three servers has three local ids and one URI.
    const parsed = originOf('https://ohai.social/users/GIFS_of_Puppets/statuses/117167423278481595');
    assert.deepEqual(parsed, { host: 'ohai.social', id: '117167423278481595' });
  });

  test('a URI that is not a status resolves to nothing rather than a guess', () => {
    assert.equal(originOf('https://mastodon.social/tags/cats'), null);
    assert.equal(originOf('not a url'), null);
  });
});

describe('chart ranks', () => {
  test('first place scores highest and last place still scores', () => {
    assert.equal(rankScore(1, 100), 100);
    assert.equal(rankScore(100, 100), 1);
    assert.ok(rankScore(1, 50) > rankScore(2, 50), 'climbing must read as growth');
    assert.ok(rankScore(500, 50) >= 1, 'a rank past the end never goes negative');
  });
});

describe('Google News titles', () => {
  test('splits the publisher off the headline', () => {
    assert.deepEqual(splitTitle('Volcano erupts in Iceland - BBC News'), {
      headline: 'Volcano erupts in Iceland',
      publisher: 'BBC News',
    });
  });

  test('leaves a headline that merely contains a dash alone', () => {
    const long = 'A story - with an unusually long trailing clause that is clearly not a publisher name';
    assert.equal(splitTitle(long).publisher, null);
  });
});

describe('Wikipedia pageviews', () => {
  test('drops namespace and portal pages, which are not articles', () => {
    for (const page of ['Special:Search', 'ویژه:جستجو', 'رده:فیلم', 'Category:Films', 'صفحهٔ_اصلی']) {
      assert.equal(isArticle(page), false, page);
    }
  });

  test('keeps real articles, including ones containing a colon', () => {
    assert.equal(isArticle('Iran'), true);
    assert.equal(isArticle('محسن_نامجو'), true);
    assert.equal(isArticle('Star_Wars:_A_New_Hope'), true);
  });

  test('reads the most recent complete day, not today', () => {
    const noon = Math.floor(Date.parse('2026-08-27T12:00:00Z') / 1000);
    assert.equal(completeDay(noon).label, '2026-08-26');
  });
});
