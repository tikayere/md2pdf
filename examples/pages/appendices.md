# Appendix A: Configuration Reference

Appendices are a common case for wanting several chapters in a single file
instead of one file per chapter. Each top-level (`#`) heading below starts
on its own page automatically, exactly like a chapter defined in its own
file.

| Option           | Default | Description                     |
|------------------|---------|----------------------------------|
| `page_size`      | A4      | A4, A3, Letter, or Legal          |
| `orientation`    | portrait| portrait or landscape             |
| `chapter_breaks` | true    | Page break before each H1 heading |

<!-- pagebreak -->

Need a break in the middle of a chapter without starting a new one? Drop an
`<!-- pagebreak -->` comment (or a lone `\pagebreak` line) on its own line,
as was done just above this paragraph.

# Appendix B: Glossary

**Chapter**
: A section of the book starting at a top-level (`#`) heading. Chapters no
  longer need to live in separate files — a single markdown file can define
  as many as it likes.

**Manual page break**
: An `<!-- pagebreak -->` marker used to force a new page inside a chapter.
