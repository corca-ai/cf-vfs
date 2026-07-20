# Parser technology spike

Decision date: 2026-07-20. Bash Version 1 uses the repository's small
handwritten lexer/parser. This is a decision for the declared finite subset,
not a claim that handwritten parsing is preferable for full Bash.

## Candidates

| Candidate | Evidence | Fit for Version 1 |
| --- | --- | --- |
| handwritten finite-subset parser | built `dist/shell/parser.js` is 11,682 raw bytes before minification; produces the exact small AST, source byte offsets, and explicit unsupported-syntax errors required here | selected |
| [`bash-parser` 0.5.0](https://www.npmjs.com/package/bash-parser/v/0.5.0) | version published in 2017; broad dependency graph and a full-language-shaped AST | larger legacy dependency surface; unsupported constructs would still need a second validation pass |
| [`tree-sitter-bash` 0.25.1](https://www.npmjs.com/package/tree-sitter-bash/v/0.25.1) | current grammar, error recovery, approximately 20.3 MB npm unpacked package, and native build dependencies | strong editor/full-grammar choice, but disproportionate Worker packaging/runtime complexity for the finite execution grammar |

Measurements came from `npm view` package metadata and a clean local build;
package sizes and releases can change.

## Why the small parser won

The runtime must parse the complete submitted script before any mutation,
preserve quoted and unquoted fragments for controlled expansion, report byte
locations, and reject every out-of-profile construct deterministically. A full
Bash grammar would solve recognition but not the capability decision: a second
walk would still have to reject functions, substitutions, loops, arrays,
backgrounding, arbitrary descriptors, and error-recovered partial trees.

The selected parser recognizes only the grammar the executor can run. This
keeps the direct VFS bundle parser-free, keeps the shell bundle small, and
makes parser node/byte limits straightforward. It is tested with positive and
negative fixtures plus pinned Bash differential cases.

The main cost is maintenance: shell lexical rules interact in subtle ways. No
one should extend it with ad-hoc string splitting. Each new construct needs a
grammar/AST design, source-span tests, rejection-boundary tests, budget impact,
and differential fixtures.

## Reconsideration triggers

Repeat the spike before adding command substitution, here-documents, nested
control structures, functions, arithmetic, or source-file execution as a
large language version. Prefer a mature grammar when its parser/binding can:

- run reliably in Cloudflare Workers without an outsized native/Wasm payload;
- expose stable source spans and preserve word-fragment quoting;
- disable or reliably validate error recovery before execution;
- stay out of root/VFS-only bundles; and
- beat the custom parser on maintenance risk without weakening deterministic
  rejection or shared budgets.
