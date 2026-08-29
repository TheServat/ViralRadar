<!--
Thank you for this. The checklist below is short on purpose — it only asks
about the things that are easy to miss in this particular codebase.
-->

## What this changes

<!-- One or two sentences. The diff says what; say why. -->

## Why

<!--
What was wrong, or what could not be done before. If you found a bug, how did
you find it? Several of this project's decisions exist because a
reasonable-looking approach turned out to be wrong in a way that was invisible,
and that story is worth keeping.
-->

## How it was checked

<!--
Not just "tests pass". What did you actually observe? A measurement before and
after, output from a real run, a specific case you tried by hand.
-->

## Checklist

- [ ] `npm test` passes
- [ ] `npm run typecheck` passes
- [ ] `npm run build` passes — this also gates the three locale files
- [ ] No new runtime dependency in `apps/api`, or the pull request explains why one is unavoidable
- [ ] Nothing invents data: absent values are `null`, never zero or an estimate
- [ ] Any new setting is in `.env.example` with a comment saying what it does
- [ ] Any user-visible change is in the README
- [ ] Any decision worth remembering is an ADR in `docs/decisions.md`

<!--
If a box does not apply, delete it rather than leaving it unticked — an
unticked box reads as "not done" and slows the review down.
-->
