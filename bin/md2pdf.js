#!/usr/bin/env node
'use strict';

/**
 * bin/md2pdf.js — CLI entry point
 *
 * Two modes:
 *
 *   1. YAML config mode (preferred):
 *        md2pdf-book book.yaml
 *        md2pdf-book book.yaml -o custom-output.pdf -v
 *
 *   2. Legacy file-list mode:
 *        md2pdf-book intro.md ch1.md ch2.md -o book.pdf --title "My Book"
 *        md2pdf-book "docs/*.md" -o docs.pdf
 *
 * When the first argument ends with .yaml or .yml the tool switches to
 * config mode automatically. All other CLI flags still apply as overrides.
 */

import chalk   from 'chalk';
import { program } from 'commander';
import { glob }    from 'glob';
import path        from 'path';
import fs          from 'fs';

import { convertToPdf, convertFromConfig } from '../src/index.js';
import { generateExampleConfig, loadConfig } from '../src/config.js';
import { lintBook }                        from '../src/lint.js';

import pkg from '../package.json' with { type: 'json' };

// ─── CLI definition ───────────────────────────────────────────────────────────

program
  .name('md2pdf-book')
  .description(
    'Professional Markdown → PDF book converter\n' +
    'Supports YAML config files, LaTeX math, Mermaid diagrams, TOC, syntax highlighting.'
  )
  .version(pkg.version)
  .argument('<files...>',
    'book.yaml config file  OR  one or more .md files / glob patterns')

  // Output
  .option('-o, --output <path>',       'Output PDF path (overrides config)',  '')

  // Book metadata (legacy / override)
  .option('-t, --title <title>',       'Book title',                          '')
  .option('-a, --author <author>',     'Author name',                         '')
  .option('-d, --date <date>',         'Publication date',                    '')

  // Layout
  .option('--page-size <size>',        'Page size: A4 | A3 | Letter | Legal', '')
  .option('--orientation <dir>',       'portrait | landscape',                '')
  .option('--font-size <size>',        'Base font size (e.g. 11pt)',           '')
  .option('--line-height <height>',    'Line height (e.g. 1.6)',               '')
  .option('--engine <engine>',         'chromium (fast) | pagedjs (running chapter headers + real per-page footnotes)', '')
  .option('--margin-top <m>',          'Top margin',                          '')
  .option('--margin-bottom <m>',       'Bottom margin',                       '')
  .option('--margin-left <m>',         'Left margin (inner)',                 '')
  .option('--margin-right <m>',        'Right margin (outer)',                '')

  // Features
  .option('--no-cover',                'Skip cover page')
  .option('--no-toc',                  'Skip table of contents')
  .option('--toc-depth <n>',           'Only list headings up to this level (1-6) in the TOC', '')
  .option('--no-page-numbers',         'Skip page numbers')
  .option('--no-chapter-breaks',       'No page break between chapters')
  .option('--chapter-numbers',         'Prefix chapter headings with "Chapter N"', false)

  // Style
  .option('--highlight-theme <theme>', 'Any highlight.js theme: github, github-dark, monokai, nord, atom-one-dark, ...', '')
  .option('--header-text <text>',      'Running header text',                 '')
  .option('--footer-text <text>',      'Running footer text',                 '')
  .option('--cover-image <path>',      'Image to use as the cover background', '')
  .option('--css <path>',              'Extra CSS file appended after the built-in stylesheet', '')
  .option('--timeout <m>', 'timeout', '')
  .option('--chrome-path <path>',      'Explicit Chrome/Chromium executable to launch (also: PUPPETEER_EXECUTABLE_PATH)', '')

  // Misc
  .option('--sort',                    'Sort input files alphabetically',     false)
  .option('--save-html <path>',        'Save intermediate HTML for debugging','')
  .option('--init',                    'Generate a starter book.yaml and exit')
  .option('--lint',                    'Validate the book without rendering a PDF')
  .option('-v, --verbose',             'Verbose output',                      false)
  .option('-q, --quiet',               'Suppress progress output (still prints the final result or an error)', false)

  .addHelpText('after', `
Examples:
  # Recommended: use a YAML config
  md2pdf-book book.yaml
  md2pdf-book book.yaml -o custom.pdf -v

  # Generate a starter config
  md2pdf-book --init

  # Validate without rendering (missing images, dangling footnotes, duplicate heading ids)
  md2pdf-book book.yaml --lint

  # Running chapter-title headers + real per-page footnotes (slower)
  md2pdf-book book.yaml --engine pagedjs

  # Single file
  md2pdf-book README.md -o readme.pdf

  # Multiple files with options
  md2pdf-book intro.md ch1.md ch2.md -o mybook.pdf --title "My Book" --author "Jane"

  # Glob pattern
  md2pdf-book "docs/*.md" -o docs.pdf --sort

  # Dark code theme + save HTML for debugging
  md2pdf-book guide.md -o guide.pdf --highlight-theme github-dark --save-html debug.html

  # Custom CSS on top of the built-in stylesheet
  md2pdf-book book.yaml --css my-overrides.css

  # Shallower TOC (only H1/H2) + quiet output for CI/scripting
  md2pdf-book book.yaml --toc-depth 2 --quiet

  # Point at a specific Chrome install (e.g. when the bundled one won't launch)
  md2pdf-book book.yaml --chrome-path /usr/bin/google-chrome-stable
`);

program.parse();

const opts = program.opts();
const args = program.args;

// ─── Main ─────────────────────────────────────────────────────────────────────

(async () => {

  // ── --init flag ──
  if (opts.init) {
    const dest = path.resolve('book.yaml');
    if (fs.existsSync(dest)) {
      console.error(chalk.red(`  ✖  book.yaml already exists. Remove it first.`));
      process.exit(1);
    }
    fs.writeFileSync(dest, generateExampleConfig(), 'utf8');
    console.log(chalk.green(`  ✅ Created book.yaml — edit it and run: md2pdf-book book.yaml`));
    process.exit(0);
  }

  if (!opts.quiet) printBanner(pkg.version);

  const firstArg = args[0] ?? '';
  const isConfig = /\.(ya?ml)$/i.test(firstArg);

  // ── Detect mode ──
  if (opts.lint) {
    await runLintMode(isConfig, firstArg, args, opts);
  } else if (isConfig) {
    await runConfigMode(firstArg, opts);
  } else {
    await runFileMode(args, opts);
  }

})();

// ─── Lint mode ────────────────────────────────────────────────────────────────

async function runLintMode(isConfig, configPath, args, opts) {
  let files;

  try {
    if (isConfig) {
      if (!opts.quiet) console.log(chalk.cyan(`  📋 Config: `) + configPath);
      ({ files } = loadConfig(configPath));
    } else {
      files = await resolveFileArgs(args, opts);
    }
  } catch (err) {
    printError(err, opts.verbose);
    process.exit(1);
  }

  if (!opts.quiet) {
    console.log(chalk.yellow(`  🔍 Linting ${files.length} file${files.length > 1 ? 's' : ''}...\n`));
  }

  const issues = lintBook(files);
  printLintReport(issues);
  process.exit(issues.length > 0 ? 1 : 0);
}

// ─── Config mode ─────────────────────────────────────────────────────────────

async function runConfigMode(configPath, opts) {
  if (!opts.quiet) console.log(chalk.cyan(`  📋 Config: `) + configPath);

  // Build CLI overrides — only pass values the user explicitly set
  const overrides = buildOverrides(opts);

  try {
    const start = Date.now();

    if (!opts.quiet) process.stdout.write(chalk.yellow('  ⏳ Rendering PDF...\n'));

    const { outputPath, fileCount } = await convertFromConfig(configPath, overrides);

    printSuccess(outputPath, fileCount, start, opts.quiet);

  } catch (err) {
    printError(err, opts.verbose);
    process.exit(1);
  }
}

// ─── File-list mode ───────────────────────────────────────────────────────────

async function resolveFileArgs(args, opts) {
  let resolvedFiles = [];

  for (const pattern of args) {
    if (pattern.includes('*') || pattern.includes('?')) {
      const matched = await glob(pattern, { nodir: true });
      if (matched.length === 0) {
        console.warn(chalk.yellow(`  ⚠  No files matched: ${pattern}`));
      }
      resolvedFiles.push(...matched.map((f) => path.resolve(f)));
    } else {
      resolvedFiles.push(path.resolve(pattern));
    }
  }

  resolvedFiles = [...new Set(resolvedFiles)];
  if (opts.sort) resolvedFiles.sort();

  if (resolvedFiles.length === 0) {
    console.error(chalk.red('  ✖  No input files found.'));
    process.exit(1);
  }

  return resolvedFiles;
}

async function runFileMode(args, opts) {
  const resolvedFiles = await resolveFileArgs(args, opts);

  if (!opts.quiet) printFileList(resolvedFiles, opts);

  const outputPath = path.resolve(opts.output || 'book.pdf');
  const options    = buildOptions(opts);

  try {
    const start = Date.now();
    if (!opts.quiet) process.stdout.write(chalk.yellow('  ⏳ Rendering PDF...\n'));

    await convertToPdf(resolvedFiles, outputPath, options);

    printSuccess(outputPath, resolvedFiles.length, start, opts.quiet);

  } catch (err) {
    printError(err, opts.verbose);
    process.exit(1);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildOverrides(opts) {
  const out = {};

  if (opts.output)          out.output        = opts.output;
  if (opts.title)           out.title         = opts.title;
  if (opts.author)          out.author        = opts.author;
  if (opts.date)            out.date          = opts.date;
  if (opts.pageSize)        out.pageSize      = opts.pageSize;
  if (opts.orientation)     out.orientation   = opts.orientation;
  if (opts.fontSize)        out.fontSize      = opts.fontSize;
  if (opts.lineHeight)      out.lineHeight    = opts.lineHeight;
  if (opts.engine)          out.engine        = opts.engine;
  if (opts.highlightTheme)  out.highlightTheme = opts.highlightTheme;
  if (opts.headerText)      out.headerText    = opts.headerText;
  if (opts.footerText)      out.footerText    = opts.footerText;
  if (opts.coverImage)      out.coverImage    = path.resolve(opts.coverImage);
  if (opts.css)             out.customCssPath = path.resolve(opts.css);
  if (opts.tocDepth)        out.tocDepth      = parseInt(opts.tocDepth, 10);
  if (opts.chromePath)      out.chromePath    = opts.chromePath;
  if (opts.saveHtml)        out.saveHtml      = opts.saveHtml;
  if (opts.verbose)         out.verbose       = opts.verbose;

  // Boolean flags — only override if explicitly passed
  if (opts.cover === false)          out.coverPage      = false;
  if (opts.toc === false)            out.showToc        = false;
  if (opts.pageNumbers === false)    out.pageNumbers    = false;
  if (opts.chapterBreaks === false)  out.chapterBreaks  = false;
  if (opts.chapterNumbers)           out.chapterNumbers = true;

  const hasMarginFlag = opts.marginTop || opts.marginBottom || opts.marginLeft || opts.marginRight;
  if (hasMarginFlag) {
    out.margins = {
      top:    opts.marginTop    || '2.5cm',
      bottom: opts.marginBottom || '2.5cm',
      left:   opts.marginLeft   || '3cm',
      right:  opts.marginRight  || '2.5cm',
    };
  }

  return out;
}

function buildOptions(opts) {
  return {
    title:          opts.title          || 'My Book',
    author:         opts.author         || '',
    date:           opts.date           || new Date().toLocaleDateString(),
    pageSize:       opts.pageSize       || 'A4',
    orientation:    opts.orientation    || 'portrait',
    fontSize:       opts.fontSize       || '11pt',
    lineHeight:     opts.lineHeight     || '1.6',
    engine:         opts.engine         || 'chromium',
    highlightTheme: opts.highlightTheme || 'github',
    headerText:     opts.headerText     || '',
    footerText:     opts.footerText     || '',
    coverImage:     opts.coverImage     ? path.resolve(opts.coverImage) : null,
    customCssPath:  opts.css            ? path.resolve(opts.css) : null,
    tocDepth:       opts.tocDepth       ? parseInt(opts.tocDepth, 10) : 6,
    chromePath:     opts.chromePath     || null,
    saveHtml:       opts.saveHtml       || null,
    verbose:        opts.verbose        || false,
    coverPage:      opts.cover !== false,
    showToc:        opts.toc   !== false,
    pageNumbers:    opts.pageNumbers !== false,
    chapterBreaks:  opts.chapterBreaks !== false,
    chapterNumbers: opts.chapterNumbers || false,
    margins: {
      top:    opts.marginTop    || '2.5cm',
      bottom: opts.marginBottom || '2.5cm',
      left:   opts.marginLeft   || '3cm',
      right:  opts.marginRight  || '2.5cm',
    },
  };
}

function printBanner(version) {
  console.log(chalk.blue('\n📚 md2pdf-book') + chalk.gray(` v${version}`));
  console.log(chalk.gray('─'.repeat(50)));
}

function printFileList(files, opts) {
  console.log(chalk.cyan(`  📄 Input (${files.length} file${files.length > 1 ? 's' : ''}):`));
  files.forEach((f, i) => {
    console.log(chalk.gray(`     ${i + 1}. ${path.basename(f)}`));
  });
  if (opts.title)  console.log(chalk.cyan('  📖 Title:  ') + opts.title);
  if (opts.author) console.log(chalk.cyan('  ✍  Author: ') + opts.author);
  console.log('');
}

function printSuccess(outputPath, fileCount, startMs, quiet = false) {
  // --quiet still needs to say *something* — a script piping this output
  // needs the resulting path — but skips the timing/decoration around it.
  if (quiet) {
    console.log(outputPath);
    return;
  }

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  let size = '?';
  try {
    size = (fs.statSync(outputPath).size / 1024).toFixed(1);
  } catch { /* output path may not exist in dry runs */ }

  console.log('');
  console.log(chalk.green(`  ✅ Done in ${elapsed}s`));
  console.log(chalk.green(`  📦 Output: ${outputPath} (${size} KB)`));
  console.log(chalk.gray(`  📄 Pages compiled: ${fileCount}`));
  console.log('');
}

function printError(err, verbose) {
  console.error(chalk.red('\n  ✖  Error: ') + err.message);
  if (verbose && err.stack) {
    console.error(chalk.gray(err.stack));
  }
}

const LINT_LABELS = {
  'missing-image':       'Missing image',
  'unresolved-footnote': 'Unresolved footnote',
  'duplicate-heading-id': 'Duplicate heading id',
};

function printLintReport(issues) {
  if (issues.length === 0) {
    console.log(chalk.green('  ✅ No issues found.\n'));
    return;
  }

  for (const issue of issues) {
    const label = LINT_LABELS[issue.type] || issue.type;
    console.log(chalk.yellow(`  ⚠  [${label}] `) + chalk.gray(issue.file));
    console.log(`     ${issue.detail}`);
  }

  console.log('');
  console.log(chalk.red(`  ✖  ${issues.length} issue${issues.length > 1 ? 's' : ''} found.`));
  console.log('');
}