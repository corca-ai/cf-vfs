# cf-vfs

`cf-vfs` is a tree-shakable virtual filesystem for Cloudflare Workers. It keeps
filesystem metadata and UTF-8 text in a SQLite-backed Durable Object and stores
immutable binary bodies in R2.

Read [docs/index.md](docs/index.md) for installation, architecture, commands,
performance evidence, and development documentation.

## License

MIT
