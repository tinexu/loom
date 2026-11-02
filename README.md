# Loom

A spatial, intelligent terminal. Every command you run becomes a card on an infinite canvas. You can branch from any card, pipe one card's output into another, see output as real UI instead of text, and ask Claude when you don't remember the flags.

## Run it

```bash
npm install
npm start
```

This needs Node 18+ and works on macOS and Linux. Windows runs commands through PowerShell, but `cd` tracking there is basic.

To use the Claude features, open **Settings** and paste an Anthropic API key. You can also launch Loom with `ANTHROPIC_API_KEY` set. When your OS supports it, the saved key is encrypted with the OS keychain through Electron `safeStorage`.

## What it does

**Infinite canvas.** Each command is a card that shows its output, working directory, duration and exit status.
- Each new command lands below the active card.
- Running from a card that already has children starts a new branch to the right. Edges connect the cards, and the path to the active card is highlighted.
- Drag a card by its header. Shift-drag moves the card's whole subtree.
- Use the corner handle to resize a card, and double-click a header to collapse it.
- Pan by dragging the background or scrolling. Zoom with ⌘/Ctrl + scroll, trackpad pinch, or the toolbar.

**Pipes between cards.** The ↓ button on a card feeds its output to the next command's stdin, and a dashed blue edge links the two. This lets you rerun the downstream step without rerunning the expensive one.

**Real shell, persistent cwd.** Commands run in your login shell's PATH. A `cd` in one card carries over to that card's children. Each branch keeps its own working directory, so two branches can sit in different folders.

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

There's no build step and no runtime dependencies besides Electron.

```
main.js       Electron main: spawns commands, kills process groups, cwd tracking,
              fs/git queries for rich views, Claude API calls, settings + session storage
preload.js    contextBridge API (the renderer has no Node access)
renderer/
  app.js      canvas, cards, layout, composer, Claude flows, map, minimap, persistence
  views.js    rich-view detection + renderers (files, JSON, tables, git graph, git status)
  ansi.js     ANSI color → HTML
  styles.css  dark and light themes (follows the OS)
```

- Each command runs as `$SHELL -c '<command>; printf "$PWD" >&3'` in its own process group. The extra file descriptor reports the final directory back to Loom, which is how `cd` persists.
- Stop sends SIGINT, then SIGTERM, then SIGKILL to the group.
- The ls and git views query the file system and git directly for structured data instead of parsing text.

## Known limits / next steps

- **No PTY yet.** Commands run on pipes, so full-screen programs (vim, top, less) won't work. Loom warns you and offers to run them anyway. The natural next step is `node-pty` + xterm.js, opened in a card on demand.
- Shell aliases and functions from `.zshrc` aren't loaded, because commands run non-interactively.
- Output is plain by default, since tools don't color output when it isn't going to a terminal. **Settings → Force color** turns color on, but it can leak escape codes into pipes inside a single command.
- Ideas that fit the model:
  - Sticky notes on the canvas
  - Saved "recipes": a branch replayed as a script
  - Diff two cards' outputs
  - Watch mode that reruns a card on an interval
