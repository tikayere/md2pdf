"use strict";

/**
 * renderer.js
 *
 * Renders an HTML string to a PDF using Puppeteer.
 *
 * Wait strategy (v2):
 *
 *   KaTeX  — rendered synchronously in the page's inline <script>, so it
 *             is guaranteed to be done by the time Puppeteer evaluates
 *             anything. No extra wait needed.
 *
 *   Mermaid — mermaid.run() is async. We poll for .mermaid divs to gain
 *             an SVG child (rendered) or an error child (failed), with a
 *             generous timeout and per-diagram fallback in the page script.
 *
 * KaTeX, Mermaid, and highlight.js are all vendored and inlined directly
 * into the HTML (see src/assets.js) rather than loaded from a CDN, so
 * page.setContent() below never needs network access — renders are fully
 * offline and reproducible.
 *
 * Pagination engine (options.engine):
 *
 *   'chromium' (default) — Chromium's native print pagination: @page size
 *             /margin plus page-break-before/after CSS. Simple and fast,
 *             but Chromium implements none of the CSS Paged Media margin-
 *             box spec, so running headers and per-page footnotes aren't
 *             possible this way — headerText etc. only ever produce
 *             page-break behavior, never actual margin-box content.
 *
 *   'pagedjs' — swaps in the Paged.js polyfill (vendored, see assets.js),
 *             which lays out real fixed-size page <div>s in the DOM itself
 *             and implements string-set/string() (running chapter-title
 *             headers) and float: footnote (real per-page footnotes).
 *             Must run *after* KaTeX/Mermaid have finished rendering, since
 *             Paged.js measures the already-rendered DOM to paginate it —
 *             pass it placeholder/collapsed elements and the layout is
 *             wrong. Once Paged.js has run, page.pdf() is called with
 *             preferCSSPageSize and no margin: the page boxes it produced
 *             already have the right physical size and margins baked in,
 *             so Chromium just rasterizes them as-is.
 */

import puppeteer from "puppeteer";

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Render HTML to a PDF file on disk.
 *
 * @param {string} html        - Full HTML string to render
 * @param {string} outputPath  - Destination file path (.pdf)
 * @param {object} options
 * @param {string} [options.pageSize='A4']
 * @param {string} [options.orientation='portrait']
 * @param {object} [options.margins]
 * @param {number} [options.timeout=90000]
 * @param {boolean} [options.verbose=false]
 */
async function renderToPdf(html, outputPath, options = {}) {
  const {
    pageSize = "A4",
    orientation = "portrait",
    margins = { top: "2.5cm", bottom: "2.5cm", left: "3cm", right: "2.5cm" },
    timeout = 900000,
    verbose = false,
    engine = "chromium",
  } = options;

  const browser = await launchBrowser(verbose);

  try {
    const page = await preparePage(browser, html, timeout, verbose, engine);

    await page.pdf({
      path: outputPath,
      printBackground: true,
      displayHeaderFooter: false,
      ...pdfSizeOptions(engine, pageSize, orientation, margins),
    });

    if (verbose) process.stdout.write(`  ✔ PDF saved to: ${outputPath}\n`);
  } finally {
    await browser.close();
  }
}

/**
 * Under the pagedjs engine, Paged.js has already laid out physically
 * correctly-sized page boxes (margins included) in the DOM — telling
 * Chromium to also apply a format/margin would size/margin things twice.
 * preferCSSPageSize reads the @page size we emitted in the same HTML.
 */
function pdfSizeOptions(engine, pageSize, orientation, margins) {
  if (engine === "pagedjs") {
    return { preferCSSPageSize: true };
  }
  return {
    format: pageSize,
    landscape: orientation === "landscape",
    margin: margins,
  };
}

/**
 * Render HTML to a PDF buffer (no file write).
 *
 * @param {string} html
 * @param {object} options
 * @returns {Promise<Buffer>}
 */
async function renderToPdfBuffer(html, options = {}) {
  const {
    pageSize = "A4",
    orientation = "portrait",
    margins = { top: "2.5cm", bottom: "2.5cm", left: "3cm", right: "2.5cm" },
    timeout = 9000000,
    engine = "chromium",
  } = options;

  const browser = await launchBrowser(false);

  try {
    const page = await preparePage(browser, html, timeout, false, engine);

    return await page.pdf({
      printBackground: true,
      ...pdfSizeOptions(engine, pageSize, orientation, margins),
    });
  } finally {
    await browser.close();
  }
}

// ─── Private helpers ─────────────────────────────────────────────────────────

async function launchBrowser(verbose) {
  if (verbose) process.stdout.write("  Launching Chromium...\n");

  return puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--font-render-hinting=none",
    ],
  });
}

async function preparePage(browser, html, timeout, verbose, engine = "chromium") {
  const page = await browser.newPage();
  page.setDefaultTimeout(300000);
  page.setDefaultNavigationTimeout(300000);

  // Wide viewport so diagrams are not constrained
  await page.setViewport({ width: 1400, height: 1800 });

  // Inject HTML. All assets (KaTeX, Mermaid, highlight.js) are inlined, so
  // this never touches the network — networkidle0 resolves immediately.
  if (verbose) process.stdout.write("  Loading HTML...\n");

  await page.setContent(html, {
    waitUntil: "networkidle0",
    timeout,
  });

  // KaTeX renders synchronously in the inline script — no wait needed.
  // But we confirm it ran by checking for .katex elements.
  const katexOk = await page.evaluate(() => {
    return (
      document.querySelectorAll(".katex, [data-math], [data-math-display]")
        .length >= 0
    );
  });

  if (verbose) process.stdout.write("  KaTeX: rendered synchronously ✔\n");

  // Wait for Mermaid diagrams to render.
  // Each .mermaid div gets an SVG child when done, or an error pre when failed.
  // We poll until all are resolved or we time out.
  if (verbose) process.stdout.write("  Waiting for Mermaid diagrams...\n");
  await page.evaluate(() => {
    document.querySelectorAll("details").forEach((d) => (d.open = true));
  });
  await page.addStyleTag({
    content: `
    details {
      margin-top: 10px;
      margin-bottom: 20px;
      padding: 14px;
      background: #f0fff4;
      border: 1px solid #c6f6d5;
      border-left: 6px solid #38a169;
      border-radius: 6px;
    }

    details summary {
      color: #2f855a;
      font-weight: 700;
      font-size: 0.95rem;
      margin-bottom: 8px;
    }

    details strong:first-child {
      color: #22543d;
    }
  `,
  });
  await waitForMermaid(page, timeout, verbose);

  // Give any remaining async layout (font swaps, reflows) a moment to settle
  await sleep(800);

  if (engine === "pagedjs") {
    await runPagedJs(page, verbose);
  }

  return page;
}

/**
 * Paginate the already-rendered DOM with Paged.js. Must run after KaTeX and
 * Mermaid so it measures real content (SVGs, KaTeX HTML) rather than
 * pre-render placeholders — a diagram that's still an empty div at this
 * point would get measured as zero-height and the whole page flow after it
 * would be wrong.
 *
 * window.PagedConfig = { auto: false } was set inline in the HTML (see
 * converter.js) so the polyfill didn't already try to paginate on load;
 * we trigger it ourselves here, once, with the fully-rendered body.
 */
async function runPagedJs(page, verbose) {
  if (verbose) process.stdout.write("  Paginating with Paged.js...\n");

  const { pageCount } = await page.evaluate(async () => {
    const previewer = new window.Paged.Previewer();
    const flow = await previewer.preview();
    return { pageCount: flow.total };
  });

  if (verbose) {
    process.stdout.write(`  Paged.js: ${pageCount} pages laid out ✔\n`);
  }
}

async function waitForMermaid(page, timeout, verbose) {
  const pollInterval = 300; // ms between polls
  const maxWait = Math.min(timeout * 0.6, 300000); // cap at 30s
  const deadline = Date.now() + maxWait;

  while (Date.now() < deadline) {
    const { total, done } = await page.evaluate(() => {
      const divs = Array.from(document.querySelectorAll(".mermaid"));
      const done = divs.filter(
        (d) =>
          d.querySelector("svg") !== null || d.querySelector("pre") !== null,
      ).length;
      return { total: divs.length, done };
    });

    if (total === 0) break; // no mermaid diagrams in this document

    if (verbose) {
      process.stdout.write(`  Mermaid: ${done}/${total} diagrams rendered\r`);
    }

    if (done >= total) {
      if (verbose)
        process.stdout.write(
          `  Mermaid: ${total}/${total} diagrams rendered ✔\n`,
        );
      break;
    }

    await sleep(pollInterval);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { renderToPdf, renderToPdfBuffer };
