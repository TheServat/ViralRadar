/**
 * Infrastructure-level tests: feed parsing, SSRF guarding, the default source
 * list, and the adapters' pure parsing helpers. Nothing here reaches the
 * network beyond a local server these tests stand up themselves.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Hermetic, and it has to be set before anything that reads the configuration
// is loaded - which is why the imports below are dynamic. Without it these
// tests read the developer's own `.env`, and the ones about default settings
// would assert against whatever that person happens to have configured.
process.env['RADAR_NO_ENV_FILE'] = '1';
process.env['LOG_LEVEL'] = 'error';

const { decodeEntities, parseDate, parseFeed, tagText, tagTexts } = await import('../src/core/xml.ts');
const { assertSafeUrl, isBlockedIPv4, isBlockedIPv6 } = await import('../src/net/ssrf.ts');
const { request } = await import('../src/net/fetcher.ts');
const { parseApproxTraffic } = await import('../src/sources/googletrends.ts');
const { parseCompactCount, parseChannelPage } = await import('../src/sources/telegram.ts');
const { parseDuration, rotateTerms } = await import('../src/sources/youtube.ts');
const { originOf } = await import('../src/sources/mastodon.ts');
const { rankScore } = await import('../src/sources/charts.ts');
const { splitTitle } = await import('../src/sources/googlenews.ts');
const { completeDay, isArticle } = await import('../src/sources/wikipedia.ts');
const { allPlugins } = await import('../src/sources/registry.ts');
const { config } = await import('../src/config.ts');
const { SETTING_FIELDS } = await import('../src/settings.ts');
const { isRadarError } = await import('../src/errors.ts');

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

describe('the guard and redirects', () => {
  /*
   * The bypass this guard's own documentation names.
   *
   * `assertSafeUrl` ran once, on the URL the caller passed, and the platform
   * then followed up to twenty hops without asking again. Thumbnail URLs come
   * verbatim from collected items — a stranger's URL, to whatever host the
   * item named — so one `302` reached the addresses the guard exists to
   * refuse. It needs a real server to test: the defect was never in
   * `assertSafeUrl`, which is why testing it in isolation missed this.
   */
  let redirector: ReturnType<typeof createServer>;
  let other: ReturnType<typeof createServer>;
  let base = '';
  let otherBase = '';
  /** What each host was actually asked for, so the hops can be inspected. */
  const seen: { method: string; body: string; auth: string | undefined }[] = [];
  const elsewhere: { auth: string | undefined }[] = [];
  /**
   * The redirector itself is on loopback, so it has to be allowed by name the
   * way a configured local service is. Only the first URL benefits: the guard
   * on each hop gets the same options, and `169.254.169.254` is not this host.
   */
  const ALLOW_LOCAL = { allowHosts: ['127.0.0.1'], skipDnsCheck: true };

  before(async () => {
    redirector = createServer((req, res) => {
      const params = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({
          method: req.method ?? '',
          body: Buffer.concat(chunks).toString('utf8'),
          auth: req.headers.authorization,
        });

        // An endless chain, for the hop limit.
        if (params.get('loop') !== null) {
          res.writeHead(302, { location: '/?loop=1' });
          res.end();
          return;
        }
        // The same, but each hop takes long enough to measure.
        if (params.get('slowloop') !== null) {
          setTimeout(() => {
            res.writeHead(302, { location: '/?slowloop=1' });
            res.end();
          }, 400);
          return;
        }
        const to = params.get('to') ?? '';
        if (to === '') {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('arrived');
          return;
        }
        res.writeHead(Number(params.get('status') ?? 302), { location: to });
        res.end();
      });
    });
    await new Promise<void>((resolve) => redirector.listen(0, '127.0.0.1', () => resolve()));
    base = `http://127.0.0.1:${(redirector.address() as AddressInfo).port}`;

    other = createServer((req, res) => {
      elsewhere.push({ auth: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('elsewhere');
    });
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', () => resolve()));
    otherBase = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
  });

  after(() => {
    redirector.close();
    other.close();
  });

  test('a redirect to a blocked address is refused', async () => {
    // The guard must run on the hop, not only on what the caller handed over.
    // `allowPrivate` lets the first URL through, exactly as the thumbnail
    // fetch would let a public one through, so what is under test is the hop.
    await assert.rejects(
      () =>
        request(`${base}/?to=${encodeURIComponent('http://169.254.169.254/latest/meta-data/')}`, {
          retries: 0,
          guard: ALLOW_LOCAL,
        }),
      (e: unknown) => isRadarError(e),
      'the second hop went to link-local without being checked',
    );
  });

  test('a relative redirect is resolved before it is checked', async () => {
    // A Location need not be absolute, and one that resolves somewhere new is
    // the case a naive string check misses.
    const res = await request(`${base}/?to=${encodeURIComponent('/')}`, {
      retries: 0,
      guard: ALLOW_LOCAL,
    });
    assert.equal(res.body, 'arrived');
  });

  test('a POST becomes a GET with no body, the way the platform did it', async () => {
    // Taking the hops by hand meant taking over what undici was doing for
    // free. Re-POSTing to the target of a 302 means a redirecting endpoint
    // gets the request twice and answers 405 - which this codebase classifies
    // as non-retryable and blames on the source.
    seen.length = 0;
    await request(`${base}/?status=302&to=${encodeURIComponent('/')}`, {
      method: 'POST',
      body: 'grant_type=client_credentials&client_secret=TOPSECRET',
      retries: 0,
      guard: ALLOW_LOCAL,
    });
    assert.equal(seen.length, 2, 'one hop, then the target');
    assert.equal(seen[0]?.method, 'POST');
    assert.equal(seen[1]?.method, 'GET', 'the second request must not be a POST');
    assert.equal(seen[1]?.body, '', 'and must not carry the body');
  });

  test('a 307 keeps the method, which is what it is for', async () => {
    seen.length = 0;
    await request(`${base}/?status=307&to=${encodeURIComponent('/')}`, {
      method: 'POST',
      body: 'keep-me',
      retries: 0,
      guard: ALLOW_LOCAL,
    });
    assert.equal(seen[1]?.method, 'POST');
    assert.equal(seen[1]?.body, 'keep-me');
  });

  test('an Authorization header does not follow a redirect to another host', async () => {
    // The header was spread into every hop, so a credential written for one
    // host went wherever that host's response pointed. Both listeners here are
    // loopback but on different ports, which is a different origin.
    seen.length = 0;
    elsewhere.length = 0;
    await request(`${base}/?to=${encodeURIComponent(otherBase + '/')}`, {
      headers: { Authorization: 'Basic SECRET-CREDENTIAL' },
      retries: 0,
      guard: ALLOW_LOCAL,
    });
    assert.equal(seen[0]?.auth, 'Basic SECRET-CREDENTIAL', 'the first host was meant to get it');
    assert.equal(elsewhere.length, 1, 'the hop was followed');
    assert.equal(elsewhere[0]?.auth, undefined, 'the second host must not receive it');
  });

  test('the whole request shares one deadline, hops included', async () => {
    // A fresh timeout per hop meant six full timeouts before giving up, so a
    // 15-second budget could run for a minute and a half.
    // `rps` high enough that per-host rate limiting contributes nothing. At the
    // default of one request per second the politeness sleep between hops sat
    // inside the bound - about a second of it - which left room for a per-hop
    // timeout to hide. With it removed, correct code finishes in roughly one
    // budget and the broken version takes six.
    const started = Date.now();
    await assert.rejects(
      () =>
        request(`${base}/?slowloop=1`, {
          retries: 0,
          timeoutMs: 700,
          rps: 1000,
          guard: ALLOW_LOCAL,
        }),
      () => true,
    );
    const elapsed = Date.now() - started;
    // Measured: ~1,690 ms with one shared signal, ~3,400 ms with one per hop.
    // The bound sits between them rather than just above the correct value, so
    // a slow machine does not turn this red while a per-hop signal still does.
    assert.ok(elapsed < 2500, `gave up after ${elapsed}ms; one shared deadline should be well under that`);
  });

  test('a redirect loop stops rather than running to the platform default', async () => {
    await assert.rejects(
      () => request(`${base}/?loop=1`, { retries: 0, guard: ALLOW_LOCAL }),
      (e: unknown) => isRadarError(e) && /redirected more than/.test(e.message),
    );
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

describe('the sources that run by default', () => {
  /*
   * The same list lives in three places - `config.ts`, the settings whitelist
   * and `.env.example` - and for a long time it was three different lists, so
   * the two supported install paths ran two different sets of sources, each
   * losing some the other kept.
   *
   * From source, `.env` is copied from `.env.example`, which had youtube and
   * reddit off; the first-run wizard takes a YouTube key, reports it saved,
   * and never touches this list, so the key was accepted and the source never
   * ran. From the packaged binary there is no `.env`, so `config.ts` governed
   * and six sources the README lists under "working with no configuration"
   * never ran.
   */

  test('the three copies of the default source list agree', () => {
    const fromSettings = SETTING_FIELDS.find((f) => f.key === 'SOURCES_ENABLED');
    assert.ok(fromSettings);
    assert.deepEqual(
      config.sourcesEnabled,
      String(fromSettings.defaultValue).split(','),
      'config.ts and the settings screen disagree about which sources run',
    );

    const example = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env.example'),
      'utf8',
    );
    const line = example.split(/\r?\n/).find((l) => l.startsWith('SOURCES_ENABLED='));
    assert.ok(line, '.env.example must set SOURCES_ENABLED');
    assert.deepEqual(
      line.slice('SOURCES_ENABLED='.length).split(','),
      config.sourcesEnabled,
      '.env.example disagrees, so an install from source runs different sources',
    );
  });

  test('every default source is a real adapter', () => {
    const known = new Set(allPlugins().map((p) => p.id));
    for (const id of config.sourcesEnabled) {
      assert.ok(known.has(id), `${id} is enabled by default but is not an adapter`);
    }
  });

  test('a source that needs a key is on by default and says so when it has none', () => {
    // The point of enabling them: entering a key on the Settings page is
    // enough on its own. A keyed source with no key reports that it needs one,
    // which is an answer; being silently absent from the list was not.
    assert.ok(config.sourcesEnabled.includes('youtube'));
    const youtube = allPlugins().find((p) => p.id === 'youtube');
    assert.ok(youtube);
    const verdict = youtube.validate?.();
    assert.equal(verdict?.ok, false, 'with no key it must say it needs one');
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
    trendsRegions: [],
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
    termYield: () => [],
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
