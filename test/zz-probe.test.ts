import { describe, expect, it } from "vitest";
import { createBashHarness } from "./helpers/bash.js";

const show = async (label: string, script: string, files?: Record<string, string>) => {
  const harness = createBashHarness();
  for (const [path, body] of Object.entries(files ?? {})) {
    await harness.fileSystem.writeFile(path, body, { createParents: true });
  }
  const result = await harness.run(script);
  console.log(
    `\n=== ${label}\n  script: ${script}\n  exit: ${result.exitCode}\n  out: ${JSON.stringify(result.stdout)}\n  err: ${JSON.stringify(result.stderr)}`,
  );
};

describe("probe", () => {
  it("device edge cases", async () => {
    await show("mkdir /dev then ls", "mkdir /dev; ls /; ls /dev; echo x > /dev/null; ls -l /dev");
    await show("real /dev/null file shadowing", "mkdir /dev; echo real > /dev/null; cat /dev/null", {});
    await show("preexisting real /dev/null", "cat /dev/null; ls -l /dev; stat -c '%F %s' /dev/null", {
      "/dev/null": "REAL CONTENT\n",
    });
    await show("cp from device", "cp /dev/null /copy; echo $?; ls /");
    await show("cp to device", "echo hi > /a; cp /a /dev/null; echo $?");
    await show("mv to device", "echo hi > /a; mv /a /dev/null; echo $?");
    await show("rm device", "rm /dev/null; echo $?");
    await show("touch device", "touch /dev/null; echo $?");
    await show("mkdir device", "mkdir -p /dev/null; echo $?");
    await show("ln -s to device", "ln -s /dev/null /link; cat /link; echo $?; ls -l /link");
    await show("readlink through link then cat", "ln -s /dev/null /link; echo hi > /link; echo $?; ls /");
    await show("dev/fd/3", "echo x > /dev/fd/3; echo $?");
    await show("dev/fd/0 write", "echo x > /dev/fd/0; echo $?");
    await show("read /dev/stderr", "cat /dev/stderr; echo $?");
    await show("< /dev/stdout", "cat < /dev/stdout; echo $?");
    await show("append to /dev/stdout", "echo a >> /dev/stdout; echo $?");
    await show("append to /dev/stderr", "echo a >> /dev/stderr; echo $?");
    await show("2>> /dev/null", "sh -c 'echo e > /dev/stderr' 2>> /dev/null; echo $?");
    await show("trailing slash", "echo x > /dev/null/; echo $?");
    await show("relative dev", "cd /; echo x > dev/null; echo $?");
    await show("dotdot dev", "echo x > /a/../dev/null; echo $?", { "/a/keep": "" });
    await show("stat -c full", "stat /dev/null");
    await show("ls -l dir listing", "ls -l /dev/null; ls -la /dev/null");
    await show("find", "find / -name null; echo $?");
    await show("test -x, -s, -c", "[ -x /dev/null ]; echo x=$?; [ -s /dev/null ]; echo s=$?; [ -e /dev/fd/1 ]; echo e=$?");
    await show("[[ -f ]] and -e", "[[ -e /dev/null ]]; echo e=$?; [[ -f /dev/null ]]; echo f=$?");
    await show("wc device operand", "wc -c /dev/null; echo $?");
    await show("head/grep operand", "grep x /dev/null; echo $?; head -n1 /dev/null; echo $?");
    await show("sed operand", "sed 's/a/b/' /dev/null; echo $?");
    await show("tee stderr alias", "echo hi | tee /dev/stderr; echo $?");
    await show("tee stdout alias", "echo hi | tee /dev/stdout; echo $?");
    await show("cat /dev/stdin operand", "printf 'x\\n' | cat /dev/stdin; echo $?");
    await show("cat - vs dev/stdin", "printf 'x\\n' | cat -; echo $?");
    await show("redirect order stdout to null", "echo body > /dev/stdout > /dev/null; echo after");
    await show("2>&1 then /dev/stdout", "sh -c 'echo o; echo e >/dev/stderr' 2>&1 > /dev/null; echo after");
    await show("exec-like nested", "{ echo inner > /dev/null; } > /out; cat /out; echo done");
    await show("subshell nested", "( echo a > /dev/stdout ) > /out; cat /out");
    await show("glob dev", "echo /dev/*; echo /dev/nul?");
    await show("cd /dev", "cd /dev; echo $?; pwd");
    await show("file on dir-ish", "file /dev/null /dev/stdout; echo $?");
    await show("stat on stdout", "stat -c '%F' /dev/stdout; echo $?");
    await show("null as script", "/dev/null; echo $?");
    await show("source /dev/null", ". /dev/null; echo $?");
    await show("dev/null in for glob", "for f in /dev/null; do echo $f; done");
    await show("truncate via > /dev/null then read", "echo x > /dev/null; cat /dev/null; echo $?");
    await show("write big to null under io budget", "yes 2>/dev/null | head -c 10 > /dev/null; echo $?");
  });
});
