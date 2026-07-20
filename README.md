# cf-vfs

`cf-vfs` is a tree-shakable byte-oriented virtual filesystem and non-interactive
Bash-compatible runtime for Cloudflare Workers. One SQLite-backed Durable
Object owns a strongly consistent pathname namespace. Files up to 8 MiB can be
stored inline and read by shell utilities; large payloads live as immutable R2
objects and are intentionally opaque to the shell.

```ts
const result = await shell.executeText({
  script: `find src -name '*.ts' | sort > files.txt`,
  cwd: "/workspace",
});
```

This is an application runtime, not an operating-system shell or POSIX ABI. It
does not launch processes, mount a filesystem, or provide an interactive TTY.
The supported language is an explicit versioned subset, and every parser,
execution, stream, mutation, and storage boundary is bounded.

The pre-1.0 stream-first redesign is intentionally breaking. The old
`{ command, input }` structured executor and text/binary storage split have
been removed.

Read [docs/index.md](docs/index.md) for setup, language and command semantics,
the SQLite/R2 lifecycle, limits, benchmarks, and compatibility details.

## License

MIT
