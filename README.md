# md2pdf-book

Turn one or more Markdown files into a single, professionally typeset PDF book — with LaTeX math, Mermaid diagrams, syntax-highlighted code, a table of contents, footnotes, admonitions, and a cover page. No CDN, no network access required: every renderer it depends on is vendored and inlined, so a build works exactly the same offline, in CI, or on a laptop on a plane.

```
md2pdf-book book.yaml
```

## Contents

- [Features](#features)
- [Install](#install)
- [Troubleshooting: "Failed to launch the browser process!"](#troubleshooting-failed-to-launch-the-browser-process)
- [Quick start](#quick-start)
- [CLI reference](#cli-reference)
- [`book.yaml` reference](#bookyaml-reference)
- [Chapters, pagination, and page breaks](#chapters-pagination-and-page-breaks)
- [Markdown features](#markdown-features)
  - [Code blocks](#code-blocks)
  - [LaTeX math](#latex-math)
  - [Mermaid diagrams](#mermaid-diagrams)
  - [Admonitions / callouts](#admonitions--callouts)
  - [Footnotes](#footnotes)
  - [Images](#images)
  - [Table of contents](#table-of-contents)
- [Syntax highlighting themes](#syntax-highlighting-themes)
- [Custom CSS](#custom-css)
- [Pagination engines](#pagination-engines)
- [Validating a book without rendering it (`--lint`)](#validating-a-book-without-rendering-it---lint)
- [Using it as a library](#using-it-as-a-library)
- [Why fully offline?](#why-fully-offline)
- [Project layout](#project-layout)
- [License](#license)

## Features

- **YAML-driven books** — one `book.yaml` lists your chapters, layout, and metadata; run one command to get a PDF.
- **LaTeX math** via [KaTeX](https://katex.org) — inline `$...$` and display `$$...$$`, rendered synchronously so nothing races the PDF export.
- **Mermaid diagrams** — flowcharts, sequence diagrams, class diagrams, ER diagrams, state machines. Handles the two things that trip up most Mermaid-in-Markdown setups: literal `\n` in labels becomes a real line break, and escaped quotes (`\"like this\"`) render correctly instead of losing their quote marks.
- **Multiple chapters per file** — chapters are defined by top-level (`#`) headings, not by file boundaries, so a single Markdown file can hold as many chapters as you like (handy for appendices).
- **Admonitions** — GitHub-style `> [!NOTE]` / `[!TIP]` / `[!IMPORTANT]` / `[!WARNING]` / `[!CAUTION]` callout boxes.
- **Footnotes** — Pandoc-style `text[^id]` / `[^id]: definition`, auto-numbered.
- **Automatic chapter numbering**, custom cover images, syntax highlighting (via highlight.js, any of its ~80 themes) with a color-coded language badge on every code block, auto-generated table of contents (with an adjustable depth), running headers/footers, and manual `<!-- pagebreak -->` markers.
- **Custom CSS hook** — drop a CSS file on top of the built-in stylesheet for one-off style tweaks without forking the tool.
- **Two pagination engines** — the default is fast; an opt-in [Paged.js](https://pagedjs.org)-based engine adds a running header that tracks the current chapter title and footnotes that render at the bottom of the exact page they're referenced on.
- **`--lint`** — validate a book (missing images, dangling footnotes, duplicate heading ids) in under a second, without rendering a PDF.
- **`--quiet`** — suppress progress output for scripting/CI, printing only the final result (or an error).
- **Fully offline** — KaTeX, Mermaid, highlight.js, and Paged.js are vendored into the repo and inlined into the generated HTML. No CDN calls happen at render time.

## Install

Requires Node.js 20.10+ (for `import ... with { type: 'json' }` support).

From npm, as a global CLI:

```bash
npm install -g md2pdf-book
md2pdf-book book.yaml
```

Or straight from GitHub, without publishing anywhere:

```bash
npm install -g github:tikayere/md2pdf
md2pdf-book book.yaml
```

Both install `md2pdf` and `md2pdf-book` as equivalent global commands.

To hack on the source instead:

```bash
git clone https://github.com/tikayere/md2pdf.git
cd md2pdf
npm install
```

Run it locally with `node bin/md2pdf.js`, or link it for the global commands above:

```bash
npm link
md2pdf book.yaml
```

## Troubleshooting: "Failed to launch the browser process!"

md2pdf renders through headless Chromium via [Puppeteer](https://pptr.dev), which downloads its own pinned Chromium build on `npm install`. On some Linux setups that download fails to actually launch — missing shared libraries, a restrictive container/sandbox, or a corrupted download — surfacing as a bare `Error: Failed to launch the browser process!` with no further detail.

As of this version, md2pdf handles the common case for you: if the bundled Chromium fails to start, it automatically retries with a system-installed Chrome/Chromium (found on `$PATH` or in a few standard install locations) before giving up — so `apt install google-chrome-stable` (or `chromium`, or `chromium-browser`) is often all you need, no configuration required.

If it still can't find one, or picks the wrong one:

```bash
md2pdf-book book.yaml --chrome-path /usr/bin/google-chrome-stable
```
```yaml
chrome_path: /usr/bin/google-chrome-stable   # top-level in book.yaml
```

or the environment variable Puppeteer itself already understands:

```bash
PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable md2pdf-book book.yaml
```

Still stuck? It's most likely missing system libraries — reinstall the bundled Chromium (`npx puppeteer browsers install chrome`) or see [Puppeteer's Linux troubleshooting guide](https://pptr.dev/troubleshooting#chrome-doesnt-launch-on-linux) for the `apt-get install` list of shared libs headless Chrome needs.

## Quick start

```bash
# Generate a starter book.yaml with placeholder chapters to edit
node bin/md2pdf.js --init

# Edit book.yaml, then render
node bin/md2pdf.js book.yaml -v
```

Or try the bundled example book, which demonstrates every feature (math, diagrams, admonitions, footnotes, code highlighting, appendices):

```bash
npm test    # renders examples/book.yaml -> examples/developer-guide.pdf
```

## CLI reference

> Examples below use `md2pdf-book` as a stand-in for however you're invoking the CLI — `node bin/md2pdf.js`, the `md2pdf` command from `npm link` (see [Install](#install)), or your own alias.

Two modes, auto-detected from the first argument:

```bash
# Config mode (recommended) — first argument ends in .yaml/.yml
md2pdf-book book.yaml
md2pdf-book book.yaml -o custom-output.pdf -v

# File-list mode — pass files or globs directly
md2pdf-book intro.md chapter1.md chapter2.md -o book.pdf --title "My Book" --author "Jane"
md2pdf-book "docs/*.md" -o docs.pdf --sort
```

Run `md2pdf-book --help` for the full, current list — flags mirror the `book.yaml` fields below and override them when both are given. The most commonly used ones:

| Flag | Purpose |
|---|---|
| `-o, --output <path>` | Output PDF path |
| `-t/-a/-d` | Title / author / date |
| `--page-size`, `--orientation` | `A4\|A3\|Letter\|Legal`, `portrait\|landscape` |
| `--engine <engine>` | `chromium` (default) or `pagedjs` — see [Pagination engines](#pagination-engines) |
| `--chapter-numbers` | Prefix chapters with "Chapter N" |
| `--cover-image <path>` | Use an image as the cover background |
| `--highlight-theme <theme>` | Any [highlight.js theme](#syntax-highlighting-themes) — `github`, `github-dark`, `monokai`, `nord`, ... |
| `--css <path>` | Extra CSS file appended after the built-in stylesheet — see [Custom CSS](#custom-css) |
| `--toc-depth <n>` | Only list headings up to level `n` (1-6) in the TOC |
| `--no-cover` / `--no-toc` / `--no-page-numbers` / `--no-chapter-breaks` | Disable the corresponding feature |
| `--lint` | Validate without rendering — see below |
| `--save-html <path>` | Dump the intermediate HTML (useful for debugging layout) |
| `--chrome-path <path>` | Explicit Chrome/Chromium to launch — see [Troubleshooting](#troubleshooting-failed-to-launch-the-browser-process) |
| `--init` | Write a starter `book.yaml` and exit |
| `-v, --verbose` | Print render progress |
| `-q, --quiet` | Suppress progress output — prints only the final output path (or an error) |

## `book.yaml` reference

```yaml
title:  "My Book"
author: "Your Name"
date:   "1/1/2026"
output: "book.pdf"

# Ordered list of markdown files to include. Chapters are defined by
# top-level (#) headings inside these files, not by the files themselves —
# one file can contain several chapters.
pages:
  - intro.md
  - chapter1.md
  - chapter2.md
  # Long form, for future per-page options:
  # - file: chapter3.md

layout:
  page_size:   A4          # A4 | A3 | Letter | Legal
  orientation: portrait    # portrait | landscape
  font_size:   11pt
  line_height: "1.6"
  engine:      chromium    # chromium (fast) | pagedjs (running chapter-title
                            # headers + real per-page footnotes, slower)
  margins:
    top:    2.5cm
    bottom: 2.5cm
    left:   3cm
    right:  2.5cm

features:
  cover:           true
  toc:             true
  toc_depth:       6       # only list headings up to this level (1-6) in the TOC;
                            # body anchors/ids are unaffected either way
  page_numbers:    true
  chapter_breaks:  true    # new page before every top-level (#) heading;
                            # use "<!-- pagebreak -->" mid-file for extra breaks
  chapter_numbers: false   # prefix each chapter heading with "Chapter N"
                            # (headings starting with "Appendix" are skipped)

style:
  highlight_theme: github   # any highlight.js theme — see "Syntax highlighting themes"
  header_text: ""
  footer_text: ""
  # cover_image: cover.jpg  # replaces the default gradient cover background
  # custom_css: custom.css  # appended after the built-in stylesheet

# Uncomment to save intermediate HTML for debugging:
# save_html: debug.html

# Only needed if Chrome/Chromium auto-detection picks the wrong browser —
# see "Troubleshooting: Failed to launch the browser process!"
# chrome_path: /usr/bin/google-chrome-stable
```

All paths (`pages`, `cover_image`, `custom_css`, `save_html`, `output`) resolve relative to the `book.yaml` file, not your current directory. `chrome_path` is the one exception — it's a system path, passed through as-is.

## Chapters, pagination, and page breaks

A **chapter** is any top-level `#` heading, anywhere in the combined book — not tied to file boundaries. This means:

- One Markdown file can hold multiple chapters (each still gets its own page).
- Files that continue a chapter without opening with a new `#` heading just flow onto the previous page instead of forcing a blank break.
- Headings that start with "Appendix" are automatically excluded from `--chapter-numbers` numbering, since "Chapter 6: Appendix A" reads wrong.

For a break *inside* a chapter (before a big diagram or table, say) without starting a new chapter, drop a marker on its own line:

```markdown
<!-- pagebreak -->
```
or
```markdown
\pagebreak
```

## Markdown features

### Code blocks

Fenced code blocks are syntax-highlighted via highlight.js and get a header bar with a color-coded language badge — the same colors [GitHub's own language stats](https://github.com/github-linguist/linguist) use — so a book with mixed `bash`/`python`/`javascript` snippets stays easy to scan at a glance:

~~~markdown
```python
def greet(name):
    return f"Hello, {name}!"
```
~~~

The badge is generated from the fence's language tag (any of the ~190 highlight.js recognizes, plus common aliases like `js`/`py`/`sh`), not a per-language logo asset — see [Syntax highlighting themes](#syntax-highlighting-themes) for theming the code itself.

### LaTeX math

Inline math with `$...$`, display math with `$$...$$` or `\[...\]` / `\(...\)`. Rendered via KaTeX, synchronously, so there's no race with the PDF export step.

```markdown
The quadratic formula: $x = \frac{-b \pm \sqrt{b^2-4ac}}{2a}$

$$\sum_{k=1}^{n} k = \frac{n(n+1)}{2}$$
```

### Mermaid diagrams

Standard fenced ` ```mermaid ` blocks. Two label quirks are handled automatically so diagrams look the way you'd expect:

- **Line breaks**: a literal `\n` inside a label becomes a real line break.
- **Quotes**: `\"escaped like this\"` inside a label renders as typographic curly quotes (`"like this"`) — Mermaid's own grammar can't represent a literal straight quote inside a quoted label at all, so this is the only reliable way to get one to display.

Both are md2pdf-book-specific preprocessing, so this example is shown as plain text rather than a live diagram — a stock Mermaid renderer (GitHub's included) doesn't understand either and will fail to parse it. It renders correctly once this tool processes it:

~~~text
```mermaid
flowchart TD
    A["Request received\nvalidated by middleware"] --> B{Cache hit?}
    B -->|No| C["Query source: \"users\" table"]
```
~~~

### Admonitions / callouts

GitHub-style syntax — the marker must be the first line of a blockquote:

```markdown
> [!NOTE]
> Useful context the reader shouldn't miss.

> [!WARNING]
> Something that could bite them.
```

Supported types: `NOTE`, `TIP`, `IMPORTANT`, `WARNING`, `CAUTION`. Anything else (including a plain `>` quote with no marker) renders as a normal blockquote — nothing breaks if you mix both styles in the same document.

### Footnotes

Pandoc-style, defined anywhere in the same file as the reference:

```markdown
This claim needs a source.[^1]

[^1]: Here's the source.
```

With the default (`chromium`) engine, footnotes are collected into a numbered list with backlinks at the end of the file they're defined in. With `engine: pagedjs`, they render at the bottom of the exact physical page they're referenced on — see [Pagination engines](#pagination-engines).

### Images

`![alt](./relative/path.png)` resolves relative to the Markdown file it's written in (not your working directory) and is inlined as base64 — no `file://` path issues, no broken images if you move the output PDF elsewhere.

### Table of contents

Auto-generated from your headings. Drop `[TOC]` on its own line anywhere to place it inline; otherwise it gets its own page right after the cover. Use `features.toc_depth` / `--toc-depth <n>` to cap how deep it goes (e.g. `2` lists only H1/H2, keeping a long book's TOC to one page) — this only affects which entries the TOC lists, heading anchors in the body are unchanged.

## Syntax highlighting themes

`style.highlight_theme` / `--highlight-theme` accepts any theme name from [highlight.js's style library](https://highlightjs.org/examples) (~80 of them: `github`, `github-dark`, `monokai`, `nord`, `atom-one-dark`, `night-owl`, `tokyo-night-dark`, ...) — not just the two GitHub themes. Pass an unknown name and the build fails fast with a clear error rather than silently falling back:

```bash
md2pdf-book book.yaml --highlight-theme nord
```
```yaml
style:
  highlight_theme: nord
```

The code block's language-label bar gets bespoke dark styling for `github-dark`; every other theme still renders correctly, just with the default light label bar.

## Custom CSS

For style tweaks beyond what `layout`/`style` options expose, point at a CSS file — it's appended after the built-in stylesheet, so it wins the cascade at equal specificity without needing `!important`:

```bash
md2pdf-book book.yaml --css my-overrides.css
```
```yaml
style:
  custom_css: custom.css   # resolved relative to book.yaml
```

## Pagination engines

| | `chromium` (default) | `pagedjs` |
|---|---|---|
| Speed | Fast | Slower (does its own JS-driven layout pass) |
| Running header | Static text only (`style.header_text`) | Tracks the **current chapter title**, updating per page |
| Footnotes | End-of-file list per source file | Render at the **bottom of the page they're referenced on** |
| Maturity | Battle-tested (Chromium's native print engine) | Newer, more moving parts |

Chromium's print engine doesn't implement the CSS Paged Media margin-box spec at all — there's no way to get a real "current chapter" running header or a footnote that lands on the correct physical page without a different layout engine. [Paged.js](https://pagedjs.org) is that engine: it lays out actual page-sized boxes in the DOM (implementing `string-set`/`string()` and `float: footnote`) before Puppeteer prints them.

```bash
md2pdf-book book.yaml --engine pagedjs
```
or in `book.yaml`:
```yaml
layout:
  engine: pagedjs
```

Start with the default; reach for `pagedjs` specifically when you want a real running chapter header or true per-page footnotes.

## Validating a book without rendering it (`--lint`)

```bash
md2pdf-book book.yaml --lint
```

Checks, without launching a browser:
- **Missing local images** — a `![](./img.png)` that doesn't resolve to a real file.
- **Unresolved footnotes** — a `[^id]` reference with no matching `[^id]: ...` definition.
- **Duplicate heading ids across chapters** — two chapters that each have e.g. `## Overview` get the same anchor id; the build auto-renames the second one, which can silently break an explicit `[link](#overview)` you wrote by hand.

Exits with status 1 if anything's found (CI-friendly), 0 if clean.

## Using it as a library

```js
import { convertToPdf, convertFromConfig, buildBookHtml } from 'md2pdf-book';

// From a YAML config
await convertFromConfig('book.yaml', { verbose: true });

// From an explicit file list
await convertToPdf(['intro.md', 'chapter1.md'], 'book.pdf', {
  title: 'My Book',
  author: 'Jane Smith',
});

// Just want the HTML (e.g. to render it yourself)?
const html = buildBookHtml(['intro.md'], { title: 'My Book' });
```

## Why fully offline?

Every renderer this tool depends on — KaTeX, Mermaid, highlight.js, Paged.js — is vendored under `vendor/` (or read from the local npm dependency, for highlight.js) and inlined directly into the generated HTML rather than loaded from a CDN `<script src>`. That means:

- Builds work in CI, in Docker, on a plane — anywhere without network access.
- Output is reproducible: a CDN silently shipping a new library version tomorrow can't change what your book looks like today.
- No render-time dependency on a third party staying up.

## Project layout

```
bin/md2pdf.js     CLI entry point
src/config.js     book.yaml loading, validation, and defaults
src/converter.js  Markdown -> HTML (preprocessing, marked renderer overrides, page CSS)
src/renderer.js   HTML -> PDF via Puppeteer (both pagination engines)
src/assets.js     Loads vendored KaTeX/Mermaid/Paged.js/highlight.js for inlining
src/lint.js       --lint validation checks
src/index.js      Programmatic API
vendor/           Vendored third-party browser bundles (see "Why fully offline?")
examples/         A full example book exercising every feature
.npmignore        Trims the published npm tarball (examples/, dotfiles, ...);
                  package.json's "files" field is the actual allowlist —
                  bin/, src/, vendor/, README.md, LICENSE — vendor/ ships
                  because src/assets.js reads it at runtime.
```

## License

MIT — see [LICENSE](LICENSE).
