'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildCompletionEdit,
  byteOffsetAtPosition,
  classifyFailure,
  createTextSnapshot,
  formatGhostPreview,
  parseInlineCompletionResponse,
  positionAtByteOffset,
  statusNeedsSignIn,
  statusText,
  utf8ByteLength,
} = require('../build-test/src/core.js');

function referencePositionAtByteOffset(text, requestedOffset) {
  const offset = Math.max(0, Math.floor(requestedOffset));
  let bytes = 0;
  let index = 0;
  for (const character of text) {
    const nextBytes = bytes + Buffer.byteLength(character, 'utf8');
    if (nextBytes > offset) break;
    bytes = nextBytes;
    index += character.length;
  }
  const prefix = text.slice(0, index);
  const lines = prefix.split('\n');
  return { line: lines.length - 1, character: lines.at(-1).length };
}

function referenceByteOffsetAtPosition(text, position) {
  const requestedLine = Math.max(0, Math.floor(position.line));
  let line = 0;
  let lineStart = 0;
  while (line < requestedLine) {
    const newline = text.indexOf('\n', lineStart);
    if (newline < 0) return Buffer.byteLength(text, 'utf8');
    lineStart = newline + 1;
    line += 1;
  }
  let lineEnd = text.indexOf('\n', lineStart);
  if (lineEnd < 0) lineEnd = text.length;
  if (lineEnd > lineStart && text.charCodeAt(lineEnd - 1) === 13) lineEnd -= 1;
  const lineText = text.slice(lineStart, lineEnd);
  let character = Math.min(
    lineText.length,
    Math.max(0, Math.floor(position.character)),
  );
  if (
    character > 0 &&
    character < lineText.length &&
    lineText.charCodeAt(character - 1) >= 0xd800 &&
    lineText.charCodeAt(character - 1) <= 0xdbff &&
    lineText.charCodeAt(character) >= 0xdc00 &&
    lineText.charCodeAt(character) <= 0xdfff
  ) {
    character -= 1;
  }
  return Buffer.byteLength(text.slice(0, lineStart + character), 'utf8');
}

test('UTF-8 Fresh offsets convert to UTF-16 LSP positions', () => {
  const text = 'a🙂\r\néx';

  assert.equal(utf8ByteLength(text), Buffer.byteLength(text, 'utf8'));
  assert.deepEqual(positionAtByteOffset(text, 0), { line: 0, character: 0 });
  assert.deepEqual(positionAtByteOffset(text, 1), { line: 0, character: 1 });
  assert.deepEqual(positionAtByteOffset(text, 5), { line: 0, character: 3 });
  assert.deepEqual(positionAtByteOffset(text, 7), { line: 1, character: 0 });
  assert.deepEqual(positionAtByteOffset(text, 9), { line: 1, character: 1 });
});

test('LSP positions convert to UTF-8 offsets and never split a surrogate pair', () => {
  const text = 'a🙂\r\néx';

  assert.equal(byteOffsetAtPosition(text, { line: 0, character: 3 }), 5);
  assert.equal(byteOffsetAtPosition(text, { line: 1, character: 1 }), 9);
  assert.equal(byteOffsetAtPosition(text, { line: 99, character: 0 }), 10);
  assert.equal(
    byteOffsetAtPosition(text, { line: 0, character: 2 }),
    1,
    'a UTF-16 position inside 🙂 clamps to its start',
  );
});

test('optimized text indexing matches reference Unicode and CRLF conversions', () => {
  const texts = [
    '',
    'plain ascii\nsecond line',
    'a🙂\r\néx',
    '𐐷中\n🙂🙂',
    `unpaired ${String.fromCharCode(0xd800)} surrogate`,
  ];

  for (const text of texts) {
    const byteLength = Buffer.byteLength(text, 'utf8');
    for (let offset = 0; offset <= byteLength + 2; offset += 1) {
      assert.deepEqual(
        positionAtByteOffset(text, offset),
        referencePositionAtByteOffset(text, offset),
      );
      const snapshot = createTextSnapshot(text, offset);
      assert.equal(snapshot.byteLength, byteLength);
      assert.deepEqual(snapshot.cursorPosition, positionAtByteOffset(text, offset));
    }
    for (let line = 0; line < 5; line += 1) {
      for (let character = 0; character < 12; character += 1) {
        const position = { line, character };
        assert.equal(
          byteOffsetAtPosition(text, position),
          referenceByteOffsetAtPosition(text, position),
        );
      }
    }
  }
});

test('buildCompletionEdit handles prefix-replacing Copilot items', () => {
  const text = 'const foo = 1';
  const item = {
    insertText: 'foobar',
    range: {
      start: { line: 0, character: 6 },
      end: { line: 0, character: 9 },
    },
  };

  assert.deepEqual(buildCompletionEdit(text, 9, item), {
    start: 6,
    end: 9,
    insertText: 'foobar',
    replacedText: 'foo',
    previewText: 'bar',
  });
});

test('a text snapshot reuses Unicode cursor metrics for a completion edit', () => {
  const text = 'let value = 🙂foo';
  const cursor = Buffer.byteLength(text, 'utf8');
  const snapshot = createTextSnapshot(text, cursor);

  assert.equal(snapshot.byteLength, cursor);
  assert.deepEqual(snapshot.cursorPosition, { line: 0, character: 17 });
  assert.deepEqual(
    buildCompletionEdit(
      text,
      cursor,
      {
        insertText: 'foobar',
        range: {
          start: { line: 0, character: 14 },
          end: { line: 0, character: 17 },
        },
      },
      snapshot,
    ),
    {
      start: 16,
      end: 19,
      insertText: 'foobar',
      replacedText: 'foo',
      previewText: 'bar',
    },
  );
});

test('buildCompletionEdit defaults to inserting at the cursor', () => {
  assert.deepEqual(buildCompletionEdit('return ', 7, { insertText: 'true;' }), {
    start: 7,
    end: 7,
    insertText: 'true;',
    replacedText: '',
    previewText: 'true;',
  });
});

test('buildCompletionEdit rejects stale and no-op ranges', () => {
  assert.equal(
    buildCompletionEdit('abcdef', 4, {
      insertText: 'x',
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 2 },
      },
    }),
    null,
  );
  assert.equal(
    buildCompletionEdit('abcdef', 3, {
      insertText: 'abc',
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 3 },
      },
    }),
    null,
  );
});

test('formatGhostPreview makes multiline suggestions compact', () => {
  assert.equal(formatGhostPreview('hello'), 'hello');
  assert.equal(formatGhostPreview('\nsecond\nthird'), '↵ +2 lines');
  assert.equal(formatGhostPreview('first\r\nsecond'), 'first  ↵ +1 line');
  assert.equal(formatGhostPreview('abcdefghij', 6), 'abcde…');
});

test('parseInlineCompletionResponse filters malformed items', () => {
  const valid = {
    insertText: 'ok',
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
    },
    command: { command: 'github.copilot.accept', arguments: [1] },
  };
  assert.deepEqual(
    parseInlineCompletionResponse({
      items: [valid, null, { insertText: 42 }, { insertText: 'bad', range: {} }],
    }),
    [valid],
  );
  assert.deepEqual(parseInlineCompletionResponse(null), []);
});

test('expected Copilot failures are classified into quiet states', () => {
  assert.equal(classifyFailure('Request failed with HTTP 402'), 'quota');
  assert.equal(classifyFailure({ message: 'monthly usage limit exceeded' }), 'quota');
  assert.equal(classifyFailure('NotSignedIn'), 'authentication');
  assert.equal(classifyFailure('failed to spawn: ENOENT'), 'server-missing');
  assert.equal(classifyFailure('request cancelled'), 'cancelled');
  assert.equal(classifyFailure('socket closed'), 'transient');
});

test('checkStatus responses produce readable status text', () => {
  assert.equal(
    statusText({ status: 'OK', user: 'octocat', message: 'ready' }),
    'OK — octocat — ready',
  );
  assert.equal(statusNeedsSignIn({ status: 'NotSignedIn' }), true);
  assert.equal(statusNeedsSignIn({ status: 'OK' }), false);
});
