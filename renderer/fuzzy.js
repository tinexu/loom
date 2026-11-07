'use strict';
// Loom — fuzzy matching and history ranking for Ctrl+R, ↑/↓ and ghost text.
// Loaded by the page as window.Fuzzy and by the tests with require().
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Fuzzy = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  const BOUNDARY = /[\s/\-_.:=@,;|&()'"]/;

  // Case-insensitive subsequence match. Finds the leftmost match, then walks
  // back from its end for the tightest window, the same idea as fzf v1.
  // Returns { score, hl: matched indices } or null.
  function match(query, text) {
    if (!query) return { score: 0, hl: [] };
    const q = query.toLowerCase();
    const t = text.toLowerCase();
    let qi = 0;
    let end = -1;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === q[qi] && ++qi === q.length) { end = i; break; }
    }
    if (end < 0) return null;
    let start = end;
    for (let i = end, k = q.length - 1; i >= 0; i--) {
      if (t[i] === q[k]) { start = i; if (--k < 0) break; }
    }
    const hl = [];
    let score = 0;
    let prev = -2;
    for (let i = start, k = 0; i <= end && k < q.length; i++) {
      if (t[i] !== q[k]) continue;
      let s = 1;
      if (i === prev + 1) s += 2;
      else if (prev >= 0) s -= 2 + Math.min(i - prev - 2, 4) * 0.5; // a gap
      // A word start counts, and doubly for the first character: people type initials.
      if (i === 0 || BOUNDARY.test(text[i - 1])) s += k === 0 ? 6 : 3;
      if (text[i] === query[k]) s += 0.25; // same case
      score += s;
      hl.push(i);
      prev = i;
      k++;
    }
    score -= (end - start + 1 - q.length) * 0.1;
    if (start === 0) score += 2;
    return { score, hl };
  }

  // One entry per distinct command, newest last, with how often and where it ran.
  function aggregate(records) {
    const by = new Map();
    for (const r of records) {
      let a = by.get(r.cmd);
      if (!a) { a = { cmd: r.cmd, count: 0, last: r, cwds: new Set() }; by.set(r.cmd, a); }
      a.count++;
      if ((r.startedAt || 0) >= (a.last.startedAt || 0)) a.last = r;
      if (r.cwd) a.cwds.add(r.cwd);
    }
    return [...by.values()];
  }

  // Fuzzy score plus recency and frequency, with a boost for commands that
  // ran in this folder and the ones that worked.
  function rank(entries, query, { cwd = null, now = Date.now(), limit = 60 } = {}) {
    const out = [];
    for (const a of entries) {
      const m = match(query, a.cmd);
      if (!m) continue;
      const ageH = Math.max(0, now - (a.last.startedAt || 0)) / 3600000;
      let score = m.score * 1.6;
      score += Math.log2(1 + a.count) * 1.2;
      score += a.last.startedAt ? 4 * 0.5 ** (ageH / 72) : 0;
      if (cwd && a.cwds.has(cwd)) score += 2.5;
      if (a.last.exitCode === 0) score += 1.5;
      else if (a.last.exitCode === 127) score -= 3;
      out.push({ entry: a, score, hl: m.hl });
    }
    out.sort((x, y) => y.score - x.score || (y.entry.last.startedAt || 0) - (x.entry.last.startedAt || 0));
    return out.slice(0, limit);
  }

  // Ghost text: the best earlier command that starts with what's typed.
  // Same folder beats elsewhere, success beats failure, newer beats older.
  // "command not found" (127) is never suggested.
  function suggest(records, prefix, cwd) {
    if (!prefix || prefix.includes('\n')) return null;
    let best = null;
    let bestTier = -1;
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i];
      if (r.cmd.length <= prefix.length || !r.cmd.startsWith(prefix) || r.cmd.includes('\n')) continue;
      if (r.exitCode === 127) continue;
      const tier = (cwd && r.cwd === cwd ? 2 : 0) + (r.exitCode === 0 ? 1 : 0);
      if (tier > bestTier) { best = r; bestTier = tier; if (tier === 3) break; }
    }
    return best ? best.cmd : null;
  }

  // ↑/↓: distinct commands that start with the prefix, newest first.
  function prefixed(records, prefix) {
    const seen = new Set();
    const out = [];
    for (let i = records.length - 1; i >= 0; i--) {
      const c = records[i].cmd;
      if (seen.has(c) || !c.startsWith(prefix) || c === prefix) continue;
      seen.add(c);
      out.push(c);
    }
    return out;
  }

  return { match, aggregate, rank, suggest, prefixed };
}));
