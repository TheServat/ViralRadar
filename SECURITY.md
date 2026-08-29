# Security policy

## Reporting a vulnerability

**Please do not open a public issue.**

Email **theservat.mail@gmail.com**, or use GitHub's
[private vulnerability reporting](https://github.com/TheServat/ViralRadar/security/advisories/new).

Please include what an attacker could do, how to reproduce it, and which version
or commit you were on. You will get an acknowledgement within a few days. This
is a single-maintainer project, so a fix may take longer than that — you will be
told either way rather than left waiting.

## Why this matters more than it looks

Viral Radar is a local tool, but it does something inherently risky: it reads
URLs and text that strangers on the internet chose, and it opens network
connections based on them. A vulnerability here reaches the machine it runs on.

The controls that follow from that — the SSRF guard on every outbound request,
parameterised SQL everywhere, key-based log redaction, escaping before anything
reaches a notification or a spreadsheet — are documented in
[docs/security.md](docs/security.md), which is the right place to start if you
are looking for something.

## What is in scope

- Anything that lets content from a source reach the filesystem, the network, or
  a shell
- Anything that exposes `.env` contents, API keys, or the database to a page, a
  log line, an export, or a notification
- Bypassing the SSRF guard, the settings password, or `API_TOKEN`
- Anything that turns a malicious title, feed or thumbnail into code execution,
  a formula in an exported spreadsheet, or script in the dashboard

## What is not

- **`.env` being readable on disk.** It is a plain-text file next to the
  program. The settings password protects the *page*, not the file, and says so.
- **Binding to `0.0.0.0` without a token.** The server refuses to start in that
  configuration, which is the intended protection.
- Anything requiring an attacker who already has your filesystem or your shell.
- Optional integrations you chose to switch on reaching the hosts they exist to
  reach — a configured Ollama, webhook or API endpoint.

## Supported versions

The latest commit on `main`. This is a tool people run from a clone rather than
a released binary, so fixes land there and are not backported.
