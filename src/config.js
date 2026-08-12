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
 *     toc_depth:      6         # only list headings up to this level (1-6)
 *                                # in the table of contents; body anchors and
 *                                # ids are unaffected either way
 *     page_numbers:   true
 *     chapter_breaks: true      # page break before every top-level (H1) heading —
 *                                # a single markdown file may contain multiple H1
 *                                # chapters, each starting on its own page. For a
 *                                # mid-chapter break, put a lone
 *                                # `<!-- pagebreak -->` (or `\pagebreak`) line in
 *                                # the markdown.
 *
 *   style:
 *     highlight_theme: github           # any highlight.js theme name — github,
 *                                        # github-dark, monokai, nord,
 *                                        # atom-one-dark, ... (~80 available)
 *     header_text: ""
 *     footer_text: ""
 *     cover_image: null                 # path to an image (relative to this
 *                                        # config file) to use as the cover
 *                                        # background instead of the gradient
 *     custom_css: null                  # path to a CSS file (relative to this
 *                                        # config file) appended after the
 *                                        # built-in stylesheet, for style
 *                                        # tweaks beyond what options expose
 *
 *   save_html: null                     # path to save intermediate HTML, or null
 *   chrome_path: null                   # explicit Chrome/Chromium executable to
 *                                        # launch, if auto-detection picks wrong
 *                                        # or the puppeteer-downloaded one won't
 *                                        # start (same as --chrome-path)
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
    toc_depth:       6,
    page_numbers:    true,
    chapter_breaks:  true,
    chapter_numbers: false,
  },

  style: {
    highlight_theme: 'github',
    header_text:     '',
    footer_text:     '',
    cover_image:     null,
    custom_css:      null,
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
    tocDepth:       validateTocDepth(features.toc_depth, absConfig),
    pageNumbers:    features.page_numbers,
    chapterBreaks:  features.chapter_breaks,
    chapterNumbers: features.chapter_numbers,

    // Style
    highlightTheme: style.highlight_theme,
    headerText:     style.header_text,
    footerText:     style.footer_text,
    coverImage:     resolveOptionalPath('Cover image', style.cover_image, configDir, absConfig),
    customCssPath:  resolveOptionalPath('Custom CSS file', style.custom_css, configDir, absConfig),

    // Misc
    saveHtml:   doc.save_html ?? DEFAULTS.save_html,
    verbose:    doc.verbose   ?? DEFAULTS.verbose,
    chromePath: doc.chrome_path ?? null,
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
  toc_depth:       6       # only list headings up to this level (1-6) in the TOC
  page_numbers:    true
  chapter_breaks:  true    # new page before every top-level (#) heading;
                            # use "<!-- pagebreak -->" mid-file for extra breaks
  chapter_numbers: false   # prefix each chapter heading with "Chapter N"
                            # (headings starting with "Appendix" are skipped)

style:
  highlight_theme: github   # any highlight.js theme: github, github-dark,
                            # monokai, nord, atom-one-dark, ...
  header_text: ""
  footer_text: ""
  # cover_image: cover.jpg   # replaces the default gradient cover background
  # custom_css: custom.css   # appended after the built-in stylesheet

# Uncomment to save intermediate HTML for debugging:
# save_html: debug.html

# Only needed if Chrome/Chromium auto-detection picks the wrong browser:
# chrome_path: /usr/bin/google-chrome-stable
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

/**
 * Resolves an optional file path (style.cover_image, style.custom_css, ...)
 * relative to the config file, validating it exists. `label` is only used
 * to make a missing-file error identify which field it came from.
 */
function resolveOptionalPath(label, relativePath, configDir, absConfig) {
  if (!relativePath) return null;

  const abs = path.resolve(configDir, relativePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`${label} not found: ${abs}\n  (referenced in ${absConfig})`);
  }
  return abs;
}

/** Validates features.toc_depth, since an out-of-range value would silently produce an empty or unfiltered TOC. */
function validateTocDepth(tocDepth, absConfig) {
  const n = Number(tocDepth);
  if (!Number.isInteger(n) || n < 1 || n > 6) {
    throw new Error(
      `features.toc_depth must be an integer between 1 and 6 (got "${tocDepth}")\n  (in ${absConfig})`
    );
  }
  return n;
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