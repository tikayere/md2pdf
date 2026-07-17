'use strict';

/**
 * index.js — Public API
 *
 * Usage:
 *
 *   import { convertToPdf, convertFromConfig } from './src/index.js';
 *
 *   // From explicit file list + options
 *   await convertToPdf(['intro.md', 'ch1.md'], 'book.pdf', { title: 'My Book' });
 *
 *   // From a book.yaml config file
 *   await convertFromConfig('book.yaml');
 */

import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';

import { buildBookHtml }         from './converter.js';
import { renderToPdf, renderToPdfBuffer } from './renderer.js';
import { loadConfig }             from './config.js';

// ─── Convert from explicit file list ─────────────────────────────────────────

/**
 * Convert one or more Markdown files into a single PDF.
 *
 * @param {string|string[]} inputFiles
 * @param {string}          outputPath
 * @param {object}          [options={}]
 * @returns {Promise<{ outputPath: string, fileCount: number }>}
 */
async function convertToPdf(inputFiles, outputPath, options = {}) {
  const files = Array.isArray(inputFiles) ? inputFiles : [inputFiles];

  files.forEach((f) => {
    if (!fs.existsSync(f)) {
      throw new Error(`File not found: ${f}`);
    }
  });

  const html = buildBookHtml(files, options);

  if (options.saveHtml) {
    fs.writeFileSync(options.saveHtml, html, 'utf8');
    if (options.verbose) {
      process.stdout.write(`  HTML saved to: ${options.saveHtml}\n`);
    }
  }

  await renderToPdf(html, outputPath, {
    pageSize:    options.pageSize    || 'A4',
    orientation: options.orientation || 'portrait',
    margins:     options.margins,
    timeout:     options.timeout,
    verbose:     options.verbose,
    engine:      options.engine      || 'chromium',
  });

  return { outputPath, fileCount: files.length };
}

/**
 * Convert a Markdown string directly to a PDF file.
 *
 * @param {string} markdownString
 * @param {string} outputPath
 * @param {object} [options={}]
 */
async function convertStringToPdf(markdownString, outputPath, options = {}) {
  const tmpFile = path.join(os.tmpdir(), `md2pdf-${Date.now()}.md`);
  fs.writeFileSync(tmpFile, markdownString, 'utf8');

  try {
    return await convertToPdf([tmpFile], outputPath, options);
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

/**
 * Convert using a YAML book config file.
 *
 * @param {string}  configPath - Path to book.yaml
 * @param {object}  [overrides={}] - CLI flags that override config values
 */
async function convertFromConfig(configPath, overrides = {}) {
  const { files, options, outputPath } = loadConfig(configPath);

  // CLI overrides win over config values
  const merged = { ...options, ...filterDefined(overrides) };
  const out    = overrides.output
    ? path.resolve(overrides.output)
    : outputPath;

  return convertToPdf(files, out, merged);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function filterDefined(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined && v !== null)
  );
}

export {
  convertToPdf,
  convertStringToPdf,
  convertFromConfig,
  buildBookHtml,
};