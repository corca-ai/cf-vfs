# cf-vfs

`cf-vfs` is a tree-shakable, application-level virtual filesystem for
Cloudflare Workers. It provides familiar POSIX-style paths and filesystem
semantics on top of Durable Object SQLite and R2 without attempting to
implement the POSIX system-call interface or support unmodified POSIX
applications.

Cloudflare Workers do not expose a persistent local filesystem. Durable
Objects and R2 provide durable storage primitives, but applications still have
to implement hierarchical paths, directories, metadata, atomic namespace
changes, concurrent-update protection, and recovery across storage services.
`cf-vfs` supplies that reusable filesystem layer: one Durable Object represents
one logical workspace, repository, or tenant; SQLite stores the namespace,
metadata, and UTF-8 text; and R2 stores immutable binary bodies.

The package also provides independently importable, structured commands such
as `ls`, `cat`, `grep`, `sed`, `test`, `patch`, `sha256sum`, and bounded text
transforms. Applications select only the commands they need, and agents or
remote clients can compose them without invoking a shell.

Read [docs/index.md](docs/index.md) for installation, architecture, commands,
performance evidence, and development documentation. The
[POSIX-style compatibility profile](docs/posix-compatibility.md) defines what
the filesystem deliberately supports and omits.

## License

MIT
