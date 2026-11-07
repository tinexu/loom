'use strict';
// Unit tests for the command bar's shell lexer. Run with `npm test`.
const test = require('node:test');
const assert = require('node:assert');
const { lex, isIncomplete, contextAt } = require('../renderer/shell-lex');

const words = (t) => lex(t).words.map((w) => [w.type, w.value]);
const types = (t) => lex(t).tokens.filter((k) => k.type !== 'arg').map((k) => [k.type, t.slice(k.start, k.end)]);

test('command position after operators and prefixes', () => {
  assert.deepStrictEqual(words('FOO=1 sudo -u root make -j4 && ls | grep x; time git log'), [
    ['assign', 'FOO=1'], ['command', 'sudo'], ['flag', '-u'], ['arg', 'root'], ['command', 'make'], ['flag', '-j4'],
    ['command', 'ls'], ['command', 'grep'], ['arg', 'x'], ['command', 'time'], ['command', 'git'], ['arg', 'log'],
  ]);
  assert.deepStrictEqual(words('env A=b xargs -n 1 echo'), [
    ['command', 'env'], ['assign', 'A=b'], ['command', 'xargs'], ['flag', '-n'], ['arg', '1'], ['command', 'echo'],
  ]);
  assert.deepStrictEqual(words('if true; then echo hi; fi').filter(([t]) => t === 'command').map(([, v]) => v), ['if', 'true', 'then', 'echo', 'fi']);
});

test('token kinds with offsets', () => {
  const t = 'echo "a $HOME" \'x\' $(date) ${A:-b} *.js 2>&1 >> out # note';
  assert.deepStrictEqual(types(t), [
    ['command', 'echo'], ['string', '"a $HOME"'], ['var', '$HOME'], ['string', "'x'"], ['var', '$('], ['command', 'date'], ['var', ')'],
    ['var', '${A:-b}'], ['glob', '*'], ['op', '2>&1'], ['op', '>>'], ['comment', '# note'],
  ]);
  const r = lex('ls -la');
  assert.deepStrictEqual(r.tokens.map((k) => [k.type, k.start, k.end]), [['command', 0, 2], ['flag', 3, 6]]);
});

test('quotes and escapes give the word its value', () => {
  assert.deepStrictEqual(words('cat my\\ file.txt "a b"c \'d\'"e"'), [['command', 'cat'], ['arg', 'my file.txt'], ['arg', 'a bc'], ['arg', 'de']]);
  assert.deepStrictEqual(words("echo $'a\\tb'"), [['command', 'echo'], ['arg', 'a\tb']]);
});

test('heredocs', () => {
  const r = lex("cat <<'EOF' | wc -l\nhello $x\nEOF\necho after");
  const src = "cat <<'EOF' | wc -l\nhello $x\nEOF\necho after";
  assert.deepStrictEqual(r.tokens.filter((k) => k.type === 'heredoc').map((k) => src.slice(k.start, k.end)), ["'EOF'", 'hello $x\nEOF\n']);
  assert.deepStrictEqual(r.words.filter((w) => w.type === 'command').map((w) => w.value), ['cat', 'wc', 'echo']);
  assert.strictEqual(r.words.find((w) => w.type === 'heredoc').value, 'EOF');
});

test('isIncomplete', () => {
  for (const t of ['echo "unfinished', "echo 'x", 'echo a \\', 'ls |', 'a &&', 'a ||', 'cat <<EOF', 'cat <<EOF\nhi', 'cat <<-EOF\n\thi\n',
    '(cd x', '{ echo a', 'echo $(date', 'echo ${A', 'echo `date', 'if true; then\necho "a\n']) {
    assert.strictEqual(isIncomplete(t), true, JSON.stringify(t));
  }
  for (const t of ['echo "done"', 'ls | wc -l', 'a && b', 'cat <<EOF\nhi\nEOF', 'cat <<-EOF\n\thi\n\tEOF', '(cd x)', '{ echo a; }',
    'echo $(date)', 'echo a # "quote in a comment', "echo it\\'s", 'echo a \\\nb', 'echo "a\nb"', 'ls &', 'echo hi;']) {
    assert.strictEqual(isIncomplete(t), false, JSON.stringify(t));
  }
});

test('contextAt: command, argument index, partial word, quotes', () => {
  const c = (t, k) => { const r = contextAt(t, k); return [r.command, r.argIndex, r.word, r.quote, r.inCommand]; };
  assert.deepStrictEqual(c('git checkout '), ['git', 2, '', null, false]);
  assert.deepStrictEqual(c('git checkout fe'), ['git', 2, 'fe', null, false]);
  assert.deepStrictEqual(c('gi'), [null, 0, 'gi', null, true]);
  assert.deepStrictEqual(c('ls | gr'), [null, 0, 'gr', null, true]);
  assert.deepStrictEqual(c('sudo apt ins'), ['apt', 1, 'ins', null, false]);
  assert.deepStrictEqual(c('cat "my fi'), ['cat', 1, 'my fi', '"', false]);
  assert.deepStrictEqual(c("cat 'it"), ['cat', 1, 'it', "'", false]);
  assert.deepStrictEqual(c('cat my\\ fi'), ['cat', 1, 'my fi', null, false]);
  assert.deepStrictEqual(c('echo $(git sta'), ['git', 1, 'sta', null, false]);
  assert.deepStrictEqual(c('cd sr && ls', 5), ['cd', 1, 'sr', null, false]);
  const r = contextAt('git checkout feat/x', 17);
  assert.deepStrictEqual([r.wordStart, r.wordEnd, r.word], [13, 19, 'feat']);
  assert.deepStrictEqual(contextAt('echo $HO').variable, { start: 5, brace: false, name: 'HO' });
  assert.deepStrictEqual(contextAt("echo '$HO").variable, null);
  assert.strictEqual(contextAt('ls > ou').redirect, true);
});
