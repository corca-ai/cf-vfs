# Remote workspace shell

You have a remote workspace machine. Run shell commands on it by sending HTTP
requests; treat it as your filesystem for the task.

Two environment variables are set for you:

- `WORKSPACE_URL`, for example `https://eval.vfs.borca.ai/api/instances/<id>`;
- `WORKSPACE_TOKEN`, the bearer token for that URL.

## Running a script

`POST $WORKSPACE_URL/exec` with a JSON body `{"script": "..."}`. The script is
bash source and may span several lines. Build the body with `jq` so quoting
stays correct:

```sh
jq -n --arg script 'cd notes && grep -rn "TODO" .' '{script: $script}' |
  curl -sS -X POST "$WORKSPACE_URL/exec" \
    -H "Authorization: Bearer $WORKSPACE_TOKEN" \
    -H "Content-Type: application/json" \
    --data-binary @- |
  jq -j '.stdout, .stderr, "[exit \(.exitCode) in \(.cwd)]\n"'
```

A small helper that reads the script from standard input:

```sh
ws() {
  jq -Rs '{script: .}' |
    curl -sS -X POST "$WORKSPACE_URL/exec" \
      -H "Authorization: Bearer $WORKSPACE_TOKEN" \
      -H "Content-Type: application/json" \
      --data-binary @- |
    jq -j 'if .error then "error: \(.error)\n" else .stdout, .stderr, "[exit \(.exitCode) in \(.cwd)]\n" end'
}

ws <<'EOF'
mkdir -p drafts
printf '%s\n' '# Plan' '' '- first item' > drafts/plan.md
cat drafts/plan.md
EOF
```

The response is a JSON object:

| Field | Meaning |
| --- | --- |
| `stdout`, `stderr` | Complete output of the script. |
| `exitCode` | Exit status of the script. |
| `cwd` | Working directory after the script. |

A request the server cannot run returns a 4xx or 5xx status with
`{"error": "..."}`.

## How the shell behaves

- Each request runs in a new non-interactive shell. The working directory
  carries over to the next request; variables, functions, aliases and `set`
  options do not.
- You are `user` with home `/home/user`. Work starts in `/workspace`.
- The machine has no network access. Fetch anything you need locally and write
  it with a script, for example through a quoted heredoc.
- A script that runs too long or produces too much output is stopped; split
  large jobs into several requests.
