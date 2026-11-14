'use strict';
// Loom — the tab strip. Each tab shows its color dot, title, and a spinner
// while something runs in it, or a red or green dot when a command failed or
// finished since you last looked. Double-click renames, the dot picks a
// color, drag reorders, middle-click closes.
(function (g) {
  const COLORS = ['#e5484d', '#f76b15', '#e2a336', '#46a758', '#12a594', '#3e63dd', '#8e4ec6', '#d6409f'];

  // opts: el, onSelect(id), onClose(id), onNew(), onRename(id, title),
  // onColor(id, color), onReorder(order)
  function create(opts) {
    const { el } = opts;
    el.innerHTML = '<div class="tab-list" role="tablist"></div><button class="tab-new" title="New tab">+</button><div class="tab-colors" hidden></div>';
    const list = el.querySelector('.tab-list');
    const picker = el.querySelector('.tab-colors');
    let tabs = [];
    let dragId = null;

    picker.innerHTML = `${COLORS.map((c) => `<button data-color="${c}" style="--c:${c}" title="${c}"></button>`).join('')}<button data-color="" class="none" title="No color"></button>`;

    function render(next) {
      tabs = next;
      const have = new Map([...list.children].map((x) => [x.dataset.id, x]));
      const frag = document.createDocumentFragment();
      tabs.forEach((t, i) => {
        let x = have.get(t.id);
        if (!x || x.querySelector('.tab-rename')) {
          if (!x) {
            x = document.createElement('div');
            x.className = 'tab';
            x.draggable = true;
            x.dataset.id = t.id;
            x.setAttribute('role', 'tab');
            x.innerHTML = '<button class="tab-dot" title="Color"></button><span class="tab-title"></span><span class="tab-badge"></span><button class="tab-x" title="Close tab">×</button>';
          }
        }
        have.delete(t.id);
        x.classList.toggle('active', !!t.active);
        x.setAttribute('aria-selected', t.active ? 'true' : 'false');
        x.style.setProperty('--c', t.color || 'transparent');
        x.classList.toggle('has-color', !!t.color);
        const title = x.querySelector('.tab-title');
        if (title && title.textContent !== t.title) title.textContent = t.title;
        x.title = `${t.title}${t.folder ? `\n${t.folder}` : ''}${i < 9 ? `\n${opts.keyHint ? opts.keyHint(i + 1) : ''}` : ''}`.trim();
        const badge = x.querySelector('.tab-badge');
        badge.className = `tab-badge${t.running ? ' running' : t.unseen ? ` ${t.unseen}` : ''}`;
        frag.append(x);
      });
      for (const x of have.values()) x.remove();
      list.append(frag);
    }

    function rename(id) {
      const x = list.querySelector(`.tab[data-id="${id}"]`);
      const t = tabs.find((y) => y.id === id);
      if (!x || !t) return;
      const title = x.querySelector('.tab-title');
      const input = document.createElement('input');
      input.className = 'tab-rename';
      input.value = t.title;
      input.spellcheck = false;
      title.replaceWith(input);
      input.focus();
      input.select();
      let done = false;
      const finish = (save) => {
        if (done) return;
        done = true;
        const span = document.createElement('span');
        span.className = 'tab-title';
        span.textContent = t.title;
        input.replaceWith(span);
        const v = input.value.trim();
        if (save && v && v !== t.title) opts.onRename(id, v);
        if (opts.onDoneEditing) opts.onDoneEditing();
      };
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      input.addEventListener('blur', () => finish(true));
    }

    function pickColor(id, anchor) {
      const r = anchor.getBoundingClientRect();
      const host = el.getBoundingClientRect();
      picker.style.left = `${r.left - host.left}px`;
      picker.hidden = false;
      picker.dataset.id = id;
      const off = (e) => { if (!picker.contains(e.target)) { picker.hidden = true; document.removeEventListener('pointerdown', off, true); } };
      setTimeout(() => document.addEventListener('pointerdown', off, true), 0);
    }
    picker.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      picker.hidden = true;
      opts.onColor(picker.dataset.id, b.dataset.color || null);
    });

    list.addEventListener('mousedown', (e) => {
      const x = e.target.closest('.tab');
      if (!x || e.button !== 0 || e.target.closest('.tab-x, .tab-dot, .tab-rename')) return;
      opts.onSelect(x.dataset.id);
    });
    list.addEventListener('click', (e) => {
      const x = e.target.closest('.tab');
      if (!x) return;
      if (e.target.closest('.tab-x')) { e.stopPropagation(); opts.onClose(x.dataset.id); }
      else if (e.target.closest('.tab-dot')) { e.stopPropagation(); pickColor(x.dataset.id, e.target); }
    });
    // Middle-click closes.
    list.addEventListener('auxclick', (e) => {
      const x = e.target.closest('.tab');
      if (x && e.button === 1) { e.preventDefault(); opts.onClose(x.dataset.id); }
    });
    list.addEventListener('dblclick', (e) => {
      const x = e.target.closest('.tab');
      if (x && !e.target.closest('.tab-x, .tab-dot')) rename(x.dataset.id);
    });
    el.querySelector('.tab-new').addEventListener('click', () => opts.onNew());
    // An empty part of the strip makes a new tab too, as in browsers.
    list.addEventListener('dblclick', (e) => { if (e.target === list) opts.onNew(); });

    // Drag to reorder.
    list.addEventListener('dragstart', (e) => {
      const x = e.target.closest('.tab');
      if (!x) return;
      dragId = x.dataset.id;
      x.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragId);
    });
    list.addEventListener('dragover', (e) => {
      if (!dragId) return;
      e.preventDefault();
      const over = e.target.closest('.tab');
      const moving = list.querySelector(`.tab[data-id="${dragId}"]`);
      if (!over || over === moving) return;
      const r = over.getBoundingClientRect();
      list.insertBefore(moving, e.clientX < r.left + r.width / 2 ? over : over.nextSibling);
    });
    const endDrag = () => {
      if (!dragId) return;
      const x = list.querySelector(`.tab[data-id="${dragId}"]`);
      if (x) x.classList.remove('dragging');
      dragId = null;
      const order = [...list.children].map((t) => t.dataset.id);
      if (order.join() !== tabs.map((t) => t.id).join()) opts.onReorder(order);
    };
    list.addEventListener('drop', (e) => { e.preventDefault(); endDrag(); });
    list.addEventListener('dragend', endDrag);

    return { render, rename, pickColor: (id) => { const x = list.querySelector(`.tab[data-id="${id}"] .tab-dot`); if (x) pickColor(id, x); }, COLORS };
  }

  g.TabBar = { create, COLORS };
})(window);
