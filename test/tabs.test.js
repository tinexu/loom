'use strict';
// Unit tests for lib/tabs.js: migrating session.json to the first tab, and
// the tab store. Run with `npm test`.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTabStore, migrateLegacy, CLOSED_MAX } = require('../lib/tabs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'loom-tabs-'));

test('migrate: a session with output files becomes the first tab', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'outputs'));
  for (const f of ['1.log', '1.idx', '2.log', '2.rich.json']) fs.writeFileSync(path.join(dir, 'outputs', f), f);
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({
    v: 2, nextId: 3, view: { x: 1, y: 2, k: 0.5 }, activeId: 2, rootCwd: '/Users/me/proj', sidebar: true,
    nodes: [{ id: 1, cmd: 'ls', parentId: null }, { id: 2, cmd: 'pwd', parentId: 1, richKind: 'files' }],
  }));
  const res = migrateLegacy({ dir, id: 'c0000abcd' });
  assert.strictEqual(res.id, 'c0000abcd');
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'outputs')).sort(), ['c0000abcd.1.idx', 'c0000abcd.1.log', 'c0000abcd.2.log', 'c0000abcd.2.rich.json']);
  const canvas = JSON.parse(fs.readFileSync(path.join(dir, 'canvases', 'c0000abcd.json'), 'utf8'));
  assert.deepStrictEqual([canvas.v, canvas.nextId, canvas.activeId, canvas.view.k, canvas.sidebar, canvas.nodes.length], [3, 3, 2, 0.5, true, 2]);
  const tabs = JSON.parse(fs.readFileSync(path.join(dir, 'tabs.json'), 'utf8'));
  assert.deepStrictEqual(tabs.windows.main, { order: ['c0000abcd'], active: 'c0000abcd', closed: [] });
  assert.strictEqual(tabs.tabs.c0000abcd.title, 'proj');
  assert.ok(!fs.existsSync(path.join(dir, 'session.json')));
  assert.ok(fs.existsSync(path.join(dir, 'session.pre-tabs.json')));
  // Nothing to do the second time.
  assert.strictEqual(migrateLegacy({ dir }), null);
});

test('migrate: output kept inline (v1 segs) is written out by key', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({
    v: 1, nextId: 2, rootCwd: '/x', history: ['old cmd'],
    nodes: [{ id: 1, cmd: 'echo hi', bodyH: 300, segs: [[0, 'hi\n'], [1, 'err\n']], rich: { kind: 'files', data: {} } }],
  }));
  const put = [];
  const rich = [];
  const res = migrateLegacy({ dir, id: 'c11112222', putOutput: (k, t) => { put.push([k, t]); return { lines: 2 }; }, putRich: (k, v) => rich.push([k, v.kind]) });
  assert.deepStrictEqual(put, [['c11112222.1', 'hi\nerr\n']]);
  assert.deepStrictEqual(rich, [['c11112222.1', 'files']]);
  assert.deepStrictEqual(res.history, ['old cmd']);
  const canvas = JSON.parse(fs.readFileSync(path.join(dir, 'canvases', 'c11112222.json'), 'utf8'));
  assert.ok(!('segs' in canvas.nodes[0]) && !('rich' in canvas.nodes[0]));
  assert.strictEqual(canvas.nodes[0].richKind, 'files');
  assert.strictEqual(canvas.nodes[0].h, 62 + 2 * 19 + 22);
  assert.ok(fs.existsSync(path.join(dir, 'session.v1.json')));
});

test('store: create, order, close, reopen; closed tabs past ten are dropped', () => {
  const dir = tmp();
  const dropped = [];
  const s = createTabStore({ dir, onDrop: (cid) => dropped.push(cid) });
  const a = s.create('main', { title: 'a', folder: '/a' });
  const b = s.create('main', { title: 'b' });
  const d = s.create('dropdown', { title: 'drop' });
  assert.deepStrictEqual(s.get('main').order, [a.id, b.id]);
  assert.deepStrictEqual(s.get('dropdown').order, [d.id]);
  s.set('main', { order: [b.id, a.id], active: a.id, tabs: [{ id: a.id, title: 'renamed', color: '#f00' }] });
  assert.deepStrictEqual(s.get('main').tabs.map((t) => t.title), ['b', 'renamed']);
  s.close('main', a.id);
  assert.deepStrictEqual(s.get('main').order, [b.id]);
  assert.strictEqual(s.reopen('main').id, a.id);
  assert.deepStrictEqual(s.get('main').order, [b.id, a.id]);
  const extra = [];
  for (let i = 0; i < CLOSED_MAX + 2; i++) { const t = s.create('main', { title: `t${i}` }); extra.push(t.id); s.close('main', t.id); }
  assert.deepStrictEqual(dropped, extra.slice(0, 2));
  assert.strictEqual(s.get('main').closed, CLOSED_MAX);
  s.flush();
  const again = createTabStore({ dir });
  assert.deepStrictEqual(again.get('main').order, [b.id, a.id]);
  assert.strictEqual(again.get('main').tabs[1].color, '#f00');
  assert.strictEqual(again.kindOf(d.id), 'dropdown');
});
