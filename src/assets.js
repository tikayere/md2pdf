'use strict';

/**
 * assets.js
 *
 * Loads the browser-side libraries (KaTeX, Mermaid, highlight.js themes)
 * from disk and hands back strings to inline directly into the generated
 * HTML, instead of pulling them from a CDN at render time.
 *
 * Why: renderer.js renders via Puppeteer's page.setContent(), which never
 * touches the network unless the HTML tells it to. CDN <script>/<link> tags
 * meant every single PDF build required internet access, was
 * non-reproducible (a CDN can start serving a different file at any time),
 * and silently failed in offline/CI/airgapped environments. `vendor/`
 * contains the exact pinned-version files we used to fetch from jsdelivr
 * (KaTeX 0.16.11, Mermaid 11.4.1) — same versions, zero behavior change,
 * just no network dependency. highlight.js themes are already an npm
 * dependency of this project, so they're read straight from node_modules.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require   = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = path.resolve(__dirname, '..', 'vendor');

// ─── KaTeX ────────────────────────────────────────────────────────────────

const katexJs = fs.readFileSync(path.join(VENDOR_DIR, 'katex', 'katex.min.js'), 'utf8');

const katexCss = inlineKatexFonts(
  fs.readFileSync(path.join(VENDOR_DIR, 'katex', 'katex.min.css'), 'utf8')
);

/**
 * KaTeX's CSS ships @font-face rules with three fallback formats
 * (woff2, woff, truetype). We only vendor the woff2 files — every browser
 * Puppeteer runs on supports it — so we drop the woff/truetype fallback
 * sources (we don't have those files) and inline the woff2 file as a
 * base64 data: URI so no font ever needs to be fetched separately.
 */
function inlineKatexFonts(css) {
  const fontsDir = path.join(VENDOR_DIR, 'katex', 'fonts');

  return css
    .replace(/,url\(fonts\/[^)]+?\.(?:woff|ttf)\)\s*format\((?:'|")[^'")]+(?:'|")\)/g, '')
    .replace(/url\(fonts\/([^)]+?\.woff2)\)/g, (_match, fileName) => {
      const data = fs.readFileSync(path.join(fontsDir, fileName)).toString('base64');
      return `url(data:font/woff2;base64,${data})`;
    });
}

// ─── Mermaid ──────────────────────────────────────────────────────────────

const mermaidJs = fs.readFileSync(path.join(VENDOR_DIR, 'mermaid', 'mermaid.min.js'), 'utf8');

// ─── Paged.js ─────────────────────────────────────────────────────────────
//
// Optional pagination engine (see renderer.js) that replaces Chromium's
// native print pagination with a JS-driven one, unlocking running headers
// (string-set/string()) and real per-page footnotes (float: footnote) that
// Chromium's print engine has no equivalent for.

const pagedJs = fs.readFileSync(path.join(VENDOR_DIR, 'pagedjs', 'paged.polyfill.js'), 'utf8');

// ─── highlight.js themes ────────────────────────────────────────────────────

const hljsStylesDir = path.dirname(require.resolve('highlight.js/styles/github.css'));

function getHljsThemeCss(themeName) {
  const file = path.join(hljsStylesDir, `${themeName}.min.css`);
  return fs.readFileSync(file, 'utf8');
}

/**
 * Whether `themeName` matches one of the ~80 themes shipped in
 * highlight.js/styles (not just the two — github/github-dark — this tool
 * used to hardcode as the only legal choices). Used by converter.js to
 * fail fast with a clear error instead of silently falling back.
 */
function hljsThemeExists(themeName) {
  return typeof themeName === 'string' && fs.existsSync(path.join(hljsStylesDir, `${themeName}.min.css`));
}

/** All theme names available to `style.highlight_theme` / `--highlight-theme`. */
function listHljsThemes() {
  return fs.readdirSync(hljsStylesDir)
    .filter((f) => f.endsWith('.min.css'))
    .map((f) => f.replace(/\.min\.css$/, ''))
    .sort();
}

export { katexJs, katexCss, mermaidJs, pagedJs, getHljsThemeCss, hljsThemeExists, listHljsThemes };
