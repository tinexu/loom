# Loom

A spatial, intelligent terminal. Every command you run becomes a card on an infinite canvas. You can branch from any card, pipe one card's output into another, see output as real UI instead of text, and ask Claude when you don't remember the flags.

## Run it

```bash
npm install
npm start
```

This needs Node 18+ and works on macOS and Linux. `npm install` builds `node-pty` against Electron, so Linux needs a C++ toolchain, `make` and Python. Windows runs commands through PowerShell, one process per card, and `cd` tracking there is basic.

To use the Claude features, open **Settings** and paste an Anthropic API key. You can also launch Loom with `ANTHROPIC_API_KEY` set. When your OS supports it, the saved key is encrypted with the OS keychain through Electron `safeStorage`.

## What it does

**Infinite canvas.** Each command is a card that shows its output, working directory, duration and exit status.
- Each new command lands below the active card.
- Running from a card that already has children starts a new branch to the right. Edges connect the cards, and the path to the active card is highlighted.
- Drag a card by its header. Shift-drag moves the card's whole subtree.
- Use the corner handle to resize a card, and double-click a header to collapse it.
- Pan by dragging the background or scrolling. Zoom with ⌘/Ctrl + scroll, trackpad pinch, or the toolbar.

**Pipes between cards.** The ↓ button on a card feeds its output to the next command's stdin, and a dashed blue edge links the two. This lets you rerun the downstream step without rerunning the expensive one.

**Real shell on every branch.** Each branch has one long-lived interactive shell, loaded with your normal rc files. `export`, `cd`, `source .venv/bin/activate`, `nvm use`, aliases and functions all carry over to the next card. Branching from an earlier card starts a new shell with that card's directory and exported variables, so later changes on the old branch don't leak in. A card's environment is saved with the session, so you can keep branching from it after restarting Loom.

**Rich output views.** For a few command types, Loom renders the output as interactive UI. A **Raw** tab is always one click away.

| Command | View |
|---|---|
| `ls` | File grid. Double-click a folder to open it, or a file to `cat` it. Binaries open in their default app. |
| `git log` | Commit graph with branch/merge lanes and ref badges. Double-click a commit for `git show --stat`. |
| `git status` | Staged, changes and untracked groups. Double-click a file to see its diff. |
| JSON / NDJSON output | Collapsible tree |
| CSV / TSV output | Sortable table |
| `ps`, `df`, `docker ps`, `kubectl get`, … | Sortable table parsed from aligned columns |

**Claude.**
- Press **Tab** in the composer, or start a line with `?`, to describe what you want in plain English. Claude sees your OS, shell, current folder, the files in it and the recent commands on this branch.
- Claude suggests one command with an explanation and a risk level (safe / caution / destructive). Destructive commands need a second confirmation before they run.
- When you're piping, Claude is told the command will read the previous card's output.
- Failed cards offer **Explain with Claude**, which returns a short diagnosis plus a fix you can run as a child card.

**History as a map.** **Map** (⌘/Ctrl+B) opens a branch-aware outline of everything you've run. Branches indent where they fork, and you can search the outline. Click any entry to fly to its card. The minimap in the corner shows the whole canvas, and you can click or drag it to navigate. Your session, including output, is saved and restored between launches.

## Keyboard

| Keys | Action |
|---|---|
| Enter | Run (or ask Claude, in ✦ mode) |
| Tab | Toggle shell / ask Claude |
| ↑ / ↓ | Command history |
| Ctrl+C | Stop the active card's process |
| Ctrl+D | Close the active process's stdin (EOF) |
| Esc | Dismiss suggestion → cancel pipe → clear input |
| ⌘/Ctrl+K or `/` | Focus the composer |
| Alt+↑ / ↓ / ← / → | Move to parent / child / sibling card |
| ⌘/Ctrl+0 | Fit everything |
| ⌘/Ctrl+N | Start a new root |
| ⌘/Ctrl+B | Toggle the map |

## How it's built

There's no bundler or framework. The one runtime dependency is `node-pty`, a native module that `postinstall` rebuilds for Electron.

```
main.js       Electron main: routes commands, fs/git queries for rich views, Claude API
              calls, settings + session storage, the one-process-per-card fallback
lib/
  sessions.js PTY shell sessions: shell integration, OSC stream parser, branch → session
preload.js    contextBridge API (the renderer has no Node access)
renderer/
  app.js      canvas, cards, layout, composer, Claude flows, map, minimap, persistence
  views.js    rich-view detection + renderers (files, JSON, tables, git graph, git status)
  ansi.js     ANSI color → HTML
  styles.css  dark and light themes (follows the OS)
test/
  parser.test.js  stream parser unit tests (npm test)
  e2e.js          LOOM_SMOKE run per shell, plus a restart (npm run e2e; xvfb-run on Linux)
```

**Sessions.** A branch's shell is a bash or zsh in a 120×40 PTY with `TERM=xterm-256color`.
- Integration is injected without touching your dotfiles. bash gets `--rcfile` pointing at a generated file. zsh gets a temporary `ZDOTDIR` whose startup files run your real ones. On macOS bash runs the login files too, as a terminal would; on Linux it runs `~/.bashrc`.
- The hooks emit OSC 133 A/B/C/D, OSC 7 for the directory, and `OSC 1337;LoomEnv=<path>` for an env snapshot (`export -p` / `typeset -px`) after every command. Only the bytes between C and D reach the card, so prompts, themes and the echoed command can't.
- Each command is written to a temp script, and Loom types ` source <script>` into the shell at the top level. Bracketed paste isn't an option because macOS ships bash 3.2. This also makes heredocs, quotes and `!` work and turns an unterminated quote into an error instead of a PS2 hang. There's no wrapper function, because `declare` inside one would be local.
- The typed line ends by emitting D itself, because zsh prints `PROMPT_SP` and runs `precmd()` before any hook could. The prompt hook covers the case where ^C aborts the line.
- Markers carry a random per-session nonce in an unexported shell variable, and Loom only accepts its own snapshot path. Otherwise `cat`-ing a hostile file could end a card early, or get a file of its choosing sourced later.
- A parent that's the tip of an idle session runs in that session. A fork, a busy session, a root or an evicted session gets a new shell, which sources the nearest snapshot and `cd`s to the parent's directory. Removing a card kills the session it's the tip of, since nothing can reach that session any more.
- At most 12 sessions stay alive, evicting the least recently used idle one. The cap is soft: running commands are never evicted, so a 13th long-running command still starts.
- Stop types `^C`, then sends SIGTERM and SIGKILL to the foreground process group (found with `ps -o tpgid=`) after 2 s and 3.5 s. If the card is still running at 5 s, the shell itself is stuck, so Loom kills it.
- A card's pipe input is a temp file on `source <script> < <file>`, so it applies to the whole command, not its last pipeline stage.
- If a shell can't start (an rc that hangs or `exec`s something else, or `node-pty` failing to load), the card runs on the old one-process-per-card path with a note in its output. Windows and shells other than bash and zsh always use that path.

The ls and git views query the file system and git directly for structured data instead of parsing text.

## Known limits / next steps

- **Cards aren't terminals yet.** Commands now have a PTY, but cards don't emulate a screen, so full-screen programs (vim, top, less) render badly. Loom warns you and offers to run them anyway. The natural next step is xterm.js, opened in a card on demand. `cmd:resize` exists for that, but nothing calls it yet.
- **stdout and stderr are merged.** A PTY has one stream, so errors are no longer tinted and a card-to-card pipe carries both.
- **A fork inherits exported variables only.** Unexported variables, functions and aliases defined in a card, and `set`/`setopt` changes, stay in that card's shell. So a forked venv works, but its `deactivate` function isn't there. A variable your rc exports and a card `unset`s comes back in a fork. A session recreated after eviction or a restart has the same limits.
- **Snapshots contain your exported environment in plain text**, including any tokens, in `userData/envs` (user-only permissions). They're removed with their card. `session.json` only holds their paths.
- **Background jobs share the terminal.** A `&` job's output lands in whichever card is running when it prints, and is dropped between commands.
- **Commands don't enter your shell history.** Loom turns history off in its sessions so its temp-script lines stay out of `~/.zsh_history` and `~/.bash_history`.
- `exit` and `set -e` end a branch's shell, as they would a terminal window. The next card starts a new shell from the nearest snapshot.
- A prompt theme that rewrites the prompt after Loom's hook loses the 133;B marker. Loom then treats 133;A plus 150 ms as ready, so this only costs a little latency.
- **Force color** now only affects the fallback path, since session commands are on a real terminal.
- Ideas that fit the model:
  - Sticky notes on the canvas
  - Saved "recipes": a branch replayed as a script
  - Diff two cards' outputs
  - Watch mode that reruns a card on an interval
