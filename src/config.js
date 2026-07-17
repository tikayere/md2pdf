'use strict';

/**
 * config.js
 *
 * Loads and validates a YAML book configuration file.
 *
 * Supported schema (book.yaml):
 *
 *   title:        "My Book"
 *   author:       "Jane Smith"
 *   date:         "2024-01-01"          # defaults to today
 *   output:       "build/book.pdf"      # default: book.pdf
 *
 *   pages:                              # ordered list of markdown files
 *     - docs/intro.md
 *     - docs/chapter1.md
 *     - docs/chapter2.md
 *     # OR with per-page overrides:
 *     - file: docs/chapter1.md
 *       title: "Chapter 1 Override"     # not yet used by renderer, reserved
 *
 *   layout:
 *     page_size:   A4                   # A4 | A3 | Letter | Legal
 *     orientation: portrait             # portrait | landscape
 *     font_size:   11pt
 *     line_height: "1.6"
 *     engine:      chromium             # chromium | pagedjs — pagedjs trades
 *                                        # render speed for a running header
 *                                        # that tracks the current chapter
 *                                        # title and footnotes that render at
 *                                        # the bottom of the page they're
 *                                        # referenced on (chromium's print
 *                                        # engine can't do either)
 *     margins:
 *       top:    2.5cm
 *       bottom: 2.5cm
 *       left:   3cm
 *       right:  2.5cm
 *
 *   features:
 *     cover:          true
 *     toc:            true
 *     page_numbers:   true
 *     chapter_breaks: true      # page break before every top-level (H1) heading —
 *                                # a single markdown file may contain multiple H1
 *                                # chapters, each starting on its own page. For a
 *                                # mid-chapter break, put a lone
 *                                # `<!-- pagebreak -->` (or `\pagebreak`) line in
 *                                # the markdown.
 *
 *   style:
 *     highlight_theme: github           # github | github-dark
 *     header_text: ""
 *     footer_text: ""
 *     cover_image: null                 # path to an image (relative to this
 *                                        # config file) to use as the cover
 *                                        # background instead of the gradient
 *
 *   save_html: null                     # path to save intermediate HTML, or null
 */

import fs   from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULTS = {
  title:  'My Book',
  author: '',
  date:   new Date().toLocaleDateString(),
  output: 'book.pdf',

  layout: {
    page_size:   'A4',
    orientation: 'portrait',
    font_size:   '11pt',
    line_height: '1.6',
    engine:      'chromium', // chromium | pagedjs — see loadConfig() below
    margins: {
      top:    '2.5cm',
      bottom: '2.5cm',
      left:   '3cm',
      right:  '2.5cm',
    },
  },

  features: {
    cover:           true,
    toc:             true,
    page_numbers:    true,
    chapter_breaks:  true,
    chapter_numbers: false,
  },

  style: {
    highlight_theme: 'github',
    header_text:     '',
    footer_text:     '',
    cover_image:     null,
  },

  save_html: null,
  verbose:   false,
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Load and parse a YAML book config file.
 * Resolves all page paths relative to the config file's directory.
 *
 * @param {string} configPath - Absolute or relative path to book.yaml
 * @returns {{ files: string[], options: object, outputPath: string }}
 */
function loadConfig(configPath) {
  const absConfig = path.resolve(configPath);

  if (!fs.existsSync(absConfig)) {
    throw new Error(`Config file not found: ${absConfig}`);
  }

  const raw = fs.readFileSync(absConfig, 'utf8');
  let doc;

  try {
    doc = yaml.load(raw);
  } catch (err) {
    throw new Error(`Failed to parse YAML config: ${err.message}`);
  }

  if (!doc || typeof doc !== 'object') {
    throw new Error('Config file is empty or not a valid YAML object.');
  }

  // Validate pages section
  if (!doc.pages || !Array.isArray(doc.pages) || doc.pages.length === 0) {
    throw new Error(
      'Config must include a "pages" list with at least one markdown file.\n' +
      'Example:\n  pages:\n    - intro.md\n    - chapter1.md'
    );
  }

  const configDir = path.dirname(absConfig);

  // Resolve page paths
  const files = doc.pages.map((entry, i) => {
    const filePath = typeof entry === 'string'
      ? entry
      : entry && typeof entry.file === 'string'
        ? entry.file
        : null;

    if (!filePath) {
      throw new Error(
        `pages[${i}] is invalid. Use a string path or { file: "path.md" }.`
      );
    }

    const abs = path.resolve(configDir, filePath);

    if (!fs.existsSync(abs)) {
      throw new Error(`Page file not found: ${abs}\n  (referenced in ${absConfig})`);
    }

    return abs;
  });

  // Deep-merge config over defaults
  const layout   = deepMerge(DEFAULTS.layout,   doc.layout   || {});
  const features = deepMerge(DEFAULTS.features, doc.features || {});
  const style    = deepMerge(DEFAULTS.style,    doc.style    || {});

  const options = {
    title:         doc.title      ?? DEFAULTS.title,
    author:        doc.author     ?? DEFAULTS.author,
    date:          doc.date       ? String(doc.date) : DEFAULTS.date,

    // Layout
    pageSize:      layout.page_size,
    orientation:   layout.orientation,
    fontSize:      layout.font_size,
    lineHeight:    String(layout.line_height),
    margins:       layout.margins,
    engine:        validateEngine(layout.engine, absConfig),

    // Features
    coverPage:      features.cover,
    showToc:        features.toc,
    pageNumbers:    features.page_numbers,
    chapterBreaks:  features.chapter_breaks,
    chapterNumbers: features.chapter_numbers,

    // Style
    highlightTheme: style.highlight_theme,
    headerText:     style.header_text,
    footerText:     style.footer_text,
    coverImage:     resolveCoverImage(style.cover_image, configDir, absConfig),

    // Misc
    saveHtml: doc.save_html ?? DEFAULTS.save_html,
    verbose:  doc.verbose   ?? DEFAULTS.verbose,
  };

  const outputPath = path.resolve(
    configDir,
    doc.output ?? DEFAULTS.output
  );

  return { files, options, outputPath };
}

/**
 * Generate a starter book.yaml with comments, for --init.
 */
function generateExampleConfig(targetDir = '.') {
  return `# md2pdf-book configuration
# Run: md2pdf-book book.yaml

title:  "My Book"
author: "Your Name"
date:   "${new Date().toLocaleDateString()}"
output: "book.pdf"

# Ordered list of markdown files to include
pages:
  - intro.md
  - chapter1.md
  - chapter2.md
  # You can also use the long form:
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
  page_numbers:    true
  chapter_breaks:  true    # new page before every top-level (#) heading;
                            # use "<!-- pagebreak -->" mid-file for extra breaks
  chapter_numbers: false   # prefix each chapter heading with "Chapter N"
                            # (headings starting with "Appendix" are skipped)

style:
  highlight_theme: github   # github | github-dark
  header_text: ""
  footer_text: ""
  # cover_image: cover.jpg   # replaces the default gradient cover background

# Uncomment to save intermediate HTML for debugging:
# save_html: debug.html
`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const VALID_ENGINES = ['chromium', 'pagedjs'];

/** Validates layout.engine, since an unrecognized value would otherwise silently fall through to the chromium default. */
function validateEngine(engine, absConfig) {
  if (!VALID_ENGINES.includes(engine)) {
    throw new Error(
      `layout.engine must be one of: ${VALID_ENGINES.join(', ')} (got "${engine}")\n  (in ${absConfig})`
    );
  }
  return engine;
}

/** Resolves style.cover_image relative to the config file, validating it exists. */
function resolveCoverImage(coverImage, configDir, absConfig) {
  if (!coverImage) return null;

  const abs = path.resolve(configDir, coverImage);
  if (!fs.existsSync(abs)) {
    throw new Error(`Cover image not found: ${abs}\n  (referenced in ${absConfig})`);
  }
  return abs;
}

function deepMerge(base, override) {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (
      override[key] !== null &&
      override[key] !== undefined &&
      typeof override[key] === 'object' &&
      !Array.isArray(override[key]) &&
      typeof base[key] === 'object'
    ) {
      result[key] = deepMerge(base[key], override[key]);
    } else if (override[key] !== undefined && override[key] !== null) {
      result[key] = override[key];
    }
  }
  return result;
}

export { loadConfig, generateExampleConfig };