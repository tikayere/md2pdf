'use strict';

/**
 * converter.js
 *
 * Converts Markdown → full book HTML.
 *
 * Key fixes over v1:
 *
 *  LaTeX
 *  ─────
 *  • `preprocessLatex` now actually escapes content for KaTeX:
 *      - Protects fenced/inline code blocks
 *      - Escapes HTML entities inside $...$ and $$...$$ so marked
 *        doesn't mangle backslashes/underscores
 *      - Outputs raw <span data-math> and <div data-math-display>
 *        elements that our inline init script renders with katex.renderToString()
 *        SYNCHRONOUSLY — no reliance on deferred auto-render timing
 *
 *  Mermaid
 *  ───────
 *  • Upgraded to Mermaid v11 (fixes classDiagram, sequenceDiagram, gitGraph bugs)
 *  • startOnLoad: false — we control the render order explicitly
 *  • DOM transform runs first, then mermaid.run() is called once
 *  • securityLevel: 'loose' so HTML labels work
 *  • fontFamily matches the book body font
 */

import { marked }            from 'marked';
import { gfmHeadingId }      from 'marked-gfm-heading-id';
import hljs                  from 'highlight.js';
import matter                from 'gray-matter';
import path                  from 'node:path';
import fs                    from 'node:fs';

import { katexJs, katexCss, mermaidJs, pagedJs, getHljsThemeCss } from './assets.js';

// ─── marked setup ────────────────────────────────────────────────────────────
//
// Important: we register the renderer once at module load, not inside
// markdownToHtml(), so it is not re-registered on every call.

marked.use(gfmHeadingId());
marked.use({ gfm: true, breaks: false });

// ─── Front matter ─────────────────────────────────────────────────────────────

function parseFrontMatter(markdown) {
  try {
    return matter(markdown);
  } catch {
    return { data: {}, content: markdown };
  }
}

// ─── LaTeX preprocessing ─────────────────────────────────────────────────────

/**
 * Convert LaTeX math delimiters in Markdown to placeholder elements
 * BEFORE marked processes the text.
 *
 * Why placeholders instead of letting KaTeX auto-render fire later?
 *   - marked will escape underscores inside $...$ as \_ or wrap them in <em>
 *   - auto-render relies on deferred script timing; Puppeteer's networkidle0
 *     does not guarantee all deferred callbacks have completed
 *   - By converting to <span data-math="..."> before parsing we get:
 *       1. Marked leaves the span alone (it's already HTML)
 *       2. We render KaTeX synchronously in the page's inline <script>
 *          so it is guaranteed to be done before Puppeteer takes the snapshot
 *
 * Encoding: math content is base64-encoded inside the data attribute to
 * survive HTML attribute escaping.
 */
function preprocessLatex(content) {
  // Step 1 — protect fenced code blocks
  const protected_ = [];
  const placeholder = (s) => {
    protected_.push(s);
    return `\x00PROTECTED_${protected_.length - 1}\x00`;
  };

  // Fenced code blocks (``` or ~~~)
  content = content.replace(/(`{3,}|~{3,})[^\n]*\n[\s\S]*?\1/g, placeholder);

  // Indented code blocks (4 spaces / 1 tab)
  content = content.replace(/^( {4}|\t)[^\n]+(\n( {4}|\t)[^\n]+)*/gm, placeholder);

  // Inline code
  content = content.replace(/`[^`\n]+`/g, placeholder);

  // Step 2 — convert display math $$...$$ → <div data-math-display>
  //          must run before inline to avoid double-processing
  content = content.replace(/\$\$([\s\S]+?)\$\$/g, (_match, tex) => {
    const encoded = Buffer.from(tex).toString('base64');
    return `<div data-math-display="${encoded}"></div>`;
  });

  // Also handle \[ ... \] display math
  content = content.replace(/\\\[([\s\S]+?)\\\]/g, (_match, tex) => {
    const encoded = Buffer.from(tex).toString('base64');
    return `<div data-math-display="${encoded}"></div>`;
  });

  // Step 3 — convert inline math $...$ → <span data-math>
  //          We use a negative lookbehind to avoid matching \$ (escaped dollar)
  content = content.replace(/(?<!\\)\$([^$\n]+?)(?<!\\)\$/g, (_match, tex) => {
    const encoded = Buffer.from(tex).toString('base64');
    return `<span data-math="${encoded}"></span>`;
  });

  // Also handle \( ... \) inline math
  content = content.replace(/\\\((.+?)\\\)/g, (_match, tex) => {
    const encoded = Buffer.from(tex).toString('base64');
    return `<span data-math="${encoded}"></span>`;
  });

  // Step 4 — restore protected blocks
  content = content.replace(
    /\x00PROTECTED_(\d+)\x00/g,
    (_, i) => protected_[parseInt(i)]
  );

  return content;
}

// ─── Mermaid preprocessing ───────────────────────────────────────────────────

/**
 * Fix up a raw Mermaid source block so it renders the way authors expect.
 *
 * Mermaid's own grammar has two long-standing rough edges that trip up
 * anyone writing labels the way they would in any other string:
 *
 *   1. A literal `\n` inside a label is NOT turned into a line break —
 *      Mermaid renders the two characters `\` and `n` verbatim. HTML labels
 *      (which we enable via `htmlLabels: true` / `securityLevel: loose`) DO
 *      support `<br/>`, so we translate `\n` → `<br/>` before the diagram
 *      source is embedded in the page.
 *
 *   2. Backslash-escaped quotes (`\"`) inside a quoted label are not
 *      supported by Mermaid's parser at all — it leaves stray backslashes
 *      in the output and silently drops the quote characters. Using the
 *      `&quot;` entity doesn't help either: Mermaid reads the *decoded*
 *      `.textContent` in the browser, so by the time its own grammar sees
 *      the string the entity has already become a literal `"`, which still
 *      terminates the label early. The only reliable fix is to never
 *      produce a literal ASCII quote there — we swap `\"` for typographic
 *      curly quotes (“ ”), alternating open/close, which render as a
 *      normal-looking quote but aren't significant to Mermaid's parser.
 *
 * This runs on the *already HTML-escaped* text (see `code()` below) so the
 * `<br/>` tags we inject survive as real tags rather than being re-escaped.
 */
function preprocessMermaid(escapedCode) {
  let openQuote = true;
  return escapedCode
    .replace(/\\n/g, '<br/>')
    .replace(/\\"/g, () => {
      const quoteChar = openQuote ? '“' : '”';
      openQuote = !openQuote;
      return quoteChar;
    });
}

// ─── Manual page-break marker ────────────────────────────────────────────────

/**
 * Lets an author force a page break inside a chapter without starting a new
 * markdown file — e.g. before a large diagram or table.
 *
 * Recognized on a line by itself (leading/trailing whitespace ignored):
 *   <!-- pagebreak -->
 *   \pagebreak
 *
 * Runs before `marked()` so the injected raw <div> passes through untouched
 * (marked leaves block-level raw HTML alone).
 */
function preprocessPageBreaks(content) {
  return content.replace(
    /^[ \t]*(?:<!--\s*pagebreak\s*-->|\\pagebreak)[ \t]*$/gim,
    '<div class="page-break"></div>'
  );
}

// ─── Local image path resolution ─────────────────────────────────────────────

/**
 * Rewrite relative <img src="..."> paths to inline base64 data URIs.
 *
 * Puppeteer renders our HTML via page.setContent(), which gives the
 * document an `about:blank` origin. A perfectly normal
 * `![diagram](./images/foo.png)` — relative to the markdown file it's
 * written in — would otherwise never resolve: Chromium refuses to load
 * `file://` resources from a non-file:// document at all
 * (`net::ERR_UNKNOWN_URL_SCHEME`), no launch flag overrides it. Inlining the
 * bytes as a data: URI sidesteps that restriction entirely and, as a bonus,
 * keeps the rendered HTML fully self-contained. We run this per source
 * file, using that file's own directory as the base. http(s), data:, and
 * other already-resolvable URLs are left untouched; a missing file is left
 * as-is so the browser shows the same broken-image outcome it would have
 * before.
 */
function resolveImagePaths(html, baseDir) {
  return html.replace(/(<img\s[^>]*\bsrc=)(["'])(.*?)\2/gi, (match, pre, quote, src) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) return match; // already a URL (http, https, data, //...)
    const absPath = path.resolve(baseDir, decodeURIComponent(src));
    const dataUrl = fileToDataUri(absPath);
    return dataUrl ? `${pre}${quote}${dataUrl}${quote}` : match;
  });
}

/** Reads a file from disk and returns it as a data: URI, or null if it can't be read. */
function fileToDataUri(absPath) {
  try {
    const data = fs.readFileSync(absPath);
    return `data:${mimeTypeFor(absPath)};base64,${data.toString('base64')}`;
  } catch {
    return null;
  }
}

const IMAGE_MIME_TYPES = {
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.webp': 'image/webp',
  '.bmp':  'image/bmp',
};

function mimeTypeFor(filePath) {
  return IMAGE_MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

// ─── Footnotes ────────────────────────────────────────────────────────────────

/**
 * Pandoc/PHP-Markdown-Extra style footnotes: `text[^1]` referencing a
 * `[^1]: definition` line anywhere in the same file. Runs on raw markdown,
 * after LaTeX preprocessing (so `$x^2$` inside a footnote definition has
 * already become a safe placeholder) and before marked() parses the file.
 *
 * Scope: footnotes are collected per markdown *file*, not per chapter —
 * simple and predictable, matching how image paths are also resolved
 * per file. A chapter that spans several files gets one footnote list per
 * file rather than one continuous list; fine for the common case of one
 * chapter per file, worth knowing if you split a single chapter across
 * several files and expect continuous numbering.
 *
 * Returns { content, footnotes } — content with definitions removed and
 * references replaced by numbered <sup> links; footnotes in reference order.
 */
function preprocessFootnotes(content) {
  const protected_ = [];
  const placeholder = (s) => {
    protected_.push(s);
    return `\x00FNPROTECTED_${protected_.length - 1}\x00`;
  };

  // Protect code so a literal "[^1]" in a code sample is never touched.
  content = content.replace(/(`{3,}|~{3,})[^\n]*\n[\s\S]*?\1/g, placeholder);
  content = content.replace(/`[^`\n]+`/g, placeholder);

  const definitions = new Map();
  content = content.replace(
    /^\[\^([^\]\s]+)\]:[ \t]*(.+(?:\n(?:[ \t]+\S.*))*)$/gm,
    (_match, id, text) => {
      definitions.set(id, text.replace(/\n[ \t]+/g, ' ').trim());
      return '';
    }
  );

  // A neutral placeholder — deliberately not real markup yet. How a
  // reference should render depends on the pagination engine (see
  // renderFootnoteRefs()): the default Chromium engine can only place
  // footnotes in an end-of-file list, while the Paged.js engine renders
  // them inline via `float: footnote` so they land at the bottom of
  // whichever physical page they were actually referenced on.
  const order = [];
  content = content.replace(/\[\^([^\]\s]+)\]/g, (match, id) => {
    if (!definitions.has(id)) return match; // no matching definition — leave as literal text

    if (!order.includes(id)) order.push(id);
    return `\x00FOOTNOTE_REF_${id}\x00`;
  });

  const restore = (s) => s.replace(/\x00FNPROTECTED_(\d+)\x00/g, (_, i) => protected_[parseInt(i, 10)]);

  content = restore(content);
  const footnotes = order.map((id) => ({ id, text: restore(definitions.get(id)) }));
  return { content, footnotes };
}

/**
 * Replaces the \x00FOOTNOTE_REF_id\x00 placeholders left by preprocessFootnotes()
 * with the markup appropriate to the active pagination engine.
 *
 *   chromium — Chromium's print engine has no notion of "float this to the
 *              bottom of whatever page it lands on", so references become a
 *              numbered <sup> link down to an end-of-file list.
 *
 *   pagedjs  — Paged.js implements the CSS `float: footnote` proposal, so
 *              the note's full text is inlined right at the reference
 *              point; Paged.js physically relocates it to the bottom of
 *              its page and generates the numbered call-out itself
 *              (`::footnote-call`) — no separate list or backlink needed.
 */
function renderFootnoteRefs(content, footnotes, engine) {
  if (!footnotes.length) return content;

  if (engine === 'pagedjs') {
    const byId = new Map(footnotes.map((f) => [f.id, f.text]));
    return content.replace(/\x00FOOTNOTE_REF_([^\x00]+)\x00/g, (_match, id) => {
      const rendered = markdownToHtml(byId.get(id)).replace(/^<p>([\s\S]*)<\/p>\s*$/, '$1');
      return `<span class="footnote">${rendered}</span>`;
    });
  }

  let num = 0;
  const numberOf = new Map();
  return content.replace(/\x00FOOTNOTE_REF_([^\x00]+)\x00/g, (_match, id) => {
    if (!numberOf.has(id)) numberOf.set(id, ++num);
    const safeId = escapeHtml(id);
    return `<sup class="footnote-ref" id="fnref-${safeId}"><a href="#fn-${safeId}">${numberOf.get(id)}</a></sup>`;
  });
}

/** Renders the collected footnote definitions as an end-of-file list with backlinks (chromium engine only). */
function buildFootnotesHtml(footnotes) {
  if (!footnotes.length) return '';

  const items = footnotes.map(({ id, text }) => {
    const safeId = escapeHtml(id);
    const rendered = markdownToHtml(text).replace(/^<p>([\s\S]*)<\/p>\s*$/, '$1');
    return (
      `<li id="fn-${safeId}">${rendered} ` +
        `<a href="#fnref-${safeId}" class="footnote-backref">↩</a>` +
      `</li>`
    );
  });

  return (
    `<section class="footnotes">` +
      `<div class="footnotes-sep"></div>` +
      `<ol>${items.join('')}</ol>` +
    `</section>`
  );
}

// ─── Admonitions ──────────────────────────────────────────────────────────────

const ADMONITION_TYPES = {
  note:      { label: 'Note',      className: 'note' },
  tip:       { label: 'Tip',       className: 'tip' },
  important: { label: 'Important', className: 'important' },
  warning:   { label: 'Warning',   className: 'warning' },
  caution:   { label: 'Caution',   className: 'caution' },
};

// ─── Custom renderer (registered once at module load) ────────────────────────
//
// marked v12 changed renderer method signatures:
//   code(codeString, lang, escaped)   ← v12 uses positional args, not a token object
//   codespan(text)
//   blockquote(quote)
//   image(href, title, text)
//
// We register this once here rather than inside markdownToHtml() to avoid
// re-registering on every file conversion (which would stack the overrides).

marked.use({
  renderer: {

    // ── Code blocks ──────────────────────────────────────────────────────────
    code(code, lang) {
      const language = (lang || '').trim().toLowerCase();

      // Mermaid — convert to a plain div; mermaid.run() handles it in-browser
      if (language === 'mermaid') {
        // The code content is already a plain string from marked.
        // We HTML-encode it so the browser sees literal text, not markup,
        // then fix up the label quirks described in preprocessMermaid().
        const encoded = code
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
        return `<div class="mermaid">${preprocessMermaid(encoded)}</div>\n`;
      }
      const normalizedCode = code.replace(/^\s*\n/, '');
      const validLang = language && hljs.getLanguage(language) ? language : null;

      const highlighted = validLang
        ? hljs.highlight(normalizedCode, { language: validLang }).value
        : hljs.highlightAuto(normalizedCode).value;

      const langLabel = language
        ? `<span class="code-lang">${escapeHtml(language)}</span>`
        : '';

      return (
        `<div class="code-block-wrapper">` +
          `${langLabel}` +
          `<pre><code class="hljs ${validLang || ''}">${highlighted}</code></pre>` +
        `</div>\n`
      );
    },

    // ── Inline code ──────────────────────────────────────────────────────────
    codespan(text) {
      return `<code class="inline-code">${text}</code>`;
    },

    // ── Blockquotes / admonitions ────────────────────────────────────────────
    //
    // GitHub-style callout syntax:
    //   > [!NOTE]
    //   > Body text, can span multiple paragraphs.
    //
    // marked hands us the blockquote's *already-rendered* inner HTML, so the
    // marker always shows up as a literal "[!TYPE]" at the very start of the
    // first <p>, followed by a real newline (blockquote lines within one
    // paragraph aren't turned into <br>). We detect and strip it there;
    // anything that doesn't match a known type falls through to a plain
    // blockquote unchanged.
    blockquote(quote) {
      const match = quote.match(/^<p>\s*\[!(\w+)\]\s*\n?/i);
      const admonition = match && ADMONITION_TYPES[match[1].toLowerCase()];

      if (admonition) {
        const rest = quote.slice(match[0].length);
        return (
          `<div class="admonition admonition-${admonition.className}">` +
            `<p class="admonition-title">${admonition.label}</p>` +
            `<p>${rest}` +
          `</div>\n`
        );
      }

      return `<blockquote class="book-blockquote">${quote}</blockquote>\n`;
    },

    // ── Images ───────────────────────────────────────────────────────────────
    image(href, title, text) {
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
      return (
        `<figure class="book-figure">` +
          `<img src="${href}" alt="${escapeHtml(text || '')}"${titleAttr} />` +
          (title ? `<figcaption>${escapeHtml(title)}</figcaption>` : '') +
        `</figure>\n`
      );
    },
  },
});

// ─── Markdown → HTML ─────────────────────────────────────────────────────────

function markdownToHtml(markdownContent) {
  return marked(markdownContent);
}

// ─── TOC ─────────────────────────────────────────────────────────────────────

function extractHeadings(html) {
  const headings = [];
  const regex    = /<h([1-6])[^>]*id="([^"]+)"[^>]*>(.*?)<\/h[1-6]>/gi;
  let match;

  while ((match = regex.exec(html)) !== null) {
    headings.push({
      level: parseInt(match[1]),
      id:    match[2],
      text:  match[3].replace(/<[^>]+>/g, ''),
    });
  }

  return headings;
}

function buildToc(headings) {
  if (!headings.length) return '';

  let toc   = '<nav class="toc"><h2 class="toc-title">Table of Contents</h2><ul>';
  const stack = [];

  headings.forEach((h) => {
    const level = h.level;

    while (stack.length > 0 && stack[stack.length - 1] > level) {
      toc += '</li></ul>';
      stack.pop();
    }

    if (stack.length === 0) {
      stack.push(level);
    } else if (stack[stack.length - 1] < level) {
      toc += '<ul>';
      stack.push(level);
    } else {
      toc += '</li>';
    }

    toc += `<li class="toc-level-${level}"><a href="#${h.id}">${h.text}</a>`;
  });

  // Close remaining open items
  toc += '</li>';
  while (stack.length > 0) {
    toc += '</ul>';
    stack.pop();
  }

  toc += '</nav>';
  return toc;
}

/**
 * Make every heading id unique across the whole book.
 *
 * `marked-gfm-heading-id` assigns ids per markdown file (each file gets its
 * own `marked()` call), so two chapters that each have a `## Overview`
 * both produce `id="overview"`. Left alone, the TOC link and any anchor to
 * the second one silently resolve to the first heading in the DOM instead.
 * This runs once over the fully combined HTML and renumbers repeats
 * (`overview`, `overview-2`, `overview-3`, ...) before the TOC is built from
 * it, so TOC links always land on the right chapter.
 */
function dedupeHeadingIds(html) {
  const seen = new Map();
  return html.replace(/(<h[1-6][^>]*\bid=")([^"]+)(")/gi, (match, pre, id, post) => {
    const count = seen.get(id) ?? 0;
    seen.set(id, count + 1);
    if (count === 0) return match;
    return `${pre}${id}-${count + 1}${post}`;
  });
}

function processTocMarker(html, tocHtml) {
  return html
    .replace(/<p>\[TOC\]<\/p>/gi, tocHtml)
    .replace(/<p>\[toc\]<\/p>/gi, tocHtml);
}

/**
 * Mark every top-level (H1) heading except the first as a chapter start, so
 * it begins on a new page. Chapters are defined by H1 headings, not by file
 * boundaries — several `# Chapter` headings inside one markdown file each
 * get their own page, and a file that doesn't open with an H1 just
 * continues the previous chapter's flow instead of forcing a blank break.
 */
function applyChapterBreaks(html, enabled) {
  if (!enabled) return html;

  let seenFirst = false;
  return html.replace(/<h1([^>]*)>/g, (match, attrs) => {
    if (!seenFirst) {
      seenFirst = true;
      return match;
    }
    return `<h1${attrs} class="chapter-heading">`;
  });
}

/**
 * Stamps each h1's own clean title text onto a data-title attribute.
 *
 * Needed for the Paged.js engine's running header: CSS string-set's
 * content() value captures an element's full rendered text, including any
 * descendants — so once applyChapterNumbers() nests a "Chapter N" span
 * inside the h1, content() would capture "Chapter 1Introduction" mashed
 * together. Reading attr(data-title) instead sidesteps that entirely.
 * Runs before applyChapterNumbers() so the attribute always holds just the
 * heading's own text. Inert under the chromium engine.
 */
function injectChapterTitleAttr(html) {
  return html.replace(/<h1([^>]*)>([\s\S]*?)<\/h1>/g, (match, attrs, inner) => {
    const plainText = inner.replace(/<[^>]+>/g, '').trim();
    return `<h1${attrs} data-title="${escapeHtml(plainText)}">${inner}</h1>`;
  });
}

/**
 * Prefix each chapter's H1 with a "Chapter N" label — nested *inside* the
 * h1 (rather than as a preceding sibling) so it travels through the page
 * break together with the title it belongs to. Headings that look like
 * appendices ("Appendix A: ...") are left unnumbered, since "Chapter 6:
 * Appendix A" reads wrong; appendices conventionally use their own lettering.
 *
 * Must run after extractHeadings()/buildToc() have already read the plain
 * heading text, so the "Chapter N" label never leaks into TOC entries or
 * heading ids.
 */
function applyChapterNumbers(html, enabled) {
  if (!enabled) return html;

  let num = 0;
  return html.replace(/<h1([^>]*)>([\s\S]*?)<\/h1>/g, (match, attrs, inner) => {
    const plainText = inner.replace(/<[^>]+>/g, '').trim();
    if (/^appendix\b/i.test(plainText)) return match;
    num++;
    return `<h1${attrs}><span class="chapter-number">Chapter ${num}</span>${inner}</h1>`;
  });
}

// ─── Full book HTML builder ───────────────────────────────────────────────────

function buildBookHtml(files, options = {}) {
  const {
    title          = 'Book',
    author         = '',
    date           = new Date().toLocaleDateString(),
    pageSize       = 'A4',
    coverPage      = true,
    pageNumbers    = true,
    chapterBreaks  = true,
    chapterNumbers = false,
    fontSize       = '11pt',
    lineHeight     = '1.6',
    margins        = { top: '2.5cm', bottom: '2.5cm', left: '3cm', right: '2.5cm' },
    headerText     = '',
    footerText     = '',
    showToc        = true,
    highlightTheme = 'github',
    coverImage     = null,
    engine         = 'chromium', // 'chromium' | 'pagedjs' — see renderer.js
  } = options;

  // ── Process each markdown file ──
  const allSections = [];

  files.forEach((filePath, idx) => {
    const raw = fs.readFileSync(filePath, 'utf8');
    const { content } = parseFrontMatter(raw);

    // Preprocessing must happen on raw markdown, before marked runs
    const { content: withoutFootnotes, footnotes } = preprocessFootnotes(preprocessLatex(content));
    const processed = preprocessPageBreaks(withoutFootnotes);

    let bodyHtml = renderFootnoteRefs(markdownToHtml(processed), footnotes, engine);
    bodyHtml = resolveImagePaths(bodyHtml, path.dirname(filePath));
    if (engine !== 'pagedjs') {
      bodyHtml += buildFootnotesHtml(footnotes);
    }

    allSections.push(
      `<article class="chapter chapter-${idx}" data-chapter="${idx + 1}">` +
        bodyHtml +
      `</article>`
    );
  });

  // Chapters are delimited by top-level (H1) headings rather than by file
  // boundaries. This lets a single markdown file hold several chapters
  // (each gets its own page) while files that continue a chapter without
  // a new H1 simply flow onto the same page as the previous one.
  let combinedHtml = injectChapterTitleAttr(dedupeHeadingIds(
    applyChapterBreaks(allSections.join('\n'), chapterBreaks)
  ));

  // TOC/heading extraction must happen before chapter numbers are stamped
  // in, so "Chapter 3" never leaks into a TOC entry or a heading id.
  const headings = extractHeadings(combinedHtml);
  const tocHtml   = buildToc(headings);

  combinedHtml = applyChapterNumbers(combinedHtml, chapterNumbers);

  let bodyHtml = combinedHtml;
  if (showToc) {
    bodyHtml = processTocMarker(bodyHtml, tocHtml);
  }

  // ── Derived values ──
  const hljsThemeCss =
    highlightTheme === 'github-dark' || highlightTheme === 'dark'
      ? 'github-dark'
      : 'github';

  const pageMarginCss = [
    `size: ${pageSize}`,
    `margin: ${margins.top} ${margins.right} ${margins.bottom} ${margins.left}`,
  ].join('; ');

  const hasTocMarker =
    combinedHtml.toLowerCase().includes('[toc]');

  const standaloneTocPage = showToc && !hasTocMarker
    ? `<div class="toc-page">${tocHtml}</div>`
    : '';

  // A user-supplied cover image replaces the default gradient background;
  // it's inlined as a data: URI for the same reason chapter images are (see
  // resolveImagePaths) — page.setContent() can't load file:// resources.
  const coverImageDataUri = coverImage ? fileToDataUri(coverImage) : null;
  const coverPageStyle = coverImageDataUri
    ? ` style="background-image: url('${coverImageDataUri}');"`
    : '';
  const coverPageClass = coverImageDataUri ? ' cover-page-image' : '';

  const coverHtml = coverPage
  ? `<div class="cover-page${coverPageClass}"${coverPageStyle}>
      <div class="cover-overlay"></div>

      <div class="cover-content">
        <div class="cover-accent"></div>

        <h1 class="cover-title">${escapeHtml(title)}</h1>

        ${
          author
            ? `<p class="cover-author">By ${escapeHtml(author)}</p>`
            : ''
        }

        ${
          date
            ? `<p class="cover-date">${escapeHtml(date)}</p>`
            : ''
        }
      </div>
    </div>`
  : '';

  // ── Page CSS counters & headers ──
  const pageRuleParts = [];
  if (engine === 'pagedjs') {
    // Paged.js actually implements CSS margin boxes, so this is where the
    // running chapter-title header becomes real (see the h1 string-set
    // rule below) — static headerText moves aside to top-right so both
    // can coexist, and page numbers genuinely work here too (they're
    // silently inert on the chromium engine — see renderer.js).
    pageRuleParts.push(`@top-center { content: string(chapter-title); font-size: 9pt; color: #888; }`);
    if (headerText) {
      pageRuleParts.push(`@top-right { content: "${escapeHtml(headerText)}"; font-size: 9pt; color: #888; }`);
    }
  } else if (headerText) {
    pageRuleParts.push(`@top-center { content: "${escapeHtml(headerText)}"; font-size: 9pt; color: #888; }`);
  }
  if (pageNumbers) {
    pageRuleParts.push(`@bottom-center { content: counter(page) " / " counter(pages); font-size: 9pt; color: #888; }`);
  }
  if (footerText) {
    pageRuleParts.push(`@bottom-right { content: "${escapeHtml(footerText)}"; font-size: 9pt; color: #888; }`);
  }
  const pageRuleCss = pageRuleParts.length
    ? `@page { ${pageRuleParts.join('\n  ')} }`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>

<!-- KaTeX CSS — vendored, fonts inlined as base64 (see src/assets.js) -->
<style>${katexCss}</style>

<!-- highlight.js theme — read from the npm dependency already on disk -->
<style>${getHljsThemeCss(hljsThemeCss)}</style>

<!-- Mermaid v11 — vendored; startOnLoad disabled, we call mermaid.run() manually -->
<script>${mermaidJs}</script>

${engine === 'pagedjs' ? `
<!-- Paged.js — vendored; auto-pagination disabled, renderer.js triggers it
     manually once KaTeX/Mermaid have finished rendering into the DOM. -->
<script>window.PagedConfig = { auto: false };</script>
<script>${pagedJs}</script>
` : ''}

<style>
/* ══════════════════════════════════════════════════════════════
   PAGE LAYOUT
   ══════════════════════════════════════════════════════════════ */

@page {
  ${pageMarginCss};
}

@page :first {
  margin: 0;
}

${pageRuleCss}

* {
  box-sizing: border-box;
}

html, body {
  margin: 0;
  padding: 0;
  background: white;
}

body {
  font-family: 'Georgia', 'Times New Roman', serif;
  font-size: ${fontSize};
  line-height: ${lineHeight};
  color: #1a1a1a;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}


/* ══════════════════════════════════════════════════════════════
   COVER PAGE
   ══════════════════════════════════════════════════════════════ */
.cover-page {
  position: relative;
  display: flex;
  justify-content: center;
  align-items: center;
  
  /* FIXED: Changed to strict height for print safety, ensuring border-box is respected */
  height: 100vh; 
  box-sizing: border-box;

  background:
    radial-gradient(circle at top left, rgba(255,255,255,0.08), transparent 40%),
    radial-gradient(circle at bottom right, rgba(255,255,255,0.05), transparent 35%),
    linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #334155 100%);

  color: white;
  text-align: center;
  /* FIXED: Reduced extreme padding to give a long title breathing room */
  padding: 2rem; 
  overflow: hidden;

  page-break-after: always;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

/* A user-supplied cover image (style.cover_image) replaces the gradient.
   background-image is set inline per-book; this just handles sizing and
   adds a darkening scrim behind .cover-content so the title stays legible
   regardless of how light the source image is. */
.cover-page-image {
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
}

.cover-page-image .cover-overlay {
  inset: 0;
  border: none;
  background: rgba(15, 23, 42, 0.55);
}

.cover-overlay {
  position: absolute;
  inset: 24px;
  border: 1px solid rgba(255,255,255,0.15);
  pointer-events: none;
}

.cover-content {
  position: relative;
  z-index: 1;

  max-width: 900px;
  width: 100%;
  /* FIXED: Allows the container to shrink if the title is massive, preventing page overflow */
  max-height: calc(100vh - 4rem); 
  display: flex;
  flex-direction: column;
  justify-content: center;

  padding: 2.5rem;
  border-radius: 24px;
  box-sizing: border-box;

  background: rgba(255,255,255,0.05);
  backdrop-filter: blur(10px);

  box-shadow:
    0 20px 60px rgba(0,0,0,0.35),
    inset 0 1px 0 rgba(255,255,255,0.08);
}

.cover-accent {
  width: 120px;
  height: 4px;
  /* FIXED: Reduced bottom margin slightly to save vertical space */
  margin: 0 auto 1.5rem; 

  background: linear-gradient(
    90deg,
    #60a5fa,
    #93c5fd,
    #60a5fa
  );

  border-radius: 999px;
  flex-shrink: 0;
}

.cover-title {
  margin: 0;

  /* FIXED: Uses clamp() so the font scales down safely on smaller screens/containers */
  font-size: clamp(2.2rem, 6vw, 4rem); 
  font-weight: 800;
  line-height: 1.2;
  letter-spacing: -0.03em;

  /* FIXED: Forces long words to break and wrap gracefully instead of breaking layout */
  overflow-wrap: break-word;
  word-wrap: break-word;
  hyphens: auto;

  color: #ffffff;

  text-shadow:
    0 4px 20px rgba(0,0,0,0.35);
}

.cover-author {
  /* FIXED: Changed to em/rem and allowed flexibility */
  margin-top: 2rem; 

  font-size: 1.25rem;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;

  color: #cbd5e1;
  flex-shrink: 0;
}

.cover-date {
  margin-top: 0.75rem;

  font-size: 1rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;

  color: #94a3b8;
  flex-shrink: 0;
}

@media print {
  .cover-content {
    box-shadow: none;
  }
}

/* ══════════════════════════════════════════════════════════════
   TABLE OF CONTENTS
   ══════════════════════════════════════════════════════════════ */

.toc-page {
  page-break-after: always;
}

.toc {
  margin: 0 0 2em 0;
}

.toc-title {
  font-size: 1.6em;
  font-weight: 700;
  color: #1a1a2e;
  border-bottom: 3px solid #0f3460;
  padding-bottom: 0.3em;
  margin-bottom: 1em;
}

.toc ul {
  list-style: none;
  padding: 0;
  margin: 0;
}

.toc ul ul {
  padding-left: 1.5em;
}

.toc li {
  margin: 0.2em 0;
}

.toc a {
  text-decoration: none;
  color: #2c3e50;
  display: flex;
  align-items: baseline;
}

.toc a::after {
  content: leader('. ');
  flex: 1;
  margin: 0 0.4em;
  color: #aaa;
}

.toc-level-1 > a { font-weight: 600; font-size: 1em; }
.toc-level-2 > a { font-size: 0.95em; }
.toc-level-3 > a { font-size: 0.90em; color: #555; }
.toc-level-4 > a { font-size: 0.85em; color: #777; }


/* ══════════════════════════════════════════════════════════════
   CHAPTERS
   ══════════════════════════════════════════════════════════════ */

/* Applied to every H1 except the first — see applyChapterBreaks() */
.chapter-heading {
  page-break-before: always;
}

/* Manual mid-chapter break — see preprocessPageBreaks() */
.page-break {
  page-break-before: always;
  height: 0;
  margin: 0;
  border: 0;
}


/* ══════════════════════════════════════════════════════════════
   HEADINGS
   ══════════════════════════════════════════════════════════════ */

h1, h2, h3, h4, h5, h6 {
  font-family: 'Helvetica Neue', 'Arial', sans-serif;
  font-weight: 700;
  color: #1a1a2e;
  margin-top: 1.4em;
  margin-bottom: 0.5em;
  line-height: 1.25;
  page-break-after: avoid;
}

h1 {
  font-size: 2em;
  border-bottom: 3px solid #0f3460;
  padding-bottom: 0.2em;
  margin-top: 0;
}

/* Paged.js engine only: every h1 inside the book content (excluding the
   cover title, which is also an h1 but isn't a chapter) is a chapter
   boundary (see applyChapterBreaks()), so its text becomes the running
   header shown by @page's top-center content: string(chapter-title) until
   the next h1 updates it. Inert/ignored under the default Chromium engine. */
.book-content h1 {
  string-set: chapter-title attr(data-title);
}

.chapter-number {
  display: block;
  font-family: 'Helvetica Neue', 'Arial', sans-serif;
  font-size: 0.5em;
  font-weight: 600;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: #57606a;
  margin-bottom: 0.4em;
}

h2 {
  font-size: 1.5em;
  border-bottom: 1px solid #cdd5df;
  padding-bottom: 0.15em;
}

h3  { font-size: 1.2em; color: #2c3e50; }
h4  { font-size: 1.05em; color: #34495e; }
h5  { font-size: 1em;    color: #5d6d7e; }
h6  { font-size: 0.95em; color: #7f8c8d; font-style: italic; }


/* ══════════════════════════════════════════════════════════════
   BODY TEXT
   ══════════════════════════════════════════════════════════════ */

/* ---------- Paragraphs ---------- */

p {
  margin: 0.75em 0;

  text-align: justify;
  text-justify: inter-word;

  hyphens: auto;

  orphans: 3;
  widows: 3;

  line-height: 1.65;

  color: #111827;
}

/* ---------- Links ---------- */

a {
  color: #0f3460;
  text-decoration: underline;
  text-underline-offset: 2px;
  text-decoration-thickness: 1px;
}

a:hover {
  color: #1d4ed8;
}

/* ---------- Lists ---------- */

ul,
ol {
  padding-left: 1.8em;
  margin: 0.6em 0;

  line-height: 1.6;
}

li {
  margin: 0.25em 0;
}

/* Nested lists tighter spacing */
li > ul,
li > ol {
  margin: 0.2em 0;
}

/* Better readability in long lists */
li p {
  margin: 0.3em 0;
}

/* ---------- Horizontal Rule ---------- */
hr {
  border: none;
  height: 1px;
  background: linear-gradient(
    90deg,
    transparent,
    #d0d7de,
    #d0d7de,
    transparent
  );
  margin: 2.5em 0;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

/* Optional: stronger section divider variant */
hr.section {
  height: 2px;
  background: linear-gradient(
    90deg,
    transparent,
    #1a1a2e,
    #d0d7de,
    #1a1a2e,
    transparent
  );
}

/* --- PRINT RULES (PDF EXPORT) --- */
@media print {
  hr, hr.section {
    /* Hides the visual line completely */
    background: none !important;
    display: none !important; 
    
    /* OPTIONAL: Keep this line if you want to keep the 2.5em space 
       between sections without showing the actual line: */
    /* display: block !important; height: 0 !important; margin: 2.5em 0 !important; */
  }
}

/* ══════════════════════════════════════════════════════════════
   CODE
   ══════════════════════════════════════════════════════════════ */

.code-block-wrapper {
  position: relative;
  margin: 1.5em 0;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid #dde1e7;
  page-break-inside: auto !important;
  break-inside: auto !important;
}

.code-lang {
  display: block;
  align-items: center;
  gap: 12px;

  line-height: 36px;
  padding: 0 1rem;

  background: #f8f9fa;
  color: #6b7280;

  font-family: "JetBrains Mono", monospace;
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;

  border-bottom: 1px solid #dde1e7;
}

.code-block-wrapper pre {
  margin: 0 !important;
  padding: 1.25rem 1.5rem;
  font-size: 0.80rem;
  line-height: 1.5;
}

.code-block-wrapper pre code {
  background: none;
  border: none;
  font-size: inherit;
  margin: 0 !important;
  padding: 0 !important;
  white-space: pre-wrap;
}
.code-block-wrapper pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
}

/* Force the pre and code tags to allow natural breaking */
.code-block-wrapper pre,
.code-block-wrapper code {
  page-break-inside: auto !important;
  break-inside: auto !important;
  display: block !important; /* Avoid flex or inline-block defaults */
  white-space: pre-wrap !important; /* Ensures long lines wrap instead of overflowing */
}

@media print {
  /* If your header and pre are flex items, reset them */
  .code-block-wrapper {
    display: block !important;
  }
  
  .code-lang {
    display: block !important;
    width: 100%;
  }
}

/* ══════════════════════════════════════════════════════════════
   TABLES
   ══════════════════════════════════════════════════════════════ */

/* ---------- Table Base ---------- */

table {
  width: 100%;
  border-collapse: collapse;

  font-size: 0.93em;

  margin: 1.2em 0;

  table-layout: fixed; /* prevents PDF overflow issues */

  page-break-inside: avoid;
}

/* ---------- Header ---------- */

thead {
  background: #1a1a2e;
  color: white;

  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

thead th {
  padding: 0.6em 1em;

  text-align: left;
  font-weight: 600;

  white-space: normal;
}

/* ---------- Body ---------- */

tbody tr:nth-child(even) {
  background: #f5f7fa;
}

tbody tr:nth-child(odd) {
  background: white;
}

/* ---------- Cells ---------- */

td,
th {
  padding: 0.5em 1em;

  border: 1px solid #e1e4e8;

  vertical-align: top;

  word-break: break-word;      /* prevents overflow */
  overflow-wrap: anywhere;     /* handles long strings/URLs */
}

/* ---------- PDF / Print Safety ---------- */

@media print {
  table {
    page-break-inside: auto;
  }

  tr {
    page-break-inside: avoid;
    page-break-after: auto;
  }

  td,
  th {
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
}

/* ══════════════════════════════════════════════════════════════
   BLOCKQUOTES
   ══════════════════════════════════════════════════════════════ */

.book-blockquote {
  border-left: 4px solid #0f3460;
  margin: 1.2em 0;
  padding: 0.6em 1.2em;
  background: #f0f4fa;
  color: #34495e;
  font-style: italic;
  border-radius: 0 4px 4px 0;
  page-break-inside: avoid;
}

.book-blockquote p {
  margin: 0;
}


/* ══════════════════════════════════════════════════════════════
   ADMONITIONS / CALLOUTS
   ══════════════════════════════════════════════════════════════ */

.admonition {
  margin: 1.2em 0;
  padding: 0.7em 1.2em;
  border-left: 4px solid #57606a;
  background: #f6f8fa;
  border-radius: 0 4px 4px 0;
  page-break-inside: avoid;
}

.admonition p {
  margin: 0.4em 0 0 0;
  font-style: normal;
}

.admonition-title {
  margin: 0 !important;
  font-family: 'Helvetica Neue', 'Arial', sans-serif;
  font-weight: 700;
  font-size: 0.85em;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.admonition-note {
  border-left-color: #0969da;
  background: #eff6ff;
}
.admonition-note .admonition-title { color: #0969da; }

.admonition-tip {
  border-left-color: #1a7f37;
  background: #edfdf3;
}
.admonition-tip .admonition-title { color: #1a7f37; }

.admonition-important {
  border-left-color: #8250df;
  background: #f6f0ff;
}
.admonition-important .admonition-title { color: #8250df; }

.admonition-warning {
  border-left-color: #9a6700;
  background: #fff8e6;
}
.admonition-warning .admonition-title { color: #9a6700; }

.admonition-caution {
  border-left-color: #cf222e;
  background: #fff2f2;
}
.admonition-caution .admonition-title { color: #cf222e; }

@media print {
  .admonition {
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
}


/* ══════════════════════════════════════════════════════════════
   FOOTNOTES
   ══════════════════════════════════════════════════════════════ */

.footnote-ref {
  font-size: 0.7em;
  line-height: 0;
}

.footnote-ref a,
.footnote-backref {
  text-decoration: none;
  color: #0f3460;
}

.footnotes {
  margin-top: 3em;
  padding-top: 0.8em;
  font-size: 0.88em;
  color: #444;
  page-break-inside: auto;
}

.footnotes-sep {
  border-top: 1px solid #d0d7de;
  width: 30%;
  margin-bottom: 1em;
}

.footnotes ol {
  padding-left: 1.4em;
  margin: 0;
}

.footnotes li {
  margin: 0.4em 0;
}

.footnotes li p {
  display: inline;
  text-align: left;
}

.footnote-backref {
  margin-left: 0.3em;
  color: #57606a;
}

/* Paged.js engine only: float: footnote is the CSS Fragmentation proposal
   Paged.js implements — it physically relocates this element to the
   bottom of whatever page it was referenced on and auto-numbers it via
   ::footnote-call (the inline superscript mark) / ::footnote-marker (the
   note's own leading number). Inert under the default Chromium engine —
   renderFootnoteRefs() only ever emits a .footnote span when the
   pagedjs engine is active, so this never applies to the chromium path's
   .footnote-ref/.footnotes markup above. */
.footnote {
  float: footnote;
  font-size: 0.9em;
}

::footnote-marker {
  content: counter(footnote-marker) ". ";
  font-weight: 600;
}

::footnote-call {
  content: counter(footnote);
  vertical-align: super;
  font-size: 0.7em;
  line-height: 0;
  color: #0f3460;
}


/* ══════════════════════════════════════════════════════════════
   FIGURES & IMAGES
   ══════════════════════════════════════════════════════════════ */

.book-figure {
  margin: 1.5em auto;
  text-align: center;
  page-break-inside: avoid;
}

.book-figure img {
  max-width: 100%;
  height: auto;
  border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
}

.book-figure figcaption {
  margin-top: 0.5em;
  font-size: 0.88em;
  color: #666;
  font-style: italic;
}


/* ══════════════════════════════════════════════════════════════
   MERMAID DIAGRAMS
   ══════════════════════════════════════════════════════════════ */

.mermaid {
  text-align: center;
  margin: 1.5em 0;
  page-break-inside: avoid;
  background: white;
  overflow: visible;
  page-break-inside: avoid !important; /* Keep the graph intact if possible */
  break-inside: avoid !important;
  display: block !important; /* Do not use flex/inline-block */
}

.mermaid svg {
  max-width: 100%;
  height: auto !important;
  page-break-inside: auto !important;
  break-inside: auto !important;
}

@media print {
  /* Force ALL structural ancestors to abandon flex/grid layout */
  body, 
  main, 
  article, 
  .content-wrapper, 
  div:has(> .mermaid) {
    display: block !important;
    float: none !important;
    position: static !important;
  }
}

/* ══════════════════════════════════════════════════════════════
   KATEX MATH
   ══════════════════════════════════════════════════════════════ */

/* ---------- KaTeX Placeholders ---------- */

[data-math],
[data-math-display] {
  /* placeholders are replaced by KaTeX render */
  display: block;
}

/* ---------- Display Math ---------- */

.katex-display {
  margin: 1.2em 0;

  overflow-x: auto;
  overflow-y: visible;

  padding: 0.25em 0;

  page-break-inside: avoid;

  -webkit-overflow-scrolling: touch;
}

/* Prevent overflow clipping in PDF/print */
.katex-display > .katex {
  white-space: normal;
}

/* ---------- Inline + Display KaTeX ---------- */

.katex {
  font-size: 1.05em;
  line-height: 1.4;
}

/* ---------- Error fallback ---------- */

.katex-error {
  color: #c0392b;
  font-family: monospace;
  font-size: 0.9em;

  background: #fff5f5;
  border: 1px solid #fed7d7;
  padding: 0.2em 0.4em;
  border-radius: 4px;
}

/* ---------- Print / PDF Safety ---------- */

@media print {
  .katex-display {
    overflow: visible !important;
  }

  .katex {
    white-space: normal !important;
  }
}

/* ══════════════════════════════════════════════════════════════
   DEFINITION LISTS
   ══════════════════════════════════════════════════════════════ */

dl { margin: 0.8em 0; }

dt {
  font-weight: 700;
  color: #1a1a2e;
  margin-top: 0.6em;
}

dd {
  margin-left: 1.5em;
  color: #444;
}


/* ══════════════════════════════════════════════════════════════
   PRINT OVERRIDES
   ══════════════════════════════════════════════════════════════ */

@media print {
  .cover-page:not(.cover-page-image) {
    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%) !important;
  }

  thead {
    background: #1a1a2e !important;
  }

  .code-lang {
    background: #2d3748 !important;
  }

  h1, h2, h3, h4, h5, h6 {
    page-break-after: avoid;
  }

  pre, blockquote, table, figure {
    page-break-inside: avoid;
  }
}

${engine === 'pagedjs' ? `
/* ══════════════════════════════════════════════════════════════
   PAGED.JS ENGINE OVERRIDES
   ══════════════════════════════════════════════════════════════ */

/* Paged.js lays out fixed-size physical page boxes rather than a
   scrolling viewport, so 100vh (which assumes a browser viewport) doesn't
   describe "one page" the way it does under the Chromium engine. */
.cover-page, .toc-page {
  height: auto;
  min-height: 100%;
}
` : ''}
</style>
</head>
<body>

${coverHtml}
${standaloneTocPage}

<main class="book-content">
${bodyHtml}
</main>

<!--
  KaTeX runtime — vendored and inlined synchronously so it is available
  when the inline script below runs (no CDN round-trip needed).
-->
<script>${katexJs}</script>

<script>
// ─── 1. Render KaTeX math placeholders synchronously ─────────────────────────
//
// We placed <span data-math="base64tex"> and <div data-math-display="base64tex">
// in the HTML during preprocessing (in Node, before marked ran).
// Now we decode each one and call katex.renderToString() directly.
// This is synchronous — no timers, no deferred scripts, no race conditions.

(function renderKatexPlaceholders() {
  // Inline math: <span data-math="base64">
  document.querySelectorAll('[data-math]').forEach(function (el) {
    var encoded = el.getAttribute('data-math');
    var tex = atob(encoded);
    try {
      el.outerHTML = katex.renderToString(tex, {
        throwOnError: false,
        displayMode:  false,
        output:       'html',
      });
    } catch (err) {
      el.innerHTML = '<span class="katex-error" title="' + tex + '">' + tex + '</span>';
    }
  });

  // Display math: <div data-math-display="base64">
  document.querySelectorAll('[data-math-display]').forEach(function (el) {
    var encoded = el.getAttribute('data-math-display');
    var tex = atob(encoded);
    try {
      el.outerHTML = katex.renderToString(tex, {
        throwOnError: false,
        displayMode:  true,
        output:       'html',
      });
    } catch (err) {
      el.innerHTML = '<span class="katex-error" title="' + tex + '">' + tex + '</span>';
    }
  });
})();


// ─── 2. Initialize and run Mermaid ───────────────────────────────────────────
//
// v11 API: initialize() then run().
// startOnLoad: false — we call run() ourselves after the DOM is stable.
// securityLevel: 'loose' — allows HTML in labels (needed by some diagram types).
// errorRenderer: 'console' — logs parse errors instead of crashing the page.

mermaid.initialize({
  startOnLoad:    false,
  theme:          'default',
  securityLevel:  'loose',
  fontFamily:     'Georgia, "Times New Roman", serif',
  logLevel:       'error',
  flowchart:      { useMaxWidth: true, htmlLabels: true },
  sequence:       { useMaxWidth: true },
  gantt:          { useMaxWidth: true },
});

// Run mermaid on all .mermaid divs
(async function runMermaid() {
  var diagrams = Array.from(document.querySelectorAll('.mermaid'));
  if (diagrams.length === 0) return;

  try {
    await mermaid.run({ nodes: diagrams });
  } catch (globalErr) {
    // If the batch run fails, try each diagram individually so one
    // bad diagram does not block all others.
    for (var i = 0; i < diagrams.length; i++) {
      try {
        await mermaid.run({ nodes: [diagrams[i]] });
      } catch (err) {
        var src = diagrams[i].textContent.trim().slice(0, 80);
        diagrams[i].innerHTML =
          '<pre style="color:#c0392b;font-size:0.8em;border:1px solid #c0392b;' +
          'padding:0.5em;border-radius:4px;">' +
          'Mermaid parse error:\\n' + err.message + '\\n\\nSource:\\n' + src + '...</pre>';
      }
    }
  }
})();
</script>

</body>
</html>`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export {
  buildBookHtml,
  markdownToHtml,
  parseFrontMatter,
  buildToc,
  extractHeadings,
  preprocessLatex,
  preprocessMermaid,
  preprocessPageBreaks,
  applyChapterBreaks,
  applyChapterNumbers,
  injectChapterTitleAttr,
  dedupeHeadingIds,
  resolveImagePaths,
  preprocessFootnotes,
  renderFootnoteRefs,
  buildFootnotesHtml,
  fileToDataUri,
};