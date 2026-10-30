# Optional awiki command

`awikiCommand` runs [awiki](https://github.com/corca-ai/awiki), the CLI for
exploring and maintaining flat-file Markdown wikis, inside the shell. It is
excluded from `defaultShellCommands`; import it from its own subpath and add
it to the registry:

```ts
import { awikiCommand } from "@corca-ai/cf-vfs/shell/commands/awiki";
import { defaultShellCommands } from "@corca-ai/cf-vfs/shell/commands/default";

const commands = [...defaultShellCommands, awikiCommand];
```

A preset that does not import it carries none of it; the tree-shaking check
asserts its absence from every other preset and records the `awiki` preset's
own bundle budget.

## Behavior

The command follows awiki 0.6.0: `lint`, `format`, `links`, `graph`, `path`,
`wanted`, `avg-shortest-path`, `suggest` and `rename`, with the same flags,
output, diagnostics and statuses, so [awiki's CLI
reference](https://github.com/corca-ai/awiki/blob/main/docs/cli.md) applies
unchanged. That includes the wiki model (flat by default, `-recursive` by
repo-relative path, Obsidian-aligned link resolution, NFC and case-insensitive
names), the link-only-line rule, and seeded sampling: `suggest` and
`avg-shortest-path` reproduce the native tool's ChaCha12 `StdRng`, so the same
`-seed` picks the same document pairs. Messages that name an operating-system
error use the native wording, such as `No such file or directory (os error
2)`. `version` prints `0.6.0`, the release it follows.

Compatibility is pinned by `test/fixtures/awiki-compat.json`, recorded from
the native binary by `npm run test:awiki-fixtures:regenerate` (set `AWIKI`
to the binary when it is not on `PATH`): flat and recursive wikis, every link
form, fences, inline code, link-only lines, front matter shapes, format,
renames, near-duplicates in Latin and Hangul text, rounding ties, flag errors,
and a generated 160-page wiki for sampling.

## Inside the VFS

The native tool reads and parses every page on every run. Here a page is
parsed once per entry identity and mutation token:

- Each run lists the wiki's directories; the listing carries every page's
  identity and token. Where no collaborative overlay can stand between a
  listing and a read (the filesystem's `copy-source` bulk hint), those tokens
  validate the cache, and the execution's credentials are checked against
  the page's and its directories' modes. Anything uncertain reads the page.
- Under an overlay, each page is asked for its current token with an empty
  read at the end of the file instead, which is also the permission check.
- A page whose token is unchanged reuses its parsed form: front matter, links,
  link-only lines, preview line and length statistics. Only changed pages are
  read and parsed again. Names, link resolution and the graph are rebuilt from
  the parsed pages on every run, because they depend on the whole wiki.
- `rename` rereads only the pages whose links name the old document, and
  `format` skips a page already known to be formatted at its current token.
- Limits never depend on the cache: a reused page still charges its bytes to
  `maxReadBytes`, as a cold read would.

The cache lives in memory per filesystem owner, holds up to 16,384 pages, and
is empty after the object restarts; the first run after that parses every
page. Change detection costs the directory listing: 37 SQL statements for
10,000 pages in eleven directories, against 10,037 when each page was read for
its token.

`suggest`'s near-duplicate section holds fingerprints within the
buffered-bytes budget instead of all at once: kept winnowed fingerprints, kept
shingle sets and each partition of the fingerprint index take a quarter of it,
and a page that does not fit is fingerprinted again where it is needed, in the
order that rehashes least. The result is the native one; with the default
16 MiB budget it is the slowest section on a large wiki, and raising
`maxBufferedBytes` makes it faster.

Measurements on the 2,000-page agent-evaluation wiki are in
[bench/awiki-2026-10-30](../bench/awiki-2026-10-30/report.md).
