# Security model

## Threat model

This is a local research tool, but it does something inherently risky: it reads
URLs and text that strangers on the internet chose, and it opens network
connections based on them. The controls below follow from that.

| Threat | Control |
| --- | --- |
| Content-supplied URL points at internal infrastructure | SSRF guard on every outbound request, including redirects |
| Content-supplied text reaches the DOM | every field escaped before `innerHTML`; strict CSP |
| Content-supplied text reaches SQL | parameterised statements everywhere; one whitelist for the single dynamic identifier |
| A page on another origin reads your data | no CORS headers emitted; default bind is `127.0.0.1` |
| The API exposed to the network unauthenticated | the server **refuses to start** in that configuration |
| Secrets in logs | key-based redaction at every depth |
| Secrets in the repository | `.env` is git-ignored; only `.env.example` is committed |
| A malicious feed exhausts memory or time | timeouts, body slicing, per-host circuit breakers |
| Static file traversal | `normalize` + prefix check before any filesystem call |

## SSRF

Every outbound URL passes `assertSafeUrl` before a socket is opened.

- Protocol must be `http` or `https`. `file:`, `gopher:`, `data:` are rejected.
- Hostnames `localhost`, `*.localhost`, `*.internal`, `metadata.google.internal`
  and friends are rejected without resolution.
- Literal addresses are checked directly; hostnames are resolved and **every**
  returned address is checked.
- Blocked IPv4: `0.0.0.0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`
  (link-local and cloud metadata), `172.16/12`, `192.0.0/24`, `192.168/16`,
  `198.18/15`, `224/4`, `240/4`.
- Blocked IPv6: `::1`, `::`, `fe80::/10`, `fc00::/7`, and IPv4-mapped forms.

A local Ollama is reachable only because its host is passed to the guard
explicitly via `allowHosts` — the guard is never switched off.

## Not bypassing things

This is a design constraint, encoded in types rather than left to discipline.

**Never implemented:**
- CAPTCHA solving of any kind
- authentication or access-control bypass
- rate-limit evasion or ban evasion
- IP rotation as a workaround
- stealth or fingerprint-spoofing browser behaviour
- paywall circumvention

**What happens instead.** `RadarError` classifies every failure, and
`DEFAULT_RETRYABLE` marks `RATE_LIMIT`, `AUTH_REQUIRED`, `CAPTCHA_REQUIRED` and
`CONFIGURATION_REQUIRED` as **not retryable**. Hammering them is both useless
and abusive, so the retry loop cannot do it.

A 429 sets a per-host cooldown honouring `Retry-After`. A challenge page becomes
a `ManualIntervention` row and a card in the dashboard:

```
⚠ telegram needs you: CAPTCHA
Telegram served a verification page for @somechannel.
Open the link in a browser, complete it yourself, then re-enable the source.
                                                    [ Open ]  [ Done ]
```

The system asks a human and waits. It does not solve the challenge.

## Proxy and Tor

`NETWORK_MODE` selects the outbound route: `DIRECT` or `HTTP_PROXY` with
`PROXY_URL`. When a proxy is configured, the process re-executes itself once
with Node's proxy support enabled, and `NO_PROXY` keeps loopback traffic local.

This is **routing infrastructure**, not an evasion mechanism. Legitimate uses:
privacy, network policy, reaching a service your ISP does not route. It is not
used to bypass bans, rate limits, authentication or geographic restrictions, and
rotating through addresses to defeat a rate limit is not implemented.

Tor works the same way through its HTTP tunnel (`HTTPTunnelPort 9080` in
`torrc`). SOCKS is not supported without an extra dependency; the CLI says so
and gives the exact alternative rather than failing obscurely.

## HTTP server

Bound to `127.0.0.1` by default, so the default deployment is not reachable from
the network at all. Widen `HOST` and `API_TOKEN` becomes mandatory:

```
Refusing to start: HOST=0.0.0.0 exposes the API beyond this machine
and API_TOKEN is empty.
```

Every response carries:

```
Content-Security-Policy: default-src 'self'; script-src 'self';
  style-src 'self' 'unsafe-inline'; img-src https: data:;
  connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Cross-Origin-Opener-Policy: same-origin
Permissions-Policy: geolocation=(), microphone=(), camera=()
```

`img-src https:` is the one loosening, because thumbnails come from platform
CDNs. Scripts may come only from this server; no CDN, no inline script. No CORS
headers are emitted, so another origin cannot read any of it. There is a test
asserting that.

Requests are rate limited per client address (600/min), and every parameter is
validated and clamped — `limit` to 200, `minScore` to 0–100, free text to 120
characters.

## SQL

Every statement is parameterised. There is exactly one place a column name is
interpolated — `creatorSamples`, which needs the metric column for the source —
and it is guarded by a whitelist that throws on anything else:

```ts
if (!METRIC_COLUMNS.has(metricColumn)) {
  throw new Error(`Refusing to query unknown metric column "${metricColumn}"`);
}
```

## Logging

Redaction is key-based and recursive, so a secret nested in a payload is caught
too:

```
/(pass|secret|token|api[_-]?key|apikey|cookie|authorization|auth|credential|session)/i
```

API keys, bearer tokens, cookies and proxy credentials never reach a log line.
Structured JSON when piped to a file; readable lines on a terminal.

## Privacy

- Only public content, public identifiers and public metrics are stored.
- Creator metadata is limited to what a ranking needs: name, id, follower count.
- No tracking, no telemetry, no outbound reporting. The only outbound traffic is
  to the sources you enabled.
- Retention is configurable and enforced (`RETENTION_DAYS`,
  `TREND_HISTORY_DAYS`), with a scheduled sweep.
- The database is a single file. Deleting it deletes everything.
