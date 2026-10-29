# Agent evaluation workspaces

A separately deployed Worker, `cf-vfs-agent-eval`, that gives an agent harness
disposable cf-vfs machines over HTTP. It exists to observe how agents actually
use the filesystem and shell, how often they fail and why, and what a task
costs in SQLite work, before choosing the next optimization.

It is not part of the npm package (it lives outside `src`) and not part of the
public benchmark Worker. `bench/deploy-public.mjs` fingerprints `src`, `demo`
and the benchmark configuration; nothing here is in that set, so deploying or
exercising this Worker never changes the public benchmark build, isolates,
logs or schedule.

## Machine model

Each instance is one `EvalWorkspace` Durable Object with its own SQLite
namespace, provisioned with the Linux profile:

- the agent runs as `user` (UID/GID 1000), `HOME=/home/user`, starting in
  `/workspace`; `/tmp` and `/var/tmp` are mode `1777`;
- commands are `defaultShellCommands` plus the opt-in `awk` and `git`; there is
  no network;
- every execution runs one complete source unit with the library's default
  execution limits.

Between executions only the working directory persists, which matches a typical
agent Bash tool. Variables, functions and shell options start fresh each call.
If the stored directory has been removed, the next execution starts in
`/workspace` and reports `cwdReset: true`.

Nothing an agent can observe names the harness. Whether an agent nevertheless
notices that it is not on Linux is itself something to record.

[`agent-brief.md`](agent-brief.md) is the text given to an agent: how to call
`exec` with `curl`, given `WORKSPACE_URL` and `WORKSPACE_TOKEN`. It describes
only what a remote shell would.

## API

Every route requires `Authorization: Bearer $AGENT_EVAL_TOKEN`; anything else
returns `401`.

| Method | Path | Body / query | Result |
| --- | --- | --- | --- |
| `POST` | `/api/instances` | `{ label?, ttlSeconds?, files? }` | `201 { instance }` |
| `GET` | `/api/instances` | | `{ instances }` |
| `GET` | `/api/instances/:id` | | `{ instance, workspace }` |
| `DELETE` | `/api/instances/:id` | | `204` |
| `POST` | `/api/instances/:id/exec` | `{ script }` | `{ exitCode, stdout, stderr, cwd }` |
| `POST` | `/api/instances/:id/files` | `{ files: [{ path, content }] }` | `{ written, sql }` |
| `GET` | `/api/instances/:id/log` | `?after=0&limit=100` | `{ entries }` |

`ttlSeconds` defaults to one day (60 seconds to seven days). `files` seeds UTF-8
fixture files as the agent's account in one atomic batch, creating parents;
relative paths are under `/workspace`. One request carries at most 1,000 files
and 8 MiB, so load a large fixture in several `files` calls.

At most `AGENT_EVAL_MAX_INSTANCES` instances (default 20) may be registered,
including ones being created or deleted; creation beyond that returns `429`.

`exec` returns only what a shell shows its caller: the unit's exit status, its
complete output and the working directory afterwards. If the shell throws
instead of returning a status, `exec` answers `500 { error: "internal error" }`.
Measurements never appear in the response, because an agent reading them would
learn about the harness; they go to the execution log, which an agent is never
given.

Each log entry contains:

| Field | Meaning |
| --- | --- |
| `seq`, `at`, `script` | Position in the instance's log, start time and the submitted source. |
| `cwdBefore`, `cwdAfter`, `cwdReset` | Directories around the unit; whether it started in `/workspace` because the stored one was gone. |
| `exitCode`, `error` | The unit's status, or the exception that replaced it. |
| `stdout`, `stderr`, `stdoutBytes`, `stderrBytes` | Up to 64 KiB of each stream and its full size. |
| `failureCode`, `limits` | Present when an execution or storage limit ended the unit. |
| `commands` | Up to 500 `{ name, exitCode }` for commands that returned a status. |
| `sql`, `mutations` | Statements, rows read and rows written by the filesystem; committed namespace changes. |
| `shellMs` | Shell-reported time. A Durable Object's clock advances only across I/O, so it can read 0. |
| `workerMs` | Worker-measured time around the Durable Object call, including RPC. Recorded after the response, so briefly `null`. |

The log supports replaying each execution against a real shell and analysing
failures and cost.

## Lifecycle

`EvalRegistry` (one Durable Object) holds the instance list. It is not on the
execution path: an exec goes straight to its workspace, which stores its own
metadata and refuses work once deleted (`404`) or expired (`410`).

Registry rows and workspace storage cannot share a transaction, so each row
has a state: `creating` → `ready` → `deleting` → removed. The registry alarm
deletes expired instances and finishes any creation or deletion that a crash
left halfway; every step is idempotent. Deleting erases the workspace's
storage, after which it costs nothing.

## Known measurement gaps

- A command that fails by throwing — for example `cat` on a missing file — emits
  no `shell.command` event, so it is absent from `commands` and visible only
  through `exitCode` and `stderr`.
- Storage costs are SQLite statement and row counts, not billed dollars.

## Deploying

`eval/` is its own npm package so that the deployment tooling — the `cf` CLI
and the newer Wrangler it delegates bundling to — never touches the root
lockfile, which the public benchmark fingerprint includes. Deploy with `cf`
from `cloudflare.config.ts`; `wrangler.jsonc` describes the same Worker for the
Workers Vitest pool and `wrangler types`, so change both together.

```sh
npm --prefix eval ci
npm run deploy:eval
```

`deploy:eval` uploads `AGENT_EVAL_TOKEN` from `eval/.secrets.json`
(`{"AGENT_EVAL_TOKEN": "..."}`), which is git-ignored and must stay out of logs
and transcripts; a harness reads the token from that file. `cf` must be
authenticated (`cf auth whoami`).

The route is the `eval.vfs.borca.ai` custom domain. Finish deployment and
logging configuration before a measurement cohort, and do not attach
`wrangler tail` or dashboard live logs while one runs.

## Local development

```sh
npm run typegen:eval
npm run test:eval
```
