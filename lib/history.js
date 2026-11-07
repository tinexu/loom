'use strict';
// Loom — command history, kept in userData/history.jsonl.
// One JSON record per line: {cmd, cwd, exitCode, startedAt, durationMs, rootId, cardId}.
// Appends are cheap; the file is rewritten when it grows well past the cap.

const fs = require('fs');
const path = require('path');

const MAX = 20000;

// zsh/bash `ignorespace`: a command typed with a leading space isn't recorded.
const shouldRecord = (raw) => typeof raw === 'string' && !!raw.trim() && !/^[ \t]/.test(raw);

function clean(r) {
  const num = (v) => (Number.isFinite(v) ? v : null);
  return {
    cmd: String(r.cmd),
    cwd: typeof r.cwd === 'string' ? r.cwd : null,
    exitCode: num(r.exitCode),
    startedAt: num(r.startedAt) || 0,
    durationMs: num(r.durationMs),
    rootId: num(r.rootId),
    cardId: num(r.cardId),
    ...(r.source ? { source: String(r.source) } : {}),
  };
}

// Consecutive repeats collapse into the newest one.
function collapse(list) {
  const out = [];
  for (const r of list) {
    if (out.length && out[out.length - 1].cmd === r.cmd) out[out.length - 1] = r;
    else out.push(r);
  }
  return out;
}

function createHistory(file, { max = MAX } = {}) {
  let records = [];
  let lines = 0;
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      if (!line) continue;
      lines++;
      try { const r = JSON.parse(line); if (r && typeof r.cmd === 'string') records.push(clean(r)); } catch { /* torn write */ }
    }
  } catch { /* first run */ }
  records = collapse(records).slice(-max);

  function rewrite() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, records.map((r) => `${JSON.stringify(r)}\n`).join(''), { mode: 0o600 });
    fs.renameSync(tmp, file);
    lines = records.length;
  }

  function add(raw) {
    if (!raw || !shouldRecord(raw.cmd)) return false;
    const r = clean({ ...raw, cmd: raw.cmd.replace(/\s+$/, '') });
    if (records.length && records[records.length - 1].cmd === r.cmd) records[records.length - 1] = r;
    else records.push(r);
    if (records.length > max) records.splice(0, records.length - max);
    if (lines > max * 1.25) { rewrite(); return true; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(r)}\n`, { mode: 0o600 });
    lines++;
    return true;
  }

  // Imported commands are older than anything Loom ran.
  function importRecords(list) {
    const imported = list.filter((r) => shouldRecord(r.cmd)).map(clean);
    records = collapse([...imported, ...records]).slice(-max);
    rewrite();
    return imported.length;
  }

  return { all: () => records, add, importRecords };
}

// zsh "metafies" bytes 0x83–0xff in its history file: 0x83 then byte ^ 32.
function unmetafy(buf) {
  const out = Buffer.alloc(buf.length);
  let j = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x83 && i + 1 < buf.length) out[j++] = buf[++i] ^ 32;
    else out[j++] = buf[i];
  }
  return out.subarray(0, j).toString('utf8');
}

// Plain lines, or EXTENDED_HISTORY's `: <start>:<seconds>;<command>`.
// A multi-line command is stored with each newline escaped by a backslash.
function parseZshHistory(input) {
  const text = Buffer.isBuffer(input) ? unmetafy(input) : String(input);
  const out = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (cur && cur.more) {
      cur.cmd += `\n${line}`;
    } else {
      const m = /^: *(\d+):(\d+);(.*)$/s.exec(line);
      cur = m ? { cmd: m[3], startedAt: Number(m[1]) * 1000, durationMs: Number(m[2]) * 1000 } : { cmd: line, startedAt: 0 };
      out.push(cur);
    }
    cur.more = /(^|[^\\])(\\\\)*\\$/.test(cur.cmd);
    if (cur.more) cur.cmd = cur.cmd.slice(0, -1);
  }
  return out.filter((r) => r.cmd.trim()).map(({ more, ...r }) => ({ ...r, source: 'zsh' }));
}

// One command per line; HISTTIMEFORMAT adds `#<seconds>` lines before them.
function parseBashHistory(text) {
  const out = [];
  let at = 0;
  for (const line of String(text).split('\n')) {
    const m = /^#(\d{9,})$/.exec(line);
    if (m) { at = Number(m[1]) * 1000; continue; }
    if (line.trim()) out.push({ cmd: line, startedAt: at, source: 'bash' });
    at = 0;
  }
  return out;
}

module.exports = { createHistory, parseZshHistory, parseBashHistory, shouldRecord, MAX };
