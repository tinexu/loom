'use strict';
// Unit tests for the PTY stream parser. Run with `npm test`.
const test = require('node:test');
const assert = require('node:assert');
const { createParser } = require('../lib/sessions');

const N = 'abc123';
const mark = (body) => `\x1b]${body}\x07`;
const A = mark(`133;A;loom=${N}`);
const B = mark(`133;B;loom=${N}`);
const C = mark(`133;C;loom=${N}`);
const D = (code) => mark(`133;D;${code};loom=${N}`);
const ENV = mark(`1337;LoomEnv=/tmp/snap;loom=${N}`);

function parse(chunks) {
  const ev = { out: '', log: [] };
  const p = createParser(N, {
    outputStart: () => ev.log.push('C'),
    output: (t) => { ev.out += t; },
    finish: (c) => ev.log.push(`D${c}`),
    cwd: (d) => ev.log.push(`cwd:${d}`),
    env: (f) => ev.log.push(`env:${f}`),
    promptStart: () => ev.log.push('A'),
    promptEnd: () => ev.log.push('B'),
  });
  for (const c of chunks) p.feed(c);
  return ev;
}

const stream = `${A}user@host $ ${B} source /tmp/x\r\n${C}hello\r\nworld\r\n${D(3)}${mark('7;file://host/tmp/a%20b')}${ENV}${A}prompt ${B}`;

test('keeps only the bytes between C and D', () => {
  const ev = parse([stream]);
  assert.strictEqual(ev.out, 'hello\r\nworld\r\n');
  assert.deepStrictEqual(ev.log, ['A', 'B', 'C', 'D3', 'cwd:/tmp/a b', 'env:/tmp/snap', 'A', 'B']);
});

test('gives the same result however the stream is split', () => {
  const whole = parse([stream]);
  for (let size = 1; size < 12; size++) {
    const chunks = [];
    for (let i = 0; i < stream.length; i += size) chunks.push(stream.slice(i, i + size));
    const ev = parse(chunks);
    assert.strictEqual(ev.out, whole.out);
    assert.deepStrictEqual(ev.log, whole.log);
  }
});

test('ignores markers without the session nonce', () => {
  const forged = `${mark('133;D;0;loom=nope')}${mark('133;D;0')}${mark('1337;LoomEnv=/tmp/evil;loom=nope')}`;
  const ev = parse([`${C}a${forged}b${D(0)}`]);
  assert.deepStrictEqual(ev.log, ['C', 'D0']);
  assert.ok(ev.out.startsWith('a') && ev.out.endsWith('b'));
});

test("doesn't treat a command's OSC 7 as the shell's cwd", () => {
  const ev = parse([`${C}${mark('7;file://h/evil')}${D(0)}`]);
  assert.deepStrictEqual(ev.log, ['C', 'D0']);
});

test('passes other escape sequences through to the card', () => {
  const ev = parse([`${C}\x1b[31mred\x1b[0m ${mark('8;;http://x')}link${D(0)}`]);
  assert.strictEqual(ev.out, `\x1b[31mred\x1b[0m ${mark('8;;http://x')}link`);
});

test('accepts ST as well as BEL', () => {
  const ev = parse([`${C}x\x1b]133;D;5;loom=${N}\x1b\\`]);
  assert.deepStrictEqual(ev.log, ['C', 'D5']);
  assert.strictEqual(ev.out, 'x');
});

test('an unterminated OSC in the output cannot swallow the real marker', () => {
  const ev = parse([`${C}junk\x1b]0;never ends`, `${D(0)}`]);
  assert.deepStrictEqual(ev.log, ['C', 'D0']);
  assert.ok(ev.out.includes('never ends'));
});

test('an enormous fake OSC is released as text', () => {
  const big = 'x'.repeat(10000);
  const ev = parse([`${C}\x1b]${big}`, `tail${D(0)}`]);
  assert.ok(ev.out.endsWith(`${big}tail`));
  assert.deepStrictEqual(ev.log, ['C', 'D0']);
});

test('a prompt with no D still closes the output window', () => {
  const ev = parse([`${C}partial${A}after`]);
  assert.strictEqual(ev.out, 'partial');
});
