# Loom

A spatial, intelligent terminal. Every command you run becomes a card on an infinite canvas, and anything that works in iTerm or Terminal.app works in a card. You can branch from any card, pipe one card's output into another, see output as real UI instead of text, and ask Claude when you don't remember the flags.

## Install

Download the latest build from [Releases](https://github.com/tinexu/loom/releases):

| System | File | Install |
|---|---|---|
| macOS, Apple Silicon | `Loom-<version>-arm64.dmg` | Open it, drag Loom to Applications |
| macOS, Intel | `Loom-<version>.dmg` (x64) | The same |
| Linux, x64 | `Loom-<version>-x86_64.AppImage` | `chmod +x` it and run it. Loom offers to add itself to your applications menu on first launch (or use [AppImageLauncher](https://github.com/TheAssassin/AppImageLauncher)) |
| Debian, Ubuntu | `loom-terminal_<version>_amd64.deb` | `sudo apt install ./loom-terminal_<version>_amd64.deb` |

**Unsigned macOS builds.** Until releases are signed with a Developer ID and notarized, macOS blocks the first launch of a downloaded Loom ("Loom can't be opened" or "is damaged"). Either right-click Loom.app → **Open** → **Open** once, or run:

```bash
xattr -dr com.apple.quarantine /Applications/Loom.app
```

The dmg also holds **Open in Loom.app**: ⌘-drag it into a Finder window's toolbar, and clicking it opens that window's folder in Loom. "Open With → Loom" on a folder, and dropping a folder on Loom's Dock icon, open it in a tab.

**On Linux** the deb installs Loom in `/opt/Loom`, a `loom` command in `/usr/bin`, the desktop entry (Loom shows in Files → Open With for folders) and its icons, and registers Loom as an `x-terminal-emulator` alternative (`sudo update-alternatives --config x-terminal-emulator` picks it as the default). Removing the package undoes all of it.

**Claude.** Open **Settings → Claude** and paste an Anthropic API key, or put `ANTHROPIC_API_KEY=…` in Loom's `.env` (**Open .env file** there creates it): `~/Library/Application Support/Loom/.env` on macOS, `~/.config/Loom/.env` on Linux. An installed Loom never reads a `.env` from anywhere else, and values in it aren't passed to the shells in your tabs.

**Updating.** For now, new versions are on the Releases page (**Check for Updates…** in the app menu links there). Automatic updates come with signed releases.

## Building from source

```bash
npm install          # also rebuilds node-pty for Electron and copies xterm to renderer/vendor
npm start            # run from the checkout (reads ./.env)
npm test             # unit tests
npm run e2e          # the LOOM_SMOKE end-to-end run (xvfb-run on Linux)
npm run dist         # build installable apps for this machine into dist/
```

This needs Node 18+ and works on macOS and Linux. `npm install` builds `node-pty` against Electron, so Linux needs a C++ toolchain, `make` and Python. Windows runs commands through PowerShell, one process per card, and `cd` tracking there is basic.

`npm run dist` builds for the platform and architecture it runs on: a dmg and a zip (the zip is what auto-update downloads) on macOS, an AppImage and a deb on Linux, an NSIS installer on Windows. node-pty is native code, so each architecture is built on a matching machine rather than cross-compiled (`npm run dist -- --x64` on an Intel Mac, `--arm64` on Apple Silicon). After building, `npm run check:package` (run automatically) lists `app.asar` and its unpacked folder, and fails if a `.env`, anything containing `sk-ant-`, tests, fixtures, bench files, dev scripts, screenshots or logs got in. `npm run icons` regenerates `build/icon.icns`, `build/icon.ico`, `build/icon.png` and `build/icons/*.png` from `build/icon.svg`.

Only `main.js`, `preload.js`, `lib/`, `renderer/` (with its vendor files), `themes/` and the production dependencies are packaged. node-pty is unpacked from the asar (its native module and `spawn-helper` are loaded from disk), and its prebuilt binaries for other systems are removed after packing.

**Signing and notarization (macOS).** `npm run dist` decides from the environment:

| Variables | What happens |
|---|---|
| none | An **unsigned** app (ad-hoc signature, no hardened runtime), with a warning. It runs; Gatekeeper blocks a downloaded copy until it's opened as above |
| `CSC_LINK` (a .p12, path or base64) + `CSC_KEY_PASSWORD`, or `CSC_NAME` (an identity in the keychain) | Signed with the hardened runtime and `build/entitlements.mac.plist` |
| …plus `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` — or an App Store Connect key: `APPLE_API_KEY` (path to the .p8), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | Also notarized with notarytool, and stapled |

The entitlements are only what's needed: `allow-jit` and `allow-unsigned-executable-memory` for Electron's V8, and `automation.apple-events`, because programs in Loom's terminals are its child processes and macOS asks on Loom's behalf when one of them (osascript, `open -a`, a build script) controls another app; without it the hardened runtime denies them silently. `disable-library-validation` isn't needed: node-pty's module is signed with the app, by the same identity. Windows signs only when `CSC_LINK` (or `WIN_CSC_LINK`) and `CSC_KEY_PASSWORD` are set; otherwise the installer is unsigned and SmartScreen warns.

Only one Loom runs at a time: starting it again (or running `loom`) hands the folder or command to the one that's open.

### The `loom` command

Run **Install 'loom' command in PATH** from the command palette (⌘/Ctrl+Shift+P), the app menu, or Settings → Integrations. It puts `loom` in `/usr/local/bin` if that folder is writable, otherwise in `~/.local/bin`, and tells you if that folder isn't on your `PATH`. In an installed app it's a link to the script inside the app (`Loom.app/Contents/Resources/bin/loom`, or `/opt/Loom/resources/bin/loom`), which finds the app from where it is, so it keeps working when an update replaces the app; an AppImage gets a script that runs the AppImage file. The deb installs `/usr/bin/loom` itself. **Uninstall 'loom' command** removes it (and only a `loom` that Loom wrote).

```bash
loom .                      # open this folder in a tab, or go to its tab
loom ~/code/app             # the same, for any folder
loom -e "npm test"          # run a command in this folder's tab
loom ~/code/app -e "make"   # …or in that folder's
loom --new-tab              # a new tab here, even if there's one already
loom --dropdown             # show the dropdown terminal
```

The script returns at once. From a checkout it runs Electron on the project folder. `-e` takes the rest of the line, as xterm's does (`loom -e vim notes.txt`), which is what lets Loom be Debian's `x-terminal-emulator`. `loom://open?path=/x&exec=ls` URLs do the same (Loom registers `loom://`).

**Open in Loom from the file manager.** On macOS, Settings → Integrations → **Install Finder Quick Action** adds “Open in Loom” to the Quick Actions and Services menus when you right-click a folder. The installed app also handles “Open With → Loom”, folders dropped on its Dock icon, and the Open in Loom toolbar helper from the dmg. On Linux the same button installs `~/.local/share/applications/loom.desktop` (Loom as a handler for folders), an “Open in Loom” script for Files (Nautilus) and Nemo, and a Dolphin service menu. A Windows Explorer entry isn't there yet.

To use the Claude features, open **Settings** and paste an Anthropic API key, put it in `.env`, or launch Loom with `ANTHROPIC_API_KEY` set. When your OS supports it, a key saved in Settings is encrypted with the OS keychain through Electron `safeStorage`.

**Help.** Help → **Report an Issue** opens a new GitHub issue with the versions of Loom, Electron, Chromium, Node, the OS and your shell filled in (nothing is sent until you submit it), and **Copy Debug Info** copies the same. **About Loom** shows them too.

## What it does

**Tabs.** Each tab is its own canvas: its cards, view, active card, root folder and history map, and its own shell sessions.
- A tab can belong to a project folder (`loom ~/code/app` makes one, and goes back to it the next time). Its title is the folder's name; double-click to rename, and click its dot to give it a color.
- Drag tabs to reorder them, middle-click to close. ⌘/Ctrl+Shift+T reopens the last ten closed tabs, cards and all.
- Background tabs keep running. A tab shows a spinner while something runs in it, and a red or green dot when a command failed or finished since you last looked.
- When a command that ran for more than 10 seconds finishes while Loom isn't in front, you get a notification; clicking it brings back its tab and card (Settings → General).
- Closing a tab with commands running asks first and lists them; so does quitting, across all tabs.
- Tabs come back after a restart, in order, with their cards (Settings → General → Restore tabs).

**Dropdown terminal.** A global hotkey (Ctrl+` by default) slides a terminal down from the top of the screen your mouse is on, over any app, full width and 45% tall (drag its bottom edge, or set the height in Settings). It has its own tabs, and its commands keep running while it's hidden. The hotkey again, or Esc Esc, hides it; it also hides when it loses focus unless you pin it (📌). It shows on every macOS Space and over full-screen apps. If the hotkey can't be registered (another app has it, or Wayland), Settings → Dropdown says so; on Wayland, bind a key in your desktop's settings to `loom --dropdown`.

**Command palette.** ⌘/Ctrl+Shift+P searches every command, fuzzily, with its shortcut, recently used ones first. Every shortcut is a command, so the palette also shows you the keys.

**Settings** (⌘/Ctrl+,) is a page with General, Appearance, Terminal, Keys, Dropdown, Claude and Integrations sections. Every change applies at once. **Edit settings.json** opens the file; Loom watches it, and a typo or a bad value is reported at the top of the page (the last good value is used) instead of stopping anything.
- **Keys** lists every command with its shortcuts. Click Record and press a shortcut; a clash with another command is flagged. Shortcuts live in `userData/keybindings.json` as `[{ "key": "Mod+Shift+F", "command": "view.fit", "when": "canvas" }]`, where `Mod` is ⌘ on macOS and Ctrl elsewhere and `"command": "-view.fit"` removes a default. Edits to the file apply as you save it.
- **Themes** pick separately for light and dark mode, following the system, or one fixed. Built in: Loom Dark, Loom Light, Solarized Dark, Solarized Light, Nord and Gruvbox Dark. Import iTerm2 `.itermcolors` and Windows Terminal schemes; your themes live in `userData/themes/` and are picked up as they change. A theme sets the UI colors, the 16 ANSI colors cards render with, xterm's colors and the git graph's lanes. The picker warns when a theme's text is under WCAG AA contrast (4.5:1) — the two Solarized themes are, by design.
- **Fonts**: family (installed monospace fonts are listed, any name can be typed), size, line height, weight and ligatures, for cards, rich views, live terminals and the command bar. ⌘/Ctrl+Shift+= / - / 0 change the size anywhere.
- **Terminal**: shell and its arguments, cursor style and blink, live scrollback, output limits, real pager, force color.

**Infinite canvas.** Each command is a card that shows its output, working directory, duration and exit status.
- Each new command lands below the active card.
- Running from a card that already has children starts a new branch to the right. Edges connect the cards, and the path to the active card is highlighted.
- Drag a card by its header. Shift-drag moves the card's whole subtree.
- Use the corner handle to resize a card, and double-click a header to collapse it.
- Pan by dragging the background or scrolling. Zoom with ⌘/Ctrl + scroll, trackpad pinch, or the toolbar.

**Pipes between cards.** The ↓ button on a card feeds its output to the next command's stdin, and a dashed blue edge links the two. This lets you rerun the downstream step without rerunning the expensive one.

**Real shell on every branch.** Each branch has one long-lived interactive shell, loaded with your normal rc files. `export`, `cd`, `source .venv/bin/activate`, `nvm use`, aliases and functions all carry over to the next card. Branching from an earlier card starts a new shell with that card's directory and exported variables, so later changes on the old branch don't leak in. A card's environment is saved with the session, so you can keep branching from it after restarting Loom.

**Live terminals.** While a command runs, its card is a real terminal: type straight into `python3`, `sudo`, `npm init` or `ssh`. Programs that take over the screen (vim, top, less, man, fzf) expand into a large overlay and return to the card when they exit. A finished card turns back into light, selectable text and keeps only what stayed on the normal screen.
- A new running card takes the keyboard unless you've started typing in the composer. Press Esc twice, or ⌘/Ctrl+Shift+E, to give it back.
- The Expand button opens any running card in the overlay.
- Below 60% zoom, or when off-screen, a running card shows a snapshot instead of a live terminal.
- What you type into a terminal is never stored.

**A command bar that knows your shell.** The bar is a multi-line editor with zsh-style conveniences, using the active card's folder and branch shell as context.
- **Highlighting.** Commands are red when nothing on that card's `PATH`, and no alias, function or builtin of its shell, has that name. Flags, strings, variables, operators, comments and globs have their own colors, and arguments that are existing paths are underlined.
- **Tab completion** in a popup: files and folders (spaces escaped, folders reopen the list), commands, git branches, tags, remotes and changed files, `npm`/`pnpm`/`yarn`/`bun run` scripts, `make` targets, `ssh`/`scp` hosts from `~/.ssh/config` and `known_hosts`, docker containers, PIDs for `kill`, and `$VARIABLES`. Flags and subcommands for about 700 other tools come from [Fig's open-source specs](https://github.com/withfig/autocomplete) with their descriptions.
- **Ghost text** after the caret: the best earlier command that starts with what you typed, preferring ones run in this folder and ones that worked. → accepts it, Alt/Option+→ one word. A command that failed with "command not found" is never suggested.
- **Ctrl+R** searches history fuzzily. Each result shows its folder, exit status and age. Press Ctrl+R again to switch between this branch, this folder and everything.
- **Multi-line editing.** Enter runs the command unless it's unfinished (an open quote or `$(`, a trailing `\`, `|`, `&&` or `||`, or a heredoc without its terminator), in which case it adds a line. Pasted scripts never run until you press Enter.
- **History** lives in `userData/history.jsonl` (20,000 commands, with folder, exit code, duration and branch). Like zsh and bash with `ignorespace`, **a command that starts with a space isn't recorded**. Its card still appears on the canvas and in the map like any other. On first launch Loom offers once to import `~/.zsh_history` and `~/.bash_history`. It only reads them, and you can import later from Settings.

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
- Press **⌘/Ctrl+I** in the composer, or start a line with `?`, to describe what you want in plain English. Claude sees your OS, shell, current folder, the files in it and the recent commands on this branch.
- Claude suggests one command with an explanation and a risk level (safe / caution / destructive). Destructive commands need a second confirmation before they run.
- When you're piping, Claude is told the command will read the previous card's output.
- Failed cards offer **Explain with Claude**, which returns a short diagnosis plus a fix you can run as a child card.

**Big output.** A card keeps up to 1 GB of output (Settings), all of it scrollable, and finished cards render only the lines in view. **⌘/Ctrl+F** searches a card's whole output and jumps between matches. Card actions copy the output, save it to a file (**Save output…**) or open it in your editor. Past the per-card limit a card stops recording (the command keeps running); past the total (5 GB by default) the oldest cards' output is removed.

**History as a map.** **Map** (⌘/Ctrl+B) opens a branch-aware outline of everything you've run. Branches indent where they fork, and you can search the outline. Click any entry to fly to its card. The minimap in the corner shows the whole canvas; click a card on it to go there, or drag to navigate. Your session, including output, is saved and restored between launches. Below 55% zoom cards become pills (status, command, duration), and below 25% the canvas is drawn as one picture, so a session of thousands of cards stays smooth.

## Keyboard

| Keys | Action |
|---|---|
| Enter | Run (or ask Claude, in ✦ mode). Adds a line if the command is unfinished |
| Shift+Enter | New line |
| Tab | Complete. With one match it's inserted; with a shared prefix, the prefix is |
| ↑ / ↓ · Tab / Shift+Tab | Move in the completion list (Enter accepts, Esc closes) |
| → or End | Accept the ghost suggestion |
| Alt/Option+→ | Accept one word of it |
| ↑ / ↓ | History filtered by what you've typed, when the caret is on the first / last line; otherwise they move the caret |
| Ctrl+R | Search history. Ctrl+R again changes scope; Enter edits, Shift+Enter runs |
| ⌘/Ctrl+I | Toggle shell / ask Claude |
| ⌘/Ctrl+Z | Undo, including completions and accepted suggestions |
| Ctrl+C | Stop the active card's process (from the composer) |
| Ctrl+D | Send EOF to the active process (from the composer) |
| Esc | Close popup → dismiss suggestion → cancel pipe → clear input |
| ⌘/Ctrl+K or `/` | Focus the composer |
| Alt+↑ / ↓ / ← / → | Move to parent / child / sibling card |
| ⌘/Ctrl+0 | Fit everything |
| ⌘/Ctrl+N | Start a new root |
| ⌘/Ctrl+B | Toggle the map |
| ⌘/Ctrl+F | Find in the active card's output (Enter / Shift+Enter: next / previous) |
| PageUp/PageDown, Home/End | Scroll a card's output when it has focus |
| ⌘/Ctrl+T | New tab, in this tab's folder |
| ⌘/Ctrl+W | Close the tab (asks if something is running) |
| ⌘/Ctrl+Shift+T | Reopen the last closed tab |
| ⌘/Ctrl+1 … 8, ⌘/Ctrl+9 | Go to tab 1 … 8, or the last tab |
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous tab (also ⌘⇧] / ⌘⇧[ on macOS) |
| ⌘/Ctrl+Shift+P | Command palette |
| ⌘/Ctrl+, | Settings |
| ⌘/Ctrl+Shift+= / - / 0 | Bigger / smaller / default text |
| Ctrl+` (anywhere) | Show or hide the dropdown terminal |
| Esc Esc (dropdown) | Hide the dropdown |

All of these are commands, and Settings → Keys rebinds any of them.

In a live terminal, every key goes to the program, including Ctrl+C, Ctrl+D, Ctrl+W, Ctrl+R, Ctrl+Z, arrows, Tab and Esc. Only commands marked global (and, on macOS, ⌘ shortcuts) reach Loom:

| Keys | Action |
|---|---|
| Esc Esc | Return to the canvas and composer (the first Esc still reaches the program) |
| ⌘/Ctrl+Shift+E | Return to the canvas and composer |
| ⌘/Ctrl+Shift+F | Find in the terminal |
| ⌘/Ctrl+Shift+P, ⌘/Ctrl+, | Command palette, settings |
| ⌘/Ctrl+Shift+= / - / 0 | Text size |
| ⌘ shortcuts (macOS) | Work as usual, including ⌘T and ⌘W. On Linux and Windows, Ctrl+T, Ctrl+W and the like go to the program. |
| Ctrl+Shift+C | Copy the selection |

## How it's built

There's no bundler or framework. The runtime dependencies are `node-pty`, a native module that `postinstall` rebuilds for Electron; xterm.js with its fit, webgl, unicode11, web-links and search addons, which `postinstall` copies to `renderer/vendor/` (`scripts/vendor.js`) so plain `<script>` tags work under `script-src 'self'`; and `@withfig/autocomplete` (MIT), whose ES-module specs `main.js` loads on demand with `import()`.

```
main.js       Electron main: single instance and arguments, the main and dropdown windows,
              routes commands, fs/git queries for rich views, Claude API calls, settings,
              themes, keybindings, tabs, notifications, the menu, the one-process-per-card fallback
themes/       the built-in themes (JSON)
electron-builder.yml  packaging: targets, files, Info.plist, the deb's scripts
build/        icon.svg and the icons made from it, entitlements, bin/loom (the launcher
              inside the app), linux/after-{install,remove}.sh, after-pack.js
lib/
  env.js      .env (project or userData), the login shell's PATH with fallbacks, the locale
  package-check.js  what must never be packaged (used by check:package and the tests)
  args.js     command-line arguments and loom:// URLs
  settings.js settings.json: schema, defaults, validation
  themes.js   theme files, derived UI colors, contrast check, .itermcolors and Windows Terminal import
  tabs.js     tabs.json and one file per canvas; migrating the old session.json
  launcher.js the `loom` script, the Finder Quick Action, Linux file-manager entries
  sessions.js PTY shell sessions: shell integration, OSC stream parser, branch → session,
              the hidden alias/function/builtin helper
  shellinfo.js  PATH executables, env snapshots → variables, the rc files' definitions
  complete.js   completion providers and the Fig spec walker
  history.js    history.jsonl, zsh/bash history parsers
  outputs.js    each card's output file, its line index, range reads, caps and eviction
  relay.js      running cards' output to the renderer: per-frame batches, flow control
  search-worker.js  full-output search in a worker thread
preload.js    contextBridge API (the renderer has no Node access)
renderer/
  app.js      tabs and canvases, cards, layout, composer, Claude flows, map, minimap, persistence
  commands.js the command registry, the one keydown dispatcher, the command palette
  keys.js     key parsing, `when` contexts, keybindings.json, conflicts (also require()d by tests)
  tabbar.js   the tab strip
  settings-page.js  the settings page
  theme.js    applies a theme and the fonts to the page, xterm and the git graph
  editor.js   command bar: highlighted textarea, ghost text, completion popup, Ctrl+R
  shell-lex.js  shell lexer: tokens, isIncomplete, contextAt (also require()d by main and tests)
  fuzzy.js    fuzzy match, history ranking, ghost suggestions (also require()d by tests)
  terminals.js  terminal model per running card, live views, overlay, buffer → text
  vlines.js   finished output, virtualized: rows from main, wrapping, colors, copy, find
  wrap.js     wcwidth and rows per line (also require()d by main and tests)
  spatial.js  grid index of card rectangles (also require()d by tests)
  detect-worker.js  rich-view detection and parsing, in a Web Worker
  bench.js    the renderer half of npm run bench
  views.js    rich-view detection + renderers (files, JSON, tables, git graph, git status)
  ansi.js     ANSI color → HTML
  styles.css  layout and components; colors are the theme's CSS variables
test/
  *.test.js   unit tests (npm test): stream parser, shell lexer, history and ranking, completion
              providers, output storage, wrapping, the spatial index, arguments, keybindings,
              themes and contrast, tab storage and migration, the launcher
  e2e.js          LOOM_SMOKE run per shell, then a restart, the `loom` command against the running
                  Loom, and an old-session migration (npm run e2e; xvfb-run on Linux)
scripts/
  dist.js         npm run dist: decides on signing, builds the Finder helper, runs electron-builder
  check-package.js  npm run check:package
  icons.js        npm run icons: build/icon.svg → .icns, .ico, PNGs (renders in Electron)
  helper-app.js   builds "Open in Loom.app" with osacompile (macOS)
  smoke-packaged.js  installs a built dmg (or runs an AppImage) and tests it as launched from Finder
  bench.js        npm run bench
  gen-fixture.js  generates a 1,000-card (or larger) session for the bench
```

**Tabs and windows.** A card's key is `<canvas>.<card>`: output files, shell snapshots and sessions are keyed by it, so tabs never share a shell, and a card's events go to the window showing its canvas. Each canvas is saved in `userData/canvases/<id>.json`; `userData/tabs.json` has each window's tab order, active tab and last ten closed tabs, and each tab's title, color and folder. The old `session.json` becomes the first tab on first launch (kept as `session.pre-tabs.json`). Only the visible tab has DOM: switching saves it, takes its DOM down, and builds the other from its data (a few milliseconds for 20 tabs). Background tabs' running cards stream nothing to the page; main records them, and a card coming back on screen gets a replay. The dropdown is a second window, `index.html?window=dropdown`, with its own tabs in `tabs.json`.

**Keys.** `renderer/commands.js` holds every command: `{ id, title, category, keys, when, global, run }`. One keydown listener (capture phase) asks `renderer/keys.js` which command a key means in its context — `canvas`, `commandBar`, `liveTerminal`, `overlay` or `dialog` — after applying keybindings.json. In the command bar the editor sees keys first, for completion, ghost text and history. In a live terminal only global commands fire, and on macOS ⌘ shortcuts. The application menu runs the same commands and shows their current keys, without registering them as accelerators, so a menu never takes a key from a program.

**Output.** Main records every byte a card prints in `userData/outputs/<canvas>.<card>.log` (line endings as `\n`), whether or not anything is on screen.
- `lib/outputs.js` keeps an index per card: the byte offset of every 256th line, the SGR (color) state at each of those lines, and the extent in cells of every line wider than 32 cells, 2 bytes a line in blocks that have one. That's enough to read any range of lines in one seek, render it in color, and know the row count of the whole output at any card width without reading it. The index is saved next to the log (`<id>.idx`) when a card ends and rebuilt from the log if it's missing.
- `renderer/wrap.js` defines how a line wraps (tabs every 8 cells, a wcwidth table for CJK, emoji and combining marks, `\r` overwrites and backspaces applied first). Main and the card body use the same code, so main's row counts match what the page draws.
- A finished card's body is `renderer/vlines.js`: only the rows in view plus 40 rows of overscan are in the DOM, fetched from main in chunks of 128 rows (`out:view`) and kept in a small cache. Scrolling is its own (wheel, keys, a drawn scrollbar), because a browser can't scroll an element billions of pixels tall. Copy works from model coordinates, so a selection whose start has scrolled out of the DOM still copies whole, from main (`out:range`).
- ⌘/Ctrl+F runs `lib/search-worker.js` in a worker thread over the file, with the same line splitting as the index, and returns match lines; the card asks main which row each one is at.
- Copy output, pipes between cards, Save output… and Open in editor stream the visible text from the file in main. Rich views ask for the first 4 MB; Explain with Claude gets the head and tail.

**Streaming.** `lib/relay.js` sends a running card's output to the page only while the page watches it: the card is on screen at 55% zoom or more, has a live view, is in the overlay, or is on the alternate screen. Off-screen cards cost the page nothing, and a card coming back into view gets a replay of its screen from main.
- At most one message per card per frame, 128 KB at most. The page acknowledges what xterm has parsed; past 1 MB unacknowledged, a program that moves the cursor has its PTY paused until it's under 256 KB.
- Plain line output isn't paused: it runs at full speed into the file, and each frame the view gets the newest 64 KB, more than a screen shows.
- When a card ends, the file is its text, unless the program moved the cursor (progress bars with cursor-up, `top`, `clear`): then the normal-screen buffer of its terminal model is, as before, and replaces the file.

**Canvas.** The tree (children, depth) is kept up to date on add, remove and reparent. Card heights come from a ResizeObserver and are saved, so layout never reads the DOM. A grid of 512 px buckets (`renderer/spatial.js`) answers placement overlap checks, culling and minimap hit tests.
- Cards near the view have their DOM. Within a few screens they're empty boxes of the same size; further out they're out of the DOM (layout and edges use the grid). Mounting is spread over frames, nearest first.
- Edges are one SVG path each; only edges with a moved end get a new path, and only edges near the view are in the SVG.
- The minimap's cards are drawn into an offscreen canvas, again only when cards change; pan and zoom redraw the viewport rectangle. The history map is a virtual list.
- Rich-view detection and parsing (JSON, CSV/TSV, column tables, git log and status) run in `renderer/detect-worker.js`, a Web Worker with its own MessagePort to main, so the output never passes through the page. Parsed JSON and tables stay in the worker; the JSON tree asks for a node's children when opened, and tables render only the rows in view, sorted in the worker.

**Saving.** Each canvas file holds card metadata only. The page sends main the cards that changed, and main writes the file debounced, atomically, and only when its contents changed. Sessions from before output files are migrated on first launch (their inline output becomes files; the old file is kept as `session.v1.json`), and then into the first tab.

**Bench.** `npm run bench` launches Loom three times with the LOOM_SMOKE harness (under `xvfb-run` on Linux) and checks the budgets: no task over 50 ms while `seq 1 3000000` and `yes` (200 B × 1,000,000 lines) stream, 60 fps panning and zooming a generated 1,000-card session, first paint under 1.5 s, and main plus renderer under 600 MB while a card takes 1 GB. It also measures time to idle, the history map with 20,000 cards, and keystroke latency during streams. It prints a table, appends the run to `bench-results.json` (compared with the previous run), and exits 1 if a budget is missed by more than 25%. `--only stream|startup|map` runs one part; `--label` names the run.

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

**Terminals.** `renderer/terminals.js` gives every running card an xterm `Terminal`.
- The Terminal starts unattached to the DOM, as a model that interprets redraws. A quick command is over before it's ever opened, so it costs little.
- A card that's active for 150 ms, or clicked, gets a live view: the same Terminal opened in `#live-layer`, an unscaled layer over the card. It's repositioned on pan and zoom, and the font size follows the zoom, because xterm blurs and misplaces the mouse under CSS transforms.
- At most 8 live views exist at once, each with a WebGL context (xterm's default renderer takes over if WebGL fails). The least recently focused goes back to model plus snapshot.
- The alternate screen is detected from the Terminal's own buffer switch, which covers `?1049h`, `?47h` and `?1047h` and can't be fooled by a split chunk.
- The fit addon sizes each view, and `cmd:resize` resizes that card's PTY only. Every card starts at 120×40, so a command that finishes quickly prints at full width, even in a narrower card.
- When a card ends, its text comes from one of two places. Output with no cursor movement keeps its raw text, which preserves tabs for tables and pipes and isn't limited by scrollback. Anything else is read from the normal-screen buffer. Either way it's stored as text with SGR colors, so Copy, pipes, rich views and the HTML renderer work as before.
- Output reaches the renderer as raw PTY bytes with acknowledgements. Past 2 MB unacknowledged, the PTY pauses, so a program that floods output slows down as it would in a terminal, and long-lived programs are never cut off.
- `PAGER` and `GIT_PAGER` stay `cat` so `git log` produces a finished card, while `MANPAGER` defaults to `less` so `man` is interactive. **Settings → Use a real pager** drops the `cat` default; idle shells pick it up by being recreated from their snapshots.

**Command bar.** `renderer/editor.js` keeps a `<textarea>` with transparent text over a `<pre>` that shows the same text highlighted, with identical font, padding and wrapping. The browser still owns the caret, selection, IME and undo. Insertions use `execCommand('insertText')` so they're undoable.
- `shell-lex.js` is a lexer, not a parser. It tracks quotes, `$(…)`, `${…}`, backticks, subshells, groups and heredocs well enough to color a line, decide whether Enter should add a line, and say which command, argument index and partial word the caret is in. Words after `|`, `&&`, `;`, `sudo`, `env`, `time`, `xargs` and `VAR=value` are in command position.
- Aliases, functions and builtins come from the branch's own shell. Loom sources a small helper between cards with its output in a file, so no card sees it, and `$?` is passed through unchanged. It runs once per shell, and again after a card that could change them (`alias`, `source`, `nvm`…). Cards without an idle shell use a one-off interactive shell run at startup. `PATH` executables are cached per `PATH` and rescanned every 60 s. A card's `PATH` and variables come from its env snapshot, so a venv's tools count on the cards that use it. Only command names reach the renderer, never variable values.
- Completion runs in `main.js` (`lib/complete.js`), with the active card's folder and environment. A new request cancels the one in flight, and the renderer ignores late answers. Fig specs are loaded with `import()` on first use and cached. Their generators that run a script are run in the card's folder with a 2 s timeout, and their results are cached for 5 s. `custom` generators, arbitrary JS that drives its own shell commands, are skipped.
- Existing-path underlines are checked in batches over IPC after 120 ms and cached for 5 s.

The ls and git views query the file system and git directly for structured data instead of parsing text.

## Known limits / next steps

- **Releases aren't signed or notarized yet**, so macOS needs the right-click → Open step, and there are no automatic updates or CI builds yet (the next step, once the repo's releases exist). **Check for Updates…** links to the Releases page.
- **Only the macOS arm64 build has been built and tested.** The Intel Mac, Linux AppImage and deb builds are configured but need their own machines (node-pty is compiled for each), and the deb's install scripts (the `/usr/bin/loom` link, the `x-terminal-emulator` alternative) haven't been run on a Debian system. Windows builds an NSIS installer from the same config, but Loom there runs one PowerShell process per card, without shell sessions, and hasn't been tested.
- **An installed app and `npm start` share `~/Library/Application Support/Loom`** (`~/.config/Loom` on Linux), so they see the same tabs and settings. Don't run both at once: the second hands its folder to the first.
- **The login shell's PATH is asked for at startup, for 4 seconds at most.** A shell whose rc files take longer falls back to the process's PATH plus the usual tool folders (Homebrew, nvm's newest node, pyenv, cargo, `~/.local/bin`…); the shells in your tabs still run your rc files in full.
- **LOOM_SMOKE in an installed app** turns on the e2e harness (that's how CI tests the packaged app). It only does when that variable is set, with a separate userData unless told otherwise.

- **Closing the main window on macOS hides it**, so its tabs and their running commands carry on; ⌘Q quits (asking first if commands are running). Elsewhere closing the window quits.
- **Hiding the dropdown on macOS hides Loom** (`app.hide()`) when another app was in front before it showed, which is how focus goes back to that app. The main window comes back with Loom's Dock icon.
- **The global hotkey wasn't pressed in the e2e run.** Its registration is checked, and the same toggle it calls is driven, but a real key press from another app needs accessibility permissions the test can't get.
- **Notifications** use the OS's; on macOS the first one may ask for permission, and from a checkout they're attributed to Electron.
- **Text-editing keys aren't commands.** Enter, Shift+Enter, Tab completion, ↑/↓ history and → for ghost text belong to the command bar and can't be rebound.
- **Ligatures** apply to cards and the command bar. Live terminals (xterm) draw without them.
- **Imported themes get derived UI colors.** An .itermcolors or Windows Terminal scheme only has terminal colors; Loom works out the rest from its background, foreground and ANSI colors, keeping secondary text at AA contrast where the scheme allows.
- **A recorded shortcut is saved for this platform** (`Shift+Cmd+F` on macOS). Write `Mod+Shift+F` by hand in keybindings.json for one that works on both.
- **Loom can't tell which app owns a hotkey.** If the dropdown's hotkey is taken, Settings says so but not by whom.

- **ssh cards stay running until ssh exits.** Shell-integration markers don't come back from the remote shell, so the remote session is one card, and remote commands aren't split into cards.
- **A long-running card takes the keyboard from an empty composer**, so running a second command beside it starts with Esc Esc. Keys typed in the 150 ms before that also go to the card, so a typed-ahead password can't become a command. If the command finishes first, those keys are lost.
- **Ctrl+Z ends the card.** The shell regains control and the card finishes with exit 148, or 20 in some shells. The job stays suspended in the branch's shell, so a child card can run `fg` or `kill %1`.
- **Output that moves the cursor** keeps what the terminal's normal screen held: the last 10,000 lines. Plain output keeps everything up to the per-card limit.
- **A running card's live view skips ahead during a flood.** Its scrollback has gaps; the finished card has every line.
- **Lines longer than 16 KB are split** in the index. They show as wrapped rows, copy joins them back, but a search match that spans the split isn't found.
- **Memory is mostly fixed cost.** Main plus renderer idle at about 300 MB, and a live terminal's WebGL context adds about 100 MB; a 1 GB card adds little on top (see the bench). The GPU process isn't counted in the budget.
- **Copy of a whole output stops at 32 MB**; Save output… has no limit. Open in editor exports text with colors stripped when the log has escape codes.
- **Far-away cards aren't in the DOM**, so the browser's own find (there isn't one in Loom) or screen readers only see cards near the view.
- **Echoed input is output.** Passwords that a program hides are never seen, but anything the program echoes back lands on the card and in the session file, as it would in a terminal's scrollback.
- A live terminal sits above other cards, even one dragged over it.
- **stdout and stderr are merged.** A PTY has one stream, so errors are no longer tinted and a card-to-card pipe carries both.
- **A fork inherits exported variables only.** Unexported variables, functions and aliases defined in a card, and `set`/`setopt` changes, stay in that card's shell. So a forked venv works, but its `deactivate` function isn't there. A variable your rc exports and a card `unset`s comes back in a fork. A session recreated after eviction or a restart has the same limits.
- **Snapshots contain your exported environment in plain text**, including any tokens, in `userData/envs` (user-only permissions). They're removed with their card. The canvas files only hold their paths.
- **Background jobs share the terminal.** A `&` job's output lands in whichever card is running when it prints, and is dropped between commands.
- **Completion is prefix-first.** Fuzzy matches only show when nothing matches the prefix, so `cd sr` completes straight to `src/` and doesn't also offer `scripts/`.
- **The lexer doesn't know `case` patterns, arrays (`a=(1 2)`) or process substitution `<(…)`.** Coloring can be off inside them, and a `)` in a `case` pattern inside `$(…)` closes it early.
- **Fig specs** cover what's in `@withfig/autocomplete` 2.692. Versioned specs (`generateSpec`) use their static part, and `custom` generators are skipped, so a few tools offer fewer values than they did in Fig.
- **Ctrl+R's "This branch"** means the tree of cards under the active card's root. Imported commands have no branch or folder, so they only show under All.
- **Commands don't enter your shell history.** Loom turns history off in its sessions so its temp-script lines stay out of `~/.zsh_history` and `~/.bash_history`.
- `exit` and `set -e` end a branch's shell, as they would a terminal window. The next card starts a new shell from the nearest snapshot.
- A prompt theme that rewrites the prompt after Loom's hook loses the 133;B marker. Loom then treats 133;A plus 150 ms as ready, so this only costs a little latency.
- A program that printed at a narrower live width keeps its own line breaks. Finished cards rewrap when resized.
- **Force color** now only affects the fallback path, since session commands are on a real terminal.
- Ideas that fit the model:
  - Sticky notes on the canvas
  - Saved "recipes": a branch replayed as a script
  - Diff two cards' outputs
  - Watch mode that reruns a card on an interval
