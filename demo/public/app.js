import { redrawSequence, submitSequence } from "./line-block.js";

(() => {
  "use strict";

  const RECONNECT_MIN_MS = 750;
  const RECONNECT_MAX_MS = 8_000;
  const KEEPALIVE_MS = 25_000;
  const encoder = new TextEncoder();

  const terminalElement = document.querySelector("#terminal");
  const terminalSurface = document.querySelector("#terminal-surface");
  const examplesElement = document.querySelector("#examples");


  const terminal = new Terminal({
    allowProposedApi: false,
    convertEol: true,
    cursorBlink: true,
    cursorStyle: "bar",
    fontFamily:
      '"SFMono-Regular", Consolas, "Liberation Mono", "Noto Sans Mono", monospace',
    fontSize: 13,
    fontWeight: "400",
    letterSpacing: 0.2,
    lineHeight: 1.45,
    scrollback: 3_000,
    theme: {
      background: "#07120f",
      foreground: "#c8d8cf",
      cursor: "#a7f3b4",
      cursorAccent: "#07120f",
      selectionBackground: "#315744",
      black: "#07120f",
      red: "#ff7b82",
      green: "#83e5a4",
      yellow: "#e7c477",
      blue: "#7ab6e8",
      magenta: "#c59be8",
      cyan: "#72d7cf",
      white: "#dbe8e0",
      brightBlack: "#60766b",
      brightRed: "#ff969b",
      brightGreen: "#a7f3b4",
      brightYellow: "#f1d491",
      brightBlue: "#9ac9ee",
      brightMagenta: "#d3afea",
      brightCyan: "#94e6df",
      brightWhite: "#f0f7f2",
    },
  });
  const fitAddon = new FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(terminalSurface);

  /**
   * Re-measures the grid against the element that holds it.
   *
   * Coalesced into a frame because a resize arrives many times per drag and
   * each fit re-measures a character cell. Guarded because fit() throws if the
   * element is not laid out yet, which happens if this runs while the card is
   * hidden.
   */
  let fitPending = false;
  function scheduleFit() {
    if (fitPending) return;
    fitPending = true;
    requestAnimationFrame(() => {
      fitPending = false;
      try {
        fitAddon.fit();
      } catch {
        return;
      }
      sendDimensions();
    });
  }

  fitAddon.fit();
  terminal.focus();

  // The first fit measures a character cell in whatever font is resolved at
  // that instant. `fontFamily` starts with a face most systems do not have, so
  // the fallback often arrives after this — and a cell one fraction of a pixel
  // wider than measured is the last column sitting outside the frame.
  if (document.fonts?.ready) void document.fonts.ready.then(scheduleFit);

  // A window resize is not the only thing that changes the terminal's size: a
  // scrollbar appearing, the footer wrapping, or the card being laid out after
  // this runs all change it without one.
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(scheduleFit).observe(terminalSurface);
  }

  let socket;
  let reconnectTimer;
  let keepaliveTimer;
  let reconnectDelay = RECONNECT_MIN_MS;
  let manualReconnect = false;
  let connected = false;
  let running = true;
  let promptAnsi = "";
  let line = "";
  let cursor = 0;
  let historyIndex = 0;
  const history = [];
  let searching = false;
  let searchQuery = "";
  let searchFrom = 0;
  let searchIndex = 0;
  let userClosed = false;
  let edits = 0;

  /**
   * Asks the server what could come next, debounced.
   *
   * Debounced and token-stamped because completion is a request per keystroke
   * otherwise, and an answer that arrives after the line has moved on would
   * edit the wrong text. A stale token is dropped rather than applied.
   */
  function requestCompletion() {
    // The token is the edit generation, not a request number: any keystroke
    // between asking and answering invalidates the offsets in the reply, and
    // dropping it is the only safe thing to do with them.
    send({ type: "complete", line, cursor, token: edits });
  }

  /** Applies an answer, if it is still about the line on screen. */
  function applyCandidates(message) {
    if (message.token !== edits) return;
    if (message.values.length === 0) return;
    const word = line.slice(message.start, message.end);
    if (message.values.length === 1) {
      const only = message.values[0];
      // A directory is a step on the way somewhere, so it keeps its separator
      // and the line stays open; anything else is finished with a space.
      const finished = only.kind === "directory" ? only.value : `${only.value} `;
      line = `${line.slice(0, message.start)}${finished}${line.slice(message.end)}`;
      cursor = message.start + finished.length;
      redrawLine();
      return;
    }
    if (message.commonPrefix.length > word.length) {
      line = `${line.slice(0, message.start)}${message.commonPrefix}${line.slice(message.end)}`;
      cursor = message.start + message.commonPrefix.length;
      redrawLine();
      return;
    }
    // Nothing more to type: show the choices, and say so when the list was cut
    // short rather than presenting part of it as all of it.
    const shown = message.values.map((candidate) => candidate.value).join("  ");
    terminal.write(`\r\n${shown}${message.truncated ? "  \x1b[38;5;244m…more\x1b[0m" : ""}\r\n`);
    redrawLine();
  }

  function startSearch() {
    searching = true;
    searchQuery = "";
    searchFrom = history.length - 1;
    drawSearch();
  }

  function drawSearch() {
    const match = searchMatch();
    terminal.write(`\r\x1b[2K(reverse-i-search)\`${searchQuery}': ${match ?? ""}`);
  }

  function searchMatch() {
    for (let index = Math.min(searchFrom, history.length - 1); index >= 0; index -= 1) {
      if (searchQuery === "" || (history[index] ?? "").includes(searchQuery)) {
        searchIndex = index;
        return history[index];
      }
    }
    return undefined;
  }

  /** Returns true when the key belonged to the search, not to the line. */
  function handleSearchKey(data) {
    if (data === "\x12") {
      // Step to the next older match, as a shell does.
      searchFrom = searchIndex - 1;
      drawSearch();
      return true;
    }
    if (data === "\x07" || data === "\x1b") {
      searching = false;
      redrawLine();
      return true;
    }
    if (data === "\r") {
      const match = searchMatch();
      searching = false;
      line = match ?? "";
      cursor = line.length;
      redrawLine();
      return true;
    }
    if (data === "\x7f") {
      searchQuery = searchQuery.slice(0, -1);
      searchFrom = history.length - 1;
      drawSearch();
      return true;
    }
    if (data.length === 1 && data >= " ") {
      searchQuery += data;
      searchFrom = history.length - 1;
      drawSearch();
      return true;
    }
    return false;
  }
  const queuedLines = [];

  /**
   * The connection has no readout on the page any more.
   *
   * Kept as the one place the state is named so the calls that report it stay
   * where they are: a session that ends or fails still says so in the terminal,
   * which is where someone typing is already looking.
   */
  function setConnection(kind, label) {
    if (kind === "offline") writeNotice(label, "203");
  }

  function safeCwd(value) {
    return String(value)
      .replace(/[^\x20-\x7e]/g, "?")
      .slice(0, 96);
  }

  function buildPrompt(cwd, continuation) {
    if (continuation) return "\x1b[38;5;244m> \x1b[0m";
    return (
      "\x1b[38;5;81mcf-vfs\x1b[0m:" +
      `\x1b[38;5;114m${safeCwd(cwd)}\x1b[0m$ `
    );
  }

  /**
   * Rows below the block's first row that the cursor currently sits on.
   *
   * A line longer than the terminal is wide occupies several rows, and a redraw
   * has to start from the first of them. Without this the redraw began wherever
   * the cursor happened to be — the last row — and every keystroke left the rows
   * above it behind and wrote another copy underneath.
   */
  let cursorRow = 0;

  function redrawLine() {
    // Every path that changes the line redraws it, so this is the one place
    // that has to notice — an in-flight completion answer is stale from here.
    edits += 1;
    const next = redrawSequence({
      prompt: promptAnsi,
      line,
      cursor,
      columns: terminal.cols,
      cursorRow,
    });
    cursorRow = next.cursorRow;
    terminal.write(next.sequence);
  }

  function showPrompt(cwd, continuation) {
    searching = false;
    promptAnsi = buildPrompt(cwd, continuation);
    line = "";
    cursor = 0;
    cursorRow = 0;
    running = false;
    terminal.write(promptAnsi);
    drainQueuedLine();
  }

  function writeNotice(text, color = "244") {
    terminal.write(`\x1b[38;5;${color}m${text}\x1b[0m\r\n`);
  }

  function send(message) {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  function submitLine(value = line) {
    if (running || !connected) return;
    // Same block, same rule: go back to its first row and replace all of it,
    // or a wrapped line is echoed on top of its own leftovers.
    terminal.write(submitSequence({ prompt: promptAnsi, line: value, cursorRow }));
    cursorRow = 0;
    if (value.length > 0) {
      if (history[history.length - 1] !== value) history.push(value);
      if (history.length > 250) history.shift();
    }
    historyIndex = history.length;
    line = "";
    cursor = 0;
    running = true;
    if (!send({ type: "line", line: value })) {
      running = false;
      writeNotice("connection lost before command was sent", "203");
    }
  }

  function drainQueuedLine() {
    if (running || queuedLines.length === 0) return;
    const next = queuedLines.shift();
    window.setTimeout(() => submitLine(next), 0);
  }

  function queuePaste(value) {
    const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const parts = normalized.split("\n");
    const first = parts.shift() ?? "";
    line = `${line.slice(0, cursor)}${first}${line.slice(cursor)}`;
    cursor += first.length;
    redrawLine();
    if (parts.length === 0) return;

    const finalIsPartial = !normalized.endsWith("\n");
    const finalPart = finalIsPartial ? parts.pop() ?? "" : undefined;
    queuedLines.push(...parts);
    submitLine();
    if (finalPart !== undefined && finalPart.length > 0) {
      queuedLines.push(finalPart);
    }
  }

  function moveHistory(direction) {
    if (history.length === 0) return;
    historyIndex = Math.max(0, Math.min(history.length, historyIndex + direction));
    line = historyIndex === history.length ? "" : history[historyIndex] ?? "";
    cursor = line.length;
    redrawLine();
  }

  function handleTerminalData(data) {
    if (!connected) return;
    if (data.includes("\n") || (data.includes("\r") && data !== "\r")) {
      if (!running) queuePaste(data);
      return;
    }
    if (searching && handleSearchKey(data)) return;
    if (data === "\r") {
      submitLine();
      return;
    }
    if (data === "\x03") {
      terminal.write("^C\r\n");
      queuedLines.length = 0;
      line = "";
      cursor = 0;
      running = true;
      send({ type: "signal", signal: "SIGINT" });
      return;
    }
    if (running) return;
    // Any key the search did not claim leaves it, keeping the line it found —
    // otherwise the next character typed goes into the query instead.
    if (searching) {
      searching = false;
      redrawLine();
    }
    // Ctrl-D on an empty line ends the session, as a shell does; on a line
    // with text it does nothing, rather than deleting forward, because there
    // is no forward-delete convention worth surprising anyone with here.
    if (data === "\x04") {
      if (line.length === 0) {
        terminal.write("exit\r\n");
        userClosed = true;
        socket?.close(1000, "client exit");
      }
      return;
    }
    // Ctrl-W deletes the word before the cursor, Ctrl-U to the start of the
    // line, Ctrl-K to the end. All three are line editing and never reach the
    // server: the shell sees a line, not keystrokes.
    if (data === "\x17") {
      const before = line.slice(0, cursor).replace(/\s+$/u, "");
      const start = Math.max(0, before.search(/\S+$/u));
      line = `${line.slice(0, start)}${line.slice(cursor)}`;
      cursor = start;
      redrawLine();
      return;
    }
    if (data === "\x15") {
      line = line.slice(cursor);
      cursor = 0;
      redrawLine();
      return;
    }
    if (data === "\x0b") {
      line = line.slice(0, cursor);
      redrawLine();
      return;
    }
    if (data === "\x12") {
      startSearch();
      return;
    }
    if (data === "\t") {
      requestCompletion();
      return;
    }
    if (data === "\x0c") {
      terminal.clear();
      redrawLine();
      return;
    }
    if (data === "\x7f") {
      if (cursor > 0) {
        line = `${line.slice(0, cursor - 1)}${line.slice(cursor)}`;
        cursor -= 1;
        redrawLine();
      }
      return;
    }
    if (data === "\x1b[A") {
      moveHistory(-1);
      return;
    }
    if (data === "\x1b[B") {
      moveHistory(1);
      return;
    }
    if (data === "\x1b[D") {
      if (cursor > 0) {
        cursor -= 1;
        terminal.write("\x1b[D");
      }
      return;
    }
    if (data === "\x1b[C") {
      if (cursor < line.length) {
        cursor += 1;
        terminal.write("\x1b[C");
      }
      return;
    }
    if (data === "\x1b[H" || data === "\x1bOH") {
      cursor = 0;
      redrawLine();
      return;
    }
    if (data === "\x1b[F" || data === "\x1bOF") {
      cursor = line.length;
      redrawLine();
      return;
    }
    if (data === "\x1b[3~") {
      if (cursor < line.length) {
        line = `${line.slice(0, cursor)}${line.slice(cursor + 1)}`;
        redrawLine();
      }
      return;
    }
    if (/^\x1b/.test(data) || /[\x00-\x08\x0b-\x1f]/.test(data)) return;

    line = `${line.slice(0, cursor)}${data}${line.slice(cursor)}`;
    cursor += data.length;
    redrawLine();
  }

  function handleServerMessage(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      writeNotice("received an invalid server message", "203");
      return;
    }
    if (message.type === "hello") {
      // Said plainly, because the difference matters and is invisible: the
      // files are in the Durable Object and survive; the session is not.
      const durability =
        message.durability?.session === "connection"
          ? "\x1b[38;5;244mFiles persist. Working directory, variables, and history do not " +
            "survive a reconnect.\x1b[0m\r\n"
          : "";
      terminal.write(
        "\x1b[1;38;5;114mcf-vfs interactive demo\x1b[0m\r\n" +
          `\x1b[38;5;244mShared workspace \x1b[38;5;150m${message.workspace ?? "country-XX"}\x1b[38;5;244m — everyone in this country types into the same files.\x1b[0m\r\n` +
          durability +
          "\x1b[38;5;244mTab completes · Ctrl-R searches history · Ctrl-W/U/K edit · " +
          "Ctrl-C cancels · Ctrl-D exits\x1b[0m\r\n" +
          "\x1b[38;5;244mTry \x1b[38;5;150mcat README.txt\x1b[38;5;244m or " +
          "\x1b[38;5;150mprintf 'hello\\n' > hello.txt\x1b[0m\r\n\r\n",
      );
      return;
    }
    if (message.type === "candidates") {
      applyCandidates(message);
      return;
    }
    if (message.type === "output") {
      terminal.write(String(message.data));
      return;
    }
    if (message.type === "prompt") {
      showPrompt(message.cwd, message.continuation === true);
      return;
    }
    if (message.type === "running") {
      running = true;
      setConnection("online", "running");
      return;
    }
    if (message.type === "complete") {
      setConnection("online", message.exitCode === 0 ? "connected" : `exit ${message.exitCode}`);
      return;
    }
    if (message.type === "doc") {
      applyDocument(message);
      return;
    }
    if (message.type === "doc-gone") {
      if (message.path !== openPath) return;
      if (typeof message.to === "string") {
        // The terminal moved it. Follow, rather than leaving a pane pointed at
        // a path that no longer names anything.
        openPath = message.to;
        editorPath.value = message.to;
        setEditorStatus(`Moved to ${message.to} from the terminal.`, "live");
        return;
      }
      openPath = null;
      editorText.value = "";
      editorText.disabled = true;
      editorCloseButton.hidden = true;
      setEditorStatus(`${message.path} was removed from the terminal.`, "error");
      return;
    }
    if (message.type === "error") {
      writeNotice(String(message.message), "203");
      if (openPath !== null) setEditorStatus(String(message.message), "error");
      return;
    }
    if (message.type === "closed") {
      writeNotice(`logout (status ${message.exitCode})`);
      running = true;
    }
  }

  function scheduleReconnect() {
    window.clearTimeout(reconnectTimer);
    if (manualReconnect) {
      reconnectDelay = RECONNECT_MIN_MS;
      manualReconnect = false;
    }
    reconnectTimer = window.setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(RECONNECT_MAX_MS, reconnectDelay * 1.7);
  }

  function connect() {
    window.clearTimeout(reconnectTimer);
    window.clearInterval(keepaliveTimer);
    setConnection("connecting", "connecting");
    running = true;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const url = new URL("/ws", location.href);
    url.protocol = protocol;
    socket = new WebSocket(url);

    socket.addEventListener("open", () => {
      connected = true;
      reconnectDelay = RECONNECT_MIN_MS;
      setConnection("online", "connected");
      keepaliveTimer = window.setInterval(() => send({ type: "ping" }), KEEPALIVE_MS);
      sendDimensions();
      // The document is in the object and outlived the socket, so a reconnect
      // asks for it again rather than leaving a pane showing a version this
      // session can no longer edit.
      if (openPath !== null) send({ type: "doc-open", path: openPath });
      terminal.focus();
    });
    socket.addEventListener("message", handleServerMessage);
    socket.addEventListener("close", (event) => {
      connected = false;
      running = true;
      window.clearInterval(keepaliveTimer);
      if (userClosed) {
        // A deliberate exit is not a dropped connection: reconnecting here
        // would hand the user a new session moments after they ended one.
        setConnection("offline", "session ended");
        writeNotice("session ended. reload to start a new one.", "244");
        return;
      }
      setConnection("offline", "reconnecting");
      if (event.code !== 1000) writeNotice("session disconnected; reconnecting…", "214");
      scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      setConnection("offline", "connection error");
    });
  }

  terminal.onData(handleTerminalData);
  window.addEventListener("resize", scheduleFit);

  /**
   * Tells the server how wide the view is, as a hint and nothing more.
   *
   * There is no terminal behind this session — no modes, no ioctl — so the
   * server treats the numbers as presentation and never reports a capability
   * it does not have.
   */
  function sendDimensions() {
    if (!connected) return;
    send({ type: "resize", columns: terminal.cols, rows: terminal.rows });
  }
  terminalElement.addEventListener("click", () => terminal.focus());

  /**
   * Commands worth trying, grouped so a reader can see the range rather than a
   * list of one kind of thing.
   *
   * Each is written to run against a workspace nobody has touched, so a visitor
   * can click them in any order and get the output the label promises.
   */
  const EXAMPLES = [
    ["identity", "id; groups; stat -c '%U:%G %a %n' . README.txt"],
    ["write a file", "printf 'hello\\nworld\\n' > notes.txt && cat notes.txt"],
    ["pipeline", "seq 1 20 | grep -E '[13579]$' | wc -l"],
    ["make a tree", "mkdir -p src/{lib,test} && ls -R src"],
    ["brace range", "touch part{1..5}.txt && ls part*"],
    ["find and edit", "sed -i 's/world/shell/' notes.txt && cat notes.txt"],
    ["what is here", "ls -la / | head"],
    ["applet directory", "ls /bin | head -12 | tr '\\n' ' '"],
    ["a device", "echo lost > /dev/null; echo kept"],
    ["symlink", "ln -s /etc link && readlink link && ls -l link | cut -c1"],
    ["heredoc", "cat > poem.txt <<'EOF'\nroses are red\nEOF\nwc -l poem.txt"],
    ["arithmetic", "echo $((2 ** 16)) $((7 % 3))"],
    ["a loop", "for n in {1..3}; do printf '%s squared is %s\\n' $n $((n * n)); done"],
    ["fetch a page", "curl -s https://example.com/ | grep -o '<title>[^<]*'"],
    // Not the repository API: unauthenticated GitHub allows sixty requests an
    // hour per address, and every visitor here shares one. The raw file host
    // serves content rather than API calls and does not run out.
    [
      "fetch some JSON",
      "curl -s https://raw.githubusercontent.com/corca-ai/cf-vfs/main/package.json | jq -r .version",
    ],
    [
      "query it",
      "curl -s https://raw.githubusercontent.com/corca-ai/cf-vfs/main/package.json | jq -r '.exports | keys | .[:6][]'",
    ],
    [
      "shape it",
      "curl -s https://raw.githubusercontent.com/corca-ai/cf-vfs/main/package.json | jq -c '{name, version, scripts: (.scripts | keys | length)}'",
    ],
    ["jq on a literal", "echo '[{\"n\":3},{\"n\":1}]' | jq -c 'sort_by(.n) | map(.n)'"],
    ["jq refuses the rest", "echo '{}' | jq 'def f: .; f'"],
    ["refused origin", "curl -s https://example.net/ ; echo \"exit $?\""],
    ["refused method", "curl -s -d leak=secret https://example.com/"],
    ["disk usage", "du / 2>/dev/null; df 2>/dev/null || stat -c '%s %n' notes.txt"],
  ];

  for (const [label, command] of EXAMPLES) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.title = command;
    button.addEventListener("click", () => {
      // Inserted, not submitted: a visitor should get to read and edit it
      // before it runs. `queuePaste` is the same path a real paste takes, so a
      // multi-line example arrives exactly as one typed by hand would.
      queuePaste(command);
      terminal.focus();
    });
    examplesElement.append(button);
  }

  // --- the editor pane ----------------------------------------------------
  //
  // Deliberately a textarea and the whole file rather than an editor and a
  // stream of operations. What this is here to show is one level down: that a
  // shell command and a person can change the same file at once and both
  // survive. A version stamp is what keeps that honest — the same shape the
  // filesystem's mutation token has, one layer below.

  const editorForm = document.getElementById("editor-form");
  const editorPath = document.getElementById("editor-path");
  const editorText = document.getElementById("editor-text");
  const editorStatus = document.getElementById("editor-status");
  const editorCloseButton = document.getElementById("editor-close");
  /** The path this pane has open, or null. */
  let openPath = null;
  /** The version the text in the box was typed against. */
  let openVersion = 0;
  let sendEditTimer = 0;

  function setEditorStatus(text, kind = "") {
    editorStatus.textContent = text;
    editorStatus.className = `editor-status${kind === "" ? "" : ` is-${kind}`}`;
  }

  function openDocument(path) {
    if (openPath !== null && openPath !== path) send({ type: "doc-close", path: openPath });
    openPath = path;
    send({ type: "doc-open", path });
    setEditorStatus(`Opening ${path}…`);
  }

  function closeDocument() {
    if (openPath === null) return;
    send({ type: "doc-close", path: openPath });
    openPath = null;
    editorText.value = "";
    editorText.disabled = true;
    editorCloseButton.hidden = true;
    setEditorStatus("Nothing open.");
  }

  function flushEdit() {
    if (openPath === null) return;
    send({ type: "doc-edit", path: openPath, base: openVersion, text: editorText.value });
  }

  editorForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const path = editorPath.value.trim();
    if (path !== "") openDocument(path);
  });

  editorCloseButton.addEventListener("click", closeDocument);

  editorText.addEventListener("input", () => {
    // Debounced rather than per-keystroke: every send is a round trip, and the
    // window it leaves is the only thing a shell write can land inside.
    window.clearTimeout(sendEditTimer);
    sendEditTimer = window.setTimeout(flushEdit, 180);
  });

  /**
   * Replaces the text without moving the caret out from under the typist.
   *
   * The offset is kept rather than the line and column, because a change that
   * arrived from the shell may have been anywhere above.
   */
  function applyDocument(message) {
    if (message.path !== openPath) return;
    const wasFocused = document.activeElement === editorText;
    const caret = editorText.selectionStart;
    const before = editorText.value;
    openVersion = message.version;
    if (before !== message.text) {
      editorText.value = message.text;
      if (wasFocused) {
        const kept = Math.min(caret, message.text.length);
        editorText.setSelectionRange(kept, kept);
      }
    }
    editorText.disabled = false;
    editorCloseButton.hidden = false;
    setEditorStatus(
      `${message.path} · version ${message.version} — shared with everyone in this room.`,
      "live",
    );
  }

  connect();
})();
