# Introduction

Welcome to **The Complete Developer Guide**. This book covers mathematics, diagrams, and code examples rendered with professional typesetting.

## About This Book

This guide demonstrates the full feature set of `md2pdf-book`, including:

- LaTeX math rendering via KaTeX
- Mermaid diagram support (flowcharts, sequences, class diagrams, ERDs, state machines)
- Syntax-highlighted code blocks for JavaScript, Python, SQL, and more
- Automated table of contents with dot leaders
- Professional cover page with gradient background

## How to Read This Guide

Each chapter is self-contained and focuses on one feature area:

| Chapter      | Topic                              |
|--------------|------------------------------------|
| Introduction | Overview and structure             |
| Mathematics  | LaTeX inline and display math      |
| Diagrams     | Mermaid diagram types              |
| Code         | Syntax highlighting and tables     |

> [!NOTE]
> All code examples in this book are runnable and have been tested against the referenced library versions.

## Getting Started

To compile this book yourself, run:

```bash
md2pdf-book book.yaml
```

Or generate your own starter config with:

```bash
md2pdf-book --init
```

> [!TIP]
> Callout boxes like this one are written with GitHub-style syntax —
> `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`, or `> [!CAUTION]`
> as the first line of a blockquote.

> [!WARNING]
> Unrecognized markers, or a plain `>` quote with no marker at all, still
> render as an ordinary blockquote — nothing breaks if you mix both styles.

Footnotes are also supported using standard Pandoc-style syntax[^footnote-syntax], including inside admonitions and tables.

[^footnote-syntax]: Write `text[^id]` for the reference and `[^id]: definition` anywhere in the file — they're collected and numbered automatically at the bottom of the page.