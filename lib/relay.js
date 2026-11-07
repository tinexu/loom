'use strict';
// Loom — running cards' output on its way to the renderer. lib/outputs.js has
// already recorded every byte; this only feeds the terminal models of the
// cards the renderer is watching (visible, live or on the alternate screen).
//   - At most one message per card per frame, of at most MSG_MAX characters.
//   - The renderer acknowledges what its terminal has parsed (after
//     xterm.write's callback). Past HIGH unacknowledged, a program that moves
//     the cursor has its PTY paused until the backlog is under LOW, the flow
//     control from xterm.js's guide.
//   - Plain line output (no cursor movement, no alternate screen) isn't
//     paused: the program runs at full speed into the file, and each frame the
//     view gets at most the newest KEEP characters, which is more than its
//     screen can show. Nobody reads a flood at 60 frames a second, and parsing
//     it all would cost the page for nothing.
const FRAME_MS = 16;
const MSG_MAX = 128 * 1024;
const HIGH = 1024 * 1024;
const LOW = 256 * 1024;
const KEEP = 64 * 1024;

// send(id, text) returns false when there's no window. pause(id, on) pauses
// that card's PTY. plain(id) says whether its output is still plain lines.
function createRelay({ send, pause, plain }) {
  const cards = new Map();

  function setPaused(c, on) {
    if (c.paused === on) return;
    c.paused = on;
    pause(c.id, on);
  }

  function schedule(c) {
    if (!c.timer && c.pending) c.timer = setTimeout(() => flush(c), FRAME_MS);
  }

  // Keeps the newest KEEP characters, from the start of a line.
  function skip(c) {
    if (c.pending.length <= KEEP) return;
    const cut = c.pending.length - KEEP;
    const nl = c.pending.indexOf('\n', cut);
    c.pending = `\r\n${c.pending.slice(nl >= 0 ? nl + 1 : cut)}`;
    c.skipped++;
  }

  function flush(c) {
    c.timer = null;
    if (!c.sub || !c.pending) return;
    const plainNow = plain(c.id);
    if (plainNow) skip(c);
    if (c.unacked > HIGH) return; // only plain output gets here unpaused: wait for acks
    let end = Math.min(c.pending.length, MSG_MAX);
    const code = c.pending.charCodeAt(end - 1);
    if (end < c.pending.length && code >= 0xd800 && code < 0xdc00) end--;
    const chunk = c.pending.slice(0, end);
    c.pending = c.pending.slice(end);
    if (send(c.id, chunk) === false) { unsubscribe(c); return; }
    c.unacked += chunk.length;
    schedule(c);
  }

  function data(id, text) {
    const c = cards.get(id);
    if (!c || !c.sub) return;
    c.pending += text;
    if (c.pending.length > KEEP * 2 && plain(id)) skip(c);
    else if (c.pending.length + c.unacked > HIGH && !plain(id)) setPaused(c, true);
    schedule(c);
  }

  function ack(id, n) {
    const c = cards.get(id);
    if (!c) return;
    c.unacked = Math.max(0, c.unacked - n);
    if (c.paused && c.unacked + c.pending.length < LOW) setPaused(c, false);
    schedule(c);
  }

  function unsubscribe(c) {
    c.sub = false;
    c.pending = '';
    c.unacked = 0;
    clearTimeout(c.timer);
    c.timer = null;
    setPaused(c, false);
  }

  return {
    start(id, { watch = true } = {}) {
      const old = cards.get(id);
      if (old) unsubscribe(old);
      cards.set(id, { id, sub: watch, pending: '', unacked: 0, timer: null, paused: false, skipped: 0 });
    },
    data,
    ack,
    subscribe(id, on) {
      const c = cards.get(id);
      if (!c) return false;
      if (on) { unsubscribe(c); c.sub = true; } else unsubscribe(c);
      return true;
    },
    // The card ended: whatever is left goes now, whatever the watermarks say.
    end(id) {
      const c = cards.get(id);
      if (!c) return;
      clearTimeout(c.timer);
      if (c.sub) {
        while (c.pending) {
          const chunk = c.pending.slice(0, MSG_MAX);
          c.pending = c.pending.slice(MSG_MAX);
          if (send(id, chunk) === false) break;
        }
      }
      setPaused(c, false);
      cards.delete(id);
    },
    // A reloaded page acknowledges nothing it was sent before.
    reset() { for (const c of cards.values()) unsubscribe(c); },
    watching: (id) => { const c = cards.get(id); return !!(c && c.sub); },
    stats: (id) => { const c = cards.get(id); return c ? { sub: c.sub, pending: c.pending.length, unacked: c.unacked, paused: c.paused, skipped: c.skipped } : null; },
  };
}

module.exports = { createRelay, HIGH, LOW, MSG_MAX, KEEP };
