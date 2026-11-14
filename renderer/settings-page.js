'use strict';
// Loom — the settings page (⌘/Ctrl+,). Every change is saved to settings.json
// by main and applied at once; editing the file by hand works too, and its
// errors show at the top. Keys records shortcuts into keybindings.json.
(function (g) {
  const SECTIONS = [
    ['general', 'General'], ['appearance', 'Appearance'], ['terminal', 'Terminal'], ['keys', 'Keys'],
    ['dropdown', 'Dropdown'], ['claude', 'Claude'], ['integrations', 'Integrations'],
  ];

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // opts: api, el, registry, mac, toast, onClose(), actions: { importHistory, clearCanvas, showDropdown }
  function create(opts) {
    const { api, el, registry, mac } = opts;
    let page = null; // from main: { settings, errors, hasKey, keyFromEnv, shell, hotkey, file }
    let themes = { themes: [], errors: [] };
    let integrations = null;
    let section = 'general';
    let note = '';
    let keyFilter = '';
    let recordingId = null;
    let fonts = [];
    let back = null;

    el.innerHTML = `<div class="set-shell">
      <nav class="set-nav">${SECTIONS.map(([id, label]) => `<button data-sec="${id}">${label}</button>`).join('')}</nav>
      <div class="set-main">
        <div class="set-top"><h2></h2><div class="spacer"></div>
          <button class="set-json">Edit settings.json</button><button class="set-close" title="Close (Esc)">×</button></div>
        <div class="set-errors" hidden></div>
        <div class="set-note" hidden></div>
        <div class="set-body"></div>
      </div></div>`;
    const q = (s) => el.querySelector(s);
    const body = q('.set-body');

    const s = () => (page ? page.settings : {});
    async function set(patch) {
      const res = await api.setSettings(patch);
      if (res && res.errors && res.errors.length) opts.toast(res.errors.join('; '), { kind: 'err' });
    }

    // ------------------------------------------------------------ fields
    const field = (label, control, help = '') => `<label class="set-field"><span class="set-label">${label}</span>${control}${help ? `<span class="set-help">${help}</span>` : ''}</label>`;
    const check = (key, label, help = '') => `<label class="set-check"><input type="checkbox" data-key="${key}" ${s()[key] ? 'checked' : ''}><span><span class="set-label">${label}</span>${help ? `<span class="set-help">${help}</span>` : ''}</span></label>`;
    const text = (key, label, { placeholder = '', help = '', type = 'text', step, min, max } = {}) => field(label,
      `<input data-key="${key}" type="${type}" value="${esc(s()[key] ?? '')}" placeholder="${esc(placeholder)}" spellcheck="false"${step ? ` step="${step}"` : ''}${min != null ? ` min="${min}"` : ''}${max != null ? ` max="${max}"` : ''}>`, help);
    const select = (key, label, options, help = '') => field(label,
      `<select data-key="${key}">${options.map(([v, l]) => `<option value="${esc(v)}" ${String(s()[key]) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`, help);

    function contrastNote(id) {
      const t = themes.themes.find((x) => x.id === id);
      if (!t || !t.contrast.length) return '';
      return `<span class="set-warn">⚠ ${esc(t.name)} is below WCAG AA (4.5:1) for ${t.contrast.map((c) => `${c.what.toLowerCase()} (${c.ratio}:1)`).join(', ')}.</span>`;
    }
    function themeOptions(prefer) {
      const list = [...themes.themes].sort((a, b) => (a.type === prefer ? 0 : 1) - (b.type === prefer ? 0 : 1) || a.name.localeCompare(b.name));
      return list.map((t) => [t.id, `${t.name}${t.contrast.length ? ' ⚠' : ''}${t.builtin ? '' : ' (yours)'}`]);
    }

    function renderGeneral() {
      return `${field('Default folder for new tabs', `<span class="set-row"><input data-key="defaultFolder" value="${esc(s().defaultFolder)}" placeholder="Your home folder" spellcheck="false"><button data-act="pickFolder">Choose…</button></span>`)}
        ${check('restoreTabs', 'Restore tabs on launch', 'Off: Loom starts with one fresh tab, and the old ones are under Reopen closed tab.')}
        ${check('notifications', 'Notify when a long command finishes', 'For commands over 10 seconds that finish while Loom isn\'t in front. Click it to go to the card.')}
        ${check('confirmQuit', 'Confirm before quitting with commands running')}
        <div class="set-actions"><button data-act="importHistory">Import ~/.zsh_history and ~/.bash_history</button><span class="set-help">Read only. Loom never writes to them.</span></div>
        <div class="set-actions"><button data-act="clearCanvas" class="danger-ghost">Clear this tab's canvas</button></div>`;
    }

    function renderAppearance() {
      const fontList = fonts.length ? `<datalist id="set-fonts">${fonts.map((f) => `<option value="${esc(f)}">`).join('')}</datalist>` : '';
      return `<h3>Theme</h3>
        ${select('themeMode', 'Mode', [['system', 'Follow the system'], ['light', 'Always light'], ['dark', 'Always dark']])}
        ${select('themeLight', 'Light theme', themeOptions('light'), contrastNote(s().themeLight))}
        ${select('themeDark', 'Dark theme', themeOptions('dark'), contrastNote(s().themeDark))}
        <div class="set-actions"><button data-act="importTheme">Import theme…</button><button data-act="themeFolder">Open themes folder</button>
          <span class="set-help">.itermcolors, Windows Terminal schemes, or Loom theme JSON. Files in the folder are picked up as they change.</span></div>
        ${themes.errors.length ? `<div class="set-warn">${themes.errors.map(esc).join('<br>')}</div>` : ''}
        <h3>Font</h3>
        ${field('Family', `<input data-key="fontFamily" list="set-fonts" value="${esc(s().fontFamily)}" placeholder="JetBrains Mono, SF Mono, Menlo…" spellcheck="false">${fontList}`, fonts.length ? `${fonts.length} monospace fonts installed. Type any name.` : 'Type a font name.')}
        <div class="set-grid">
          ${text('fontSize', 'Size', { type: 'number', step: 0.5, min: 8, max: 32 })}
          ${text('lineHeight', 'Line height', { type: 'number', step: 0.05, min: 1, max: 2.5 })}
          ${select('fontWeight', 'Weight', [[300, 'Light'], [400, 'Regular'], [500, 'Medium'], [600, 'Semibold'], [700, 'Bold']])}
        </div>
        ${check('ligatures', 'Ligatures', 'Cards and the command bar. Live terminals draw without them.')}
        <p class="set-help">${registry.label(registry.keysFor('font.bigger')[0] || '')} / ${registry.label(registry.keysFor('font.smaller')[0] || '')} / ${registry.label(registry.keysFor('font.reset')[0] || '')} change the size anywhere.</p>`;
    }

    function renderTerminal() {
      return `${text('shell', 'Shell', { placeholder: page ? page.shell : '', help: 'bash or zsh get Loom\'s shell integration. Others run one process per card. New shells use it; running ones keep theirs.' })}
        ${field('Shell arguments', `<input data-key="shellArgs" value="${esc((s().shellArgs || []).join(' '))}" placeholder="none" spellcheck="false">`, 'Added after Loom\'s own (-l -i for zsh). Separated by spaces.')}
        <div class="set-grid">
          ${select('cursorStyle', 'Cursor', [['block', 'Block'], ['bar', 'Bar'], ['underline', 'Underline']])}
          ${text('scrollback', 'Live scrollback (lines)', { type: 'number', min: 100, max: 200000, step: 1000 })}
        </div>
        ${check('cursorBlink', 'Blinking cursor')}
        <div class="set-grid">
          ${text('outputCapGB', 'Output per card (GB)', { type: 'number', step: 0.5, min: 0.01 })}
          ${text('outputTotalGB', 'Output for all cards (GB)', { type: 'number', step: 1, min: 0.01 })}
        </div>
        <p class="set-help">Past the first, a card stops recording (the command keeps running). Past the second, the oldest cards' output is removed.</p>
        ${check('realPager', 'Use a real pager', 'git log and the like open your pager in a live terminal, and get no rich views or finished cards until you quit it.')}
        ${check('forceColor', 'Force color output', 'Only for the one-process-per-card fallback. Can break in-command pipes like <code>git branch | xargs</code>.')}`;
    }

    function renderKeys() {
      const conflicts = registry.conflicts();
      const rows = registry.list().filter((c) => c.palette !== false || c.keys.length).filter((c) => {
        if (!keyFilter) return true;
        const hay = `${c.category} ${c.title} ${c.keys.map(registry.label).join(' ')} ${c.id}`.toLowerCase();
        return keyFilter.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
      }).sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.title.localeCompare(b.title));
      const user = new Set(registry.overrides().map((o) => o.command.replace(/^-/, '')));
      const errs = registry.errors();
      return `<div class="set-row"><input class="keys-filter" placeholder="Search commands and keys" value="${esc(keyFilter)}" spellcheck="false"><button data-act="editKeys">Edit keybindings.json</button></div>
        ${errs.length ? `<div class="set-warn">${errs.map(esc).join('<br>')}</div>` : ''}
        <div class="keys-list">${rows.map((c) => {
          const clash = conflicts.filter((x) => x.commands.includes(c.id));
          const others = clash.map((x) => `${registry.label(x.key)} is also ${esc(registry.get(x.commands.find((y) => y !== c.id)).title)} (${x.winner === c.id ? 'this wins' : 'that wins'})`);
          return `<div class="key-row${clash.length ? ' conflict' : ''}" data-id="${esc(c.id)}">
            <span class="key-title"><span class="key-cat">${esc(c.category || '')}</span>${esc(c.title)}${c.global ? '<span class="key-global" title="Works in live terminals too">global</span>' : ''}</span>
            <span class="key-keys">${recordingId === c.id ? '<kbd class="recording">Press a shortcut… (Esc cancels)</kbd>' : c.keys.map((k) => `<kbd>${esc(registry.label(k))}</kbd>`).join('') || '<span class="set-help">—</span>'}</span>
            <span class="key-acts"><button data-act="record">Record</button>${user.has(c.id) ? '<button data-act="resetKey">Reset</button>' : ''}</span>
            ${others.length ? `<span class="key-warn">⚠ ${others.join('; ')}</span>` : ''}
          </div>`;
        }).join('')}</div>`;
    }

    function renderDropdown() {
      const hk = page ? page.hotkey : { ok: false, error: null };
      return `${field('Hotkey', `<span class="set-row"><input data-key="dropdownHotkey" value="${esc(s().dropdownHotkey)}" spellcheck="false"><button data-act="recordHotkey">Record</button></span>`,
        hk.ok ? `${esc(hk.key)} is registered: it shows and hides the dropdown from any app.` : `<span class="set-warn">${esc(hk.error || 'Not registered.')}</span>`)}
        ${field('Height', `<span class="set-row"><input data-key="dropdownHeight" type="range" min="15" max="100" step="1" value="${Math.round(s().dropdownHeight * 100)}"><span class="set-help">${Math.round(s().dropdownHeight * 100)}% of the screen</span></span>`, 'You can also drag its bottom edge.')}
        ${check('dropdownHideOnBlur', 'Hide when it loses focus', 'Pin it from its tab bar to keep it open.')}
        <div class="set-actions"><button data-act="showDropdown">Show the dropdown</button></div>`;
    }

    function renderClaude() {
      const source = page && page.keySource ? (page.keySource === 'environment' ? 'Using ANTHROPIC_API_KEY from the environment' : `Using ANTHROPIC_API_KEY from ${page.keySource}`) : '';
      return `${field('Anthropic API key', `<span class="set-row"><input id="set-key" type="password" autocomplete="off" spellcheck="false" placeholder="${page && page.keyFromEnv ? esc(source) : page && page.hasKey ? 'Saved · leave blank to keep' : 'Your Anthropic API key'}"><button data-act="saveKey">Save</button>${page && page.hasKey && !page.keyFromEnv ? '<button data-act="removeKey">Remove</button>' : ''}</span>`, 'Stored with your OS keychain encryption when available. Never shown again or sent to the page.')}
        ${text('model', 'Model')}
        <div class="set-actions"><button data-act="openDotenv">Open .env file</button>
          <span class="set-help">${page && page.dotenv ? `<code>${esc(page.dotenv)}</code>. ` : ''}A key there (<code>ANTHROPIC_API_KEY=…</code>) is read when Loom needs it, and isn't passed to your shells.</span></div>`;
    }

    function renderIntegrations() {
      const st = integrations || {};
      const launcher = st.launcher
        ? `<p>Installed at <code>${esc(st.launcher)}</code>${st.onPath ? '' : ' — <span class="set-warn">that folder isn\'t on your PATH</span>'}.</p><div class="set-actions"><button data-act="installLauncher">Reinstall</button><button data-act="uninstallLauncher">Uninstall</button></div>`
        : '<div class="set-actions"><button data-act="installLauncher" class="primary">Install \'loom\' command in PATH</button></div>';
      let files = '';
      if (st.platform === 'darwin') {
        files = `<h3>Finder</h3><p class="set-help">Adds “Open in Loom” to the Quick Actions and Services menus when you right-click a folder. Folders dropped on Loom's Dock icon open too.</p>
          <div class="set-actions">${st.quickAction ? '<button data-act="installFinder">Reinstall Quick Action</button><button data-act="uninstallFinder">Remove</button>' : '<button data-act="installFinder">Install Finder Quick Action</button>'}</div>`;
      } else if (st.platform === 'linux') {
        files = `<h3>File managers</h3><p class="set-help">Adds “Open in Loom” to Files (Nautilus), Nemo and Dolphin, and Loom as an application for folders.</p>
          <div class="set-actions">${st.linux ? '<button data-act="installLinux">Reinstall</button><button data-act="uninstallLinux">Remove</button>' : '<button data-act="installLinux">Install “Open in Loom”</button>'}</div>`;
      } else {
        files = '<p class="set-help">A folder context-menu entry for Windows Explorer isn\'t available yet.</p>';
      }
      return `<h3>The <code>loom</code> command</h3>
        <p class="set-help"><code>loom .</code> opens this folder in a tab (or goes to its tab), <code>loom -e "npm test"</code> runs a command there, <code>loom --new-tab</code> and <code>loom --dropdown</code> do what they say. It returns at once.</p>
        ${launcher}${files}`;
    }

    const RENDER = { general: renderGeneral, appearance: renderAppearance, terminal: renderTerminal, keys: renderKeys, dropdown: renderDropdown, claude: renderClaude, integrations: renderIntegrations };

    function render() {
      if (el.hidden) return;
      for (const b of el.querySelectorAll('.set-nav button')) b.classList.toggle('on', b.dataset.sec === section);
      q('.set-top h2').textContent = SECTIONS.find(([id]) => id === section)[1];
      const errs = page ? page.errors : [];
      q('.set-errors').hidden = !errs.length;
      q('.set-errors').innerHTML = errs.length ? `<b>settings.json has problems</b> — Loom is using the last good values:<br>${errs.map(esc).join('<br>')}` : '';
      q('.set-note').hidden = !note;
      q('.set-note').textContent = note;
      // Keep focus and caret in the field being typed in.
      const active = document.activeElement;
      const focusKey = active && el.contains(active) ? (active.dataset.key || (active.classList.contains('keys-filter') ? '__filter' : null)) : null;
      const caret = focusKey && active.selectionStart != null ? active.selectionStart : null;
      body.innerHTML = RENDER[section]();
      if (focusKey) {
        const again = focusKey === '__filter' ? body.querySelector('.keys-filter') : body.querySelector(`[data-key="${focusKey}"]`);
        if (again) { again.focus(); if (caret != null && again.setSelectionRange) try { again.setSelectionRange(caret, caret); } catch { /* number inputs */ } }
      }
    }

    // ------------------------------------------------------------ events
    el.addEventListener('click', async (e) => {
      const nav = e.target.closest('[data-sec]');
      if (nav) { show(nav.dataset.sec); return; }
      if (e.target.closest('.set-close')) { close(); return; }
      if (e.target.closest('.set-json')) { api.editSettings(); return; }
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      const row = b.closest('.key-row');
      const integ = async (fn, what) => {
        const res = await fn(what);
        integrations = res.status;
        render();
        if (res.ok === false) opts.toast(res.error, { kind: 'err', timeout: 8000 });
        else if (res.message) opts.toast(res.message, { timeout: 8000 });
        else if (res.removed) opts.toast(res.removed.length ? `Removed ${res.removed.join(', ')}` : 'Nothing to remove', { timeout: 4000 });
      };
      switch (act) {
        case 'pickFolder': { const p = await api.pickFolder(); if (p) set({ defaultFolder: p }); break; }
        case 'importHistory': close(); opts.actions.importHistory(); break;
        case 'clearCanvas': opts.actions.clearCanvas(); break;
        case 'importTheme': {
          const res = await api.themesImport({});
          if (!res) break;
          if (res.error) opts.toast(`Couldn't import: ${res.error}`, { kind: 'err' });
          else opts.toast(`Imported ${res.added.map((t) => t.name).join(', ')}${res.added.some((t) => t.contrast.length) ? ' (low contrast: see the ⚠)' : ''}`, { timeout: 4000 });
          break;
        }
        case 'themeFolder': api.themesFolder(); break;
        case 'editKeys': api.keysEdit(); break;
        case 'record': recordKey(row.dataset.id); break;
        case 'resetKey': resetKey(row.dataset.id); break;
        case 'recordHotkey':
          b.textContent = 'Press…';
          registry.record((key) => {
            if (key === 'Escape') { render(); return; }
            const accel = key.split('+').map((p) => ({ Cmd: 'Command', Ctrl: 'Control', Escape: 'Esc' }[p] || p)).join('+');
            set({ dropdownHotkey: accel });
          });
          break;
        case 'showDropdown': opts.actions.showDropdown(); break;
        case 'openDotenv': api.openDotenv(); break;
        case 'saveKey': { const v = q('#set-key').value.trim(); if (v) { await set({ apiKey: v }); opts.toast('API key saved', { timeout: 1600 }); } break; }
        case 'removeKey': await set({ apiKey: '' }); break;
        case 'installLauncher': integ(api.integrationsInstall, 'launcher'); break;
        case 'uninstallLauncher': integ(api.integrationsUninstall, 'launcher'); break;
        case 'installFinder': integ(api.integrationsInstall, 'finder'); break;
        case 'uninstallFinder': integ(api.integrationsUninstall, 'finder'); break;
        case 'installLinux': integ(api.integrationsInstall, 'linux'); break;
        case 'uninstallLinux': integ(api.integrationsUninstall, 'linux'); break;
        default:
      }
    });

    function valueOf(input) {
      const key = input.dataset.key;
      if (input.type === 'checkbox') return input.checked;
      if (key === 'shellArgs') return input.value.trim() ? input.value.trim().split(/\s+/) : [];
      if (key === 'dropdownHeight') return Number(input.value) / 100;
      if (input.type === 'number' || key === 'fontWeight') return Number(input.value);
      return input.value;
    }
    el.addEventListener('change', (e) => {
      const input = e.target.closest('[data-key]');
      if (input) set({ [input.dataset.key]: valueOf(input) });
    });
    el.addEventListener('input', (e) => {
      if (e.target.classList.contains('keys-filter')) { keyFilter = e.target.value; render(); }
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !recordingId && !e.defaultPrevented) { e.preventDefault(); close(); }
    });

    // ------------------------------------------------------------ keys
    // A recorded shortcut replaces the command's keys: its defaults are
    // removed ("-id") and the new key added, in keybindings.json.
    function recordKey(id) {
      recordingId = id;
      render();
      registry.record(async (key) => {
        recordingId = null;
        if (key === 'Escape') { render(); return; }
        const list = registry.overrides().filter((o) => o.command !== id && o.command !== `-${id}`);
        list.push({ command: `-${id}` }, { key, command: id });
        await api.keysSet(list);
        const clash = registry.conflicts().filter((x) => x.key === key && x.commands.includes(id));
        if (clash.length) opts.toast(`${registry.label(key)} is also ${clash.map((x) => registry.get(x.commands.find((y) => y !== id)).title).join(', ')}`, { kind: 'err', timeout: 6000 });
      });
    }
    async function resetKey(id) {
      await api.keysSet(registry.overrides().filter((o) => o.command !== id && o.command !== `-${id}`));
    }

    // ------------------------------------------------------------ open/close
    async function refresh() {
      [page, themes, integrations] = await Promise.all([api.getSettings(), api.themesList(), api.integrationsStatus()]);
      render();
    }
    function show(sec) {
      section = sec || section;
      if (section !== 'claude') note = '';
      render();
      if (section === 'appearance' && !fonts.length && g.Theme) g.Theme.monospaceFonts().then((f) => { fonts = f; if (section === 'appearance') render(); });
    }
    async function open(sec, msg = '') {
      if (el.hidden) back = document.activeElement;
      note = msg;
      el.hidden = false;
      await refresh();
      show(sec || section);
      if (sec === 'claude' && msg) { const k = q('#set-key'); if (k) k.focus(); } else q('.set-close').focus();
    }
    function close() {
      registry.cancelRecord();
      recordingId = null;
      el.hidden = true;
      note = '';
      if (opts.onClose) opts.onClose(back);
    }

    return {
      open, close, show, isOpen: () => !el.hidden,
      update(p) { page = p; render(); },
      themes(t) { themes = t; render(); },
      keysChanged() { render(); },
      state: () => ({ open: !el.hidden, section, note, errors: page ? page.errors : [] }),
    };
  }

  g.SettingsPage = { create };
})(window);
