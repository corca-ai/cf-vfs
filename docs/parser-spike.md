# Parser technology spike

Initial decision: 2026-07-20. Repeated for Bash Version 2: 2026-07-21. Reviewed
for sourced units, positional built-ins, and bounded scalar parameter
operators: 2026-07-21.
Version 2 keeps the repository's handwritten lexer/parser after adding command
substitution, here-documents, nested control structures, functions, and
arithmetic. This is a decision for the declared finite execution grammar, not
a claim that handwritten parsing is preferable for full Bash.

## Candidates

| Candidate | Evidence | Fit for Version 2 |
| --- | --- | --- |
| handwritten finite-subset parser | built `dist/shell/parser.js` is 42,177 raw bytes before minification; produces the exact execution AST, byte offsets, queued here-document bodies, and explicit unsupported-syntax errors | selected, but its maintenance advantage has narrowed |
| [`sh-syntax` 0.6.0](https://www.npmjs.com/package/sh-syntax/v/0.6.0) | mvdan/sh-based Bash parser distributed through Wasm; approximately 794 KB npm unpacked | best mature candidate; still adds Wasm initialization and requires a strict capability-validation/AST conversion pass |
| [`bash-parser` 0.5.0](https://www.npmjs.com/package/bash-parser/v/0.5.0) | version published in 2017; broad dependency graph and a full-language-shaped AST | larger legacy dependency surface; unsupported constructs still need validation |
| [`tree-sitter-bash` 0.25.1](https://www.npmjs.com/package/tree-sitter-bash/v/0.25.1) | current error-recovering editor grammar; approximately 20.3 MB npm unpacked with native/Wasm integration concerns | strong syntax-tooling choice, disproportionate for this strict Worker execution grammar |

Measurements came from `npm view` package metadata and a clean local build;
package sizes and releases can change.

## Why the small parser won

The runtime must parse the complete submitted script before any mutation,
preserve quoted and unquoted fragments for controlled expansion, report byte
locations, and reject every out-of-profile construct deterministically. A full
Bash grammar would solve recognition but not the capability decision: a second
walk would still have to reject arrays, backgrounding,
arbitrary descriptors, and error-recovered partial trees, then convert allowed
nodes into the bounded executor AST.

The selected parser recognizes only the grammar the executor can run. This
keeps the direct VFS bundle parser-free, keeps the shell bundle small, and
makes parser node/byte limits straightforward. It is tested with positive and
negative fixtures plus pinned Bash differential cases.

The `source` / `.` addition does not add grammar: it reads a bounded inline VFS
file and invokes the same complete-unit parser under cumulative byte, node, and
nesting budgets. That reuse does not change the Version 2 parser selection.
Likewise, `read -r`, `shift`, and `getopts` are ordinary argv-based built-ins;
their stream cursor and session state do not expand the grammar.

Pattern removal, replacement, and substring operators add a small
discriminated parameter-expansion AST and delimiter-aware parsing within an
already recognized `${...}` fragment. They do not add a new command-level
grammar or weaken complete-unit rejection. Nested pattern, replacement, offset,
and length words use the existing fragment parser and depth budget, so this
bounded addition does not cross a reconsideration trigger.

The main cost is maintenance: shell lexical rules interact in subtle ways. No
one should extend it with ad-hoc string splitting. Each new construct needs a
grammar/AST design, source-span tests, rejection-boundary tests, budget impact,
and differential fixtures.

## Reconsideration triggers

Repeat the spike before arrays, process substitution, extended tests, C-style
loops, or another similarly large language version.
Also repeat it if lexer/parser fixes begin dominating shell maintenance. Prefer
a mature grammar when its parser/binding can:

- run reliably in Cloudflare Workers without an outsized native/Wasm payload;
- expose stable source spans and preserve word-fragment quoting;
- disable or reliably validate error recovery before execution;
- stay out of root/VFS-only bundles; and
- beat the custom parser on maintenance risk without weakening deterministic
  rejection or shared budgets.
