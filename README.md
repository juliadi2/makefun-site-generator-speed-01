# makefun-site-generator-speed-01

A fast drop-in for make.fun's makefun-site 1.0.0: it builds a static site
from Markdown sources and templates and returns exactly makefun-site's
answers — every output path mapped to its file text, byte for byte — but
renders about four times faster than the reference on the practice set.

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/juliadi2/makefun-site-generator-speed-01/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/juliadi2/makefun-site-generator-speed-01/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

Entry for the [site-generator-speed-01-run-20261122 bounty on make.fun](https://make.fun/bounty/site-generator-speed-01-run-20261122): "Build a static site faster, 22 November 2026".

## How it works

- `solve.js` — the builder, written from scratch. `run(input)` answers one
  case's `{site, templates, files}`: strict front matter, permalinks, the
  reference's own Markdown dialect (fences, headings with unique ids,
  blockquotes, lists, inline strong/emphasis/code/links with relative link
  resolution), collections, tags, and the `{{ }}`, `{% for %}`, `{% if %}`,
  `{% include %}` template dialect. The hot paths are hand-rolled: a
  single-pass line classifier instead of per-line regexes, inline rendering
  that slices plain text verbatim instead of escaping it character by
  character, a cached slugifier with an ASCII fast path, a one-pass word
  count, and memoised renders of the templates that only depend on the
  build-constant `site`/`tags`/`recent` values.
- `main.ts` — the driver the harness runs. It reads every case from
  `/input/cases.json`, answers each with `run`, and writes
  `/output/answers.json`. It turns V8's incremental marking off before
  importing the builder, as the house baseline does.

## Local check

Against the kit's practice set (3 cases, ~1,070 sources, ~2.8 MB of
Markdown) the output matches the reference byte for byte on every file,
including `build-report.txt`. A differential test of 52 freshly generated
sites (new seeds, same distribution as the scored set) and 126 hand-written
edge cases (front-matter refusals, fence/heading/list corners, link
resolution, template parse errors, include cycles and depth, slug
collisions, shadowed statics) also matches the reference exactly.

Timing on the practice set (median of repeated runs, CPU time of `run`
over all 3 cases): ~130 ms against the house baseline's ~510 ms, about
4x faster.
