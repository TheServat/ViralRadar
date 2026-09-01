/**
 * A date the interface formats means the same thing in every timezone.
 *
 * The weekday chart labelled its bars by formatting seven UTC midnights with
 * an `Intl.DateTimeFormat` that had no `timeZone`. That formatter renders in
 * the *viewer's* zone, so anywhere west of Greenwich each instant fell on the
 * previous evening and every label slid one day: the bar computed for Sunday
 * was labelled Saturday, for the whole of the Americas.
 *
 * Nothing about it looked wrong. The rows sort on the numeric key, so the
 * order stayed 0..6 while the names moved underneath, and the only artifact
 * was a week that appeared to start on Saturday — which reads as a styling
 * choice. The finding sentence underneath interpolates the same label into
 * prose, so the page also gave the wrong day as advice.
 *
 * The check reads the source, because the defect is an option that was not
 * written down, and there is no rendering that reveals it without knowing
 * which zone you are in.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const WEB_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'src');

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, found);
    else if (/\.(vue|ts)$/.test(entry)) found.push(full);
  }
  return found;
}

/**
 * Comments removed, so a scan sees the code rather than what was written about
 * it. Crude on purpose - it does not need to handle strings containing `//`,
 * because every pattern here is looked for in code, and a false negative from
 * an over-eager strip is caught by the count assertions.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*/g, '$1');
}

/**
 * Every `watch(...)` call, each bounded by its own parentheses.
 *
 * Written as a scan rather than a pattern because the thing being measured is
 * where one call ENDS, and no regular expression can answer that. Character
 * counting past the callback is what made an earlier version blame a watcher
 * for a fetch belonging to something else entirely.
 */
function watchCalls(text: string): { deps: string; body: string }[] {
  const calls: { deps: string; body: string }[] = [];
  let at = 0;
  for (;;) {
    const found = text.indexOf('watch(', at);
    if (found === -1) break;
    let depth = 0;
    let end = found;
    for (let i = found + 'watch'.length; i < text.length; i++) {
      const ch = text[i];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    if (end <= found) break;
    const body = text.slice(found, end);
    // The first balanced bracket group is the dependency array, when there is
    // one; a watcher on a single getter has no deps to inspect.
    let deps = '';
    const open = body.indexOf('[');
    if (open !== -1) {
      let inner = 0;
      for (let i = open; i < body.length; i++) {
        const ch = body[i];
        if (ch === '[') inner++;
        else if (ch === ']') {
          inner--;
          if (inner === 0) { deps = body.slice(open + 1, i); break; }
        }
      }
    }
    calls.push({ deps, body });
    at = end;
  }
  return calls;
}

describe('dates the interface formats itself', () => {
  test('a weekday or month name built from a fixed instant names its zone', () => {
    // Deliberately narrow: this is about formatters given a *constructed*
    // reference date to extract a name from, which is the case where the
    // viewer's zone is never what was meant. A formatter shown a real
    // timestamp should use the viewer's zone, and is not what this matches.
    const offenders: string[] = [];
    for (const file of sourceFiles(WEB_SRC)) {
      const text = readFileSync(file, 'utf8');
      if (!/Date\.UTC\(/.test(text)) continue;
      for (const [call] of text.matchAll(/new Intl\.DateTimeFormat\([^)]*\)/g)) {
        if (/weekday|month/.test(call) && !/timeZone/.test(call)) {
          offenders.push(`${file.slice(WEB_SRC.length + 1)}: ${call}`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `these format a fixed instant in the viewer's zone, which shifts the name:\n  ${offenders.join('\n  ')}`,
    );
  });

  test('the seven reference instants really do start on Sunday', () => {
    // The other half of the same bug: the server numbers weekdays with
    // strftime('%w'), where Sunday is 0. If this ever stops lining up, every
    // label is wrong in every zone rather than only in some.
    const names = Array.from({ length: 7 }, (_, i) =>
      new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(
        new Date(Date.UTC(2024, 0, 7 + i)),
      ),
    );
    assert.deepEqual(names, [
      'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
    ]);
  });
});

describe('the dashboard client, read as source', () => {
  /*
   * There is no browser in this suite, so these read the client the way the
   * icon and locale checks read the templates. Both defects below were
   * invisible to typecheck, to the build and to every existing test, and both
   * made a shipped feature unusable rather than merely wrong.
   */
  const CLIENT = readFileSync(join(WEB_SRC, 'api', 'client.ts'), 'utf8');
  const APP = readFileSync(join(WEB_SRC, 'App.vue'), 'utf8');

  test('accepting a token does not reload the page that holds it', () => {
    // The token lives in a module-level variable. A reload re-evaluates that
    // module, so the token is gone before the first request goes out and the
    // prompt reopens with an empty box - on the one deployment API_TOKEN
    // exists for, with no way through.
    const applyToken = APP.slice(APP.indexOf('function applyToken'));
    // To the closing brace in column 0, not the first brace anywhere: the fix
    // added a `startStream((type) => { ... })` callback inside this function,
    // and stopping at ITS brace left the guard reading 7 of 13 lines - blind to
    // a reload put back where it originally was, at the end.
    const end = applyToken.indexOf('\n}');
    assert.ok(end > 0, 'could not find the end of applyToken');
    const body = applyToken.slice(0, end);
    assert.ok(body.split('\n').length > 10, `only read ${body.split('\n').length} lines of applyToken`);
    assert.ok(
      !body.includes('location.reload'),
      'applyToken must not reload: that is what discards the token',
    );
  });

  test('every failed load is re-run when a token is accepted', () => {
    // The other half. Without a reload, something has to make the panels that
    // already 401'd ask again.
    assert.match(CLIENT, /export const authEpoch/, 'client must expose an auth epoch');
    assert.match(CLIENT, /authEpoch\.value\+\+/, 'setApiToken must bump it');
    const composable = readFileSync(join(WEB_SRC, 'composables', 'useRadar.ts'), 'utf8');
    assert.match(
      composable,
      /authEpoch\.value/,
      'useAsync must watch the epoch, or nothing reloads',
    );
  });

  test('every watcher that calls the API watches the auth epoch', () => {
    // `useAsync` watches it, and three call sites did not: BriefPage fetched
    // /system/interests and three count queries from hand-rolled watchers, so
    // on a deployment with API_TOKEN set its whole "for this channel" section
    // stayed hidden for the rest of the visit even after a token was accepted.
    // The reload this replaced was crude but total; an epoch only reaches what
    // subscribes to it, so this checks they all do.
    //
    // Each watch() is bounded by balancing its own parentheses. Two earlier
    // versions of this test were wrong in opposite directions - one matched
    // nothing because a comment sat between `watch(` and its array, the other
    // read 2500 characters past the callback and blamed a watcher for an API
    // call further down the file. The count assertion is what caught the first.
    const offenders: string[] = [];
    let fetching = 0;
    for (const file of sourceFiles(WEB_SRC)) {
      if (file.endsWith('client.ts')) continue;
      for (const call of watchCalls(stripComments(readFileSync(file, 'utf8')))) {
        if (!call.body.includes('api.')) continue;
        // Only watchers with a dependency array. The single-source ones are
        // the dialogs, keyed to opening them: a fetch that fails for want of a
        // token is retried by the user reopening the dialog, which is an action
        // they are already taking. An array watcher is filter-driven page data,
        // and BriefPage showed what happens when that is not re-run - its whole
        // section hid itself for the rest of the visit. Converting the dialogs
        // would also change their callback's argument from the watched value to
        // a tuple, which is a real cost for no gain.
        if (call.deps === '') continue;
        fetching++;
        if (!call.deps.includes('authEpoch')) {
          offenders.push(`${file.slice(WEB_SRC.length + 1)}: watch([${call.deps.replace(/\s+/g, ' ').trim()}])`);
        }
      }
    }
    // Two is the real count today, both in BriefPage. The floor exists to
    // catch the scan silently matching nothing, which is how the first version
    // of this test passed while looking at zero files.
    //
    // Known blind spot, stated rather than papered over: a watcher that calls a
    // local helper which calls the API is not seen, because only the watcher's
    // own text is read. TagsPage is exactly that shape - it was given the epoch
    // by hand, and this test would not have noticed if it had not been.
    assert.ok(fetching >= 2, `only found ${fetching} fetching watchers - the scan is broken`);
    assert.deepEqual(offenders, [], 'these fetch but never retry after a token: ' + offenders.join(' | '));
  });

  test('the settings-password gate is exempted by a prefix that exists', () => {
    // `/settings` is not a prefix of any route this client calls - they are
    // all under `/system/`. So the exemption never fired, and one wrong
    // settings password raised the API-token dialog over an install that has
    // no API token and therefore no way to dismiss it.
    const gated = /const PASSWORD_GATED = \[([^\]]*)\]/.exec(CLIENT);
    assert.ok(gated, 'the exempted paths should be named in one place');
    const prefixes = [...(gated[1] as string).matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
    assert.ok(prefixes.length > 0, 'no prefixes parsed');

    // Every path this client actually asks for.
    const routes = [...CLIENT.matchAll(/request<[^>]*>\(\s*[`']([^`'$]+)/g)].map((m) => m[1] as string);
    assert.ok(routes.length > 20, `only found ${routes.length} routes - the scan is broken`);

    for (const prefix of prefixes) {
      assert.ok(
        routes.some((r) => r.startsWith(prefix)),
        `${prefix} is exempted from the token prompt, but no route starts with it`,
      );
    }
  });
});
