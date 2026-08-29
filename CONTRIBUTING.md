# Contributing to Viral Radar

Thank you for wanting to help.

This project has a few conventions that are unusual enough to be worth reading
before you write code. They are not style preferences — each one is load-bearing,
and a change that breaks one will be asked to change rather than merged.

## Getting it running

```bash
git clone https://github.com/TheServat/ViralRadar.git
cd ViralRadar
npm install
cp .env.example .env      # nothing in it is required to start
npm run setup             # install, build the dashboard, run doctor
npm start
```

Node **24 or newer** is required, and not negotiable: the project runs
TypeScript directly with no build step, and uses `node:sqlite`.

Three sources work with no configuration at all — Google Trends, Hacker News and
RSS — so you can develop against real data without any API key.

## Before you open a pull request

```bash
npm test          # every test must pass
npm run typecheck # both workspaces
npm run build     # this also gates the locale files
```

## The rules that matter

**Zero runtime dependencies in the backend.** `apps/api` has none, and adding
one needs a strong argument in the pull request. MCP is hand-written for this
reason; so is the XML parsing; so is the SVG charting on the front end. If you
find yourself wanting a library for fifty lines of well-understood code, write
the fifty lines.

**TypeScript that erases.** `erasableSyntaxOnly` is on, because Node runs the
source directly. No `enum`, no parameter properties (`constructor(private x)`),
and `import type` for anything used only as a type. The typecheck will tell you.

**Never invent data.** If a platform does not report view counts, the field is
`null` — not zero, not an estimate. This runs deep: an unmeasured item is not an
irrelevant one, an unscored bucket is not a zero, and a filter must never hide
something it was unable to judge.

**Say what you cannot support.** Anything that reports a finding carries its
sample size and a confidence interval, and refuses to call a difference real
when the data cannot back it. If you add an analysis, use `core/lift.ts` rather
than writing your own significance rule — one definition of "a finding" is the
point.

**Optional means optional.** Every credential, model and external tool is
absent by default and the system works without it. If you add an integration,
it must degrade to a clearly-stated reduced behaviour, never to a crash and
never to something that looks complete but is not.

**Three languages stay in step.** English, Persian and Arabic. `npm run build`
fails if any key is missing from any of them, which is deliberate — a missing
translation should stop a release, not ship as a raw key on someone's screen.

**Documentation is part of the change.** A pull request that adds a setting
updates `.env.example`; one that adds a feature updates the README; one that
makes a decision worth remembering adds an ADR to `docs/decisions.md`. This is
not bureaucracy — the ADRs are how the project explains why something is the way
it is, and several of them exist because a reasonable-looking approach turned
out to be wrong in a way that was invisible.

## Tests

`node:test`, no framework. Run them with `npm test`.

Name the test after the behaviour, not the function: `a creator with one item is
never called a breakout` rather than `test creatorBreakout`. When a test exists
because something went wrong once, say so in a comment — a test whose reason is
recorded survives refactoring, and one whose reason is forgotten gets deleted.

Prefer testing what a person would notice. The most valuable tests in this
project assert things like "an unscored item is not filtered out" and "a pure
age effect produces no findings", because those are the failures that would
otherwise be silent and plausible.

## Adding a source

Sources are plugins under `apps/api/src/sources/`, and one file is one platform.
Read an existing one first — `hackernews.ts` is the simplest, `youtube.ts` the
most complete.

A plugin receives capabilities, never the application: no database handle, no
configuration object, no way to reach another source's state. If you need
something the `PluginContext` does not offer, add it as a capability rather than
reaching around the boundary.

Discovery must work with **no input at all**. A source that requires a keyword,
a channel list or a topic to return anything does not fit — finding things
nobody named is the entire point of the product.

## Commit messages

Explain *why*, not what. The diff already says what.

The messages in this history are longer than usual on purpose: several record a
measurement, an approach that was tried and rejected, or a bug that was found by
a test rather than by reading. If your change fixes something subtle, the commit
message is the right place to describe how it was actually caught.

## Reporting something

- **A bug or an idea:** open an issue; the templates ask for what is needed.
- **A security problem:** please do not open a public issue. See
  [docs/security.md](docs/security.md).

## Licence

By contributing you agree that your contribution is licensed under the MIT
Licence, the same as the rest of the project.
