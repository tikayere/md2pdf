'use strict';

/**
 * lint.js
 *
 * Validates a book without rendering a PDF — catches the class of problems
 * that the render pipeline handles *silently* (a broken image just doesn't
 * show up; a duplicate heading id just gets auto-renamed; an unresolved
 * footnote reference is left as literal text) so an author gets fast
 * feedback instead of having to notice it missing from a 15-second render.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  parseFrontMatter,
  preprocessLatex,
  preprocessFootnotes,
  preprocessPageBreaks,
  markdownToHtml,
  extractHeadings,
} from './converter.js';

/**
 * @param {string[]} files - absolute paths to markdown files, in book order
 * @returns {Array<{type: string, file: string, detail: string}>}
 */
function lintBook(files) {
  const issues = [];
  const seenHeadingIds = new Map(); // id -> file that first used it

  files.forEach((filePath) => {
    const raw = fs.readFileSync(filePath, 'utf8');
    const { content } = parseFrontMatter(raw);
    const baseDir = path.dirname(filePath);
    const relFile = path.relative(process.cwd(), filePath);

    const { content: withoutFootnotes } = preprocessFootnotes(preprocessLatex(content));
    const bodyHtml = markdownToHtml(preprocessPageBreaks(withoutFootnotes));

    // ── Missing local images ──
    for (const match of bodyHtml.matchAll(/<img\s[^>]*\bsrc=(["'])(.*?)\1/gi)) {
      const src = match[2];
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) continue; // http(s), data:, etc.
      const abs = path.resolve(baseDir, decodeURIComponent(src));
      if (!fs.existsSync(abs)) {
        issues.push({ type: 'missing-image', file: relFile, detail: `${src} (resolved to ${abs})` });
      }
    }

    // ── Unresolved footnote references ──
    // preprocessFootnotes() replaces every reference that has a matching
    // [^id]: definition with a <sup> link and leaves the rest as literal
    // "[^id]" text — so anything still in that shape here has no definition.
    for (const match of withoutFootnotes.matchAll(/\[\^([^\]\s]+)\]/g)) {
      issues.push({
        type: 'unresolved-footnote',
        file: relFile,
        detail: `[^${match[1]}] has no matching "[^${match[1]}]: ..." definition anywhere in the file`,
      });
    }

    // ── Duplicate heading ids across files ──
    // Each file gets its own marked() call, so marked-gfm-heading-id resets
    // per file; dedupeHeadingIds() silently renumbers collisions when the
    // book is actually built. Flag them here so an explicit `[text](#id)`
    // link the author wrote doesn't silently land on the wrong chapter.
    for (const heading of extractHeadings(bodyHtml)) {
      const firstFile = seenHeadingIds.get(heading.id);
      if (firstFile && firstFile !== relFile) {
        issues.push({
          type: 'duplicate-heading-id',
          file: relFile,
          detail: `"#${heading.id}" also used in ${firstFile} — auto-renamed in the built book; ` +
                  `an explicit link to "#${heading.id}" may land on the wrong one`,
        });
      } else if (!firstFile) {
        seenHeadingIds.set(heading.id, relFile);
      }
    }
  });

  return issues;
}

export { lintBook };
