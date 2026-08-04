'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const PLUGIN = path.resolve(__dirname, '../.test-dist/plugin/fresh-copilot.js');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createHarness(options = {}) {
  const initialText = options.text ?? 'const answer = ';
  const handlers = new Map();
  const files = new Map();
  const responses = [...(options.responses ?? [])];
  const delays = [];
  const insertResults = [...(options.insertResults ?? [])];
  const state = {
    activeBufferId: 1,
    text: initialText,
    cursor: Buffer.byteLength(initialText, 'utf8'),
    trust: options.trust ?? 'trusted',
    config: {
      automatic: true,
      debounceMs: 350,
      quotaCooldownMinutes: 1440,
      ...options.config,
    },
    commands: [],
    events: [],
    statuses: [],
    contexts: [],
    bufferInfoReads: 0,
    virtualTexts: [],
    virtualTextClears: [],
    agentRequests: [],
    processSpawns: [],
    processKills: 0,
    writes: [],
    removals: [],
    inserts: [],
    deletes: [],
    cursorMoves: [],
    copied: [],
  };

  function info() {
    return {
      id: 1,
      path: '/work/example.ts',
      modified: true,
      length: Buffer.byteLength(state.text, 'utf8'),
      line_count: state.text.split('\n').length,
      is_virtual: false,
      is_terminal: false,
      editing_disabled: false,
      language: 'typescript',
      is_preview: false,
      splits: [1],
      ...options.buffer,
    };
  }

  function filePath(target) {
    return typeof target === 'string' ? target : target.value;
  }

  function envelopeFor(response) {
    if (response && typeof response === 'object' && response.envelope) {
      return response.envelope;
    }
    if (response instanceof Error) {
      return { ok: false, error: { name: response.name, message: response.message } };
    }
    return { ok: true, result: response ?? { items: [] }, status: null, event: null };
  }

  function materializeResponse(responsePath) {
    if (files.has(responsePath)) return files.get(responsePath);
    const requestPath = responsePath.replace('/response-', '/request-');
    const rawRequest = files.get(requestPath);
    if (rawRequest === undefined) return null;
    const request = JSON.parse(rawRequest);
    state.agentRequests.push(request);
    const raw = JSON.stringify(envelopeFor(responses.shift()));
    files.set(responsePath, raw);
    return raw;
  }

  function backgroundHandle() {
    const pending = deferred();
    return {
      result: pending.promise,
      then: (onFulfilled, onRejected) => pending.promise.then(onFulfilled, onRejected),
      kill: () => {
        state.processKills += 1;
        pending.resolve({ process_id: 1, exit_code: -1 });
        return Promise.resolve(true);
      },
    };
  }

  const editor = {
    getActiveBufferId: () => state.activeBufferId,
    getBufferInfo: (bufferId) => {
      state.bufferInfoReads += 1;
      return bufferId === 1 ? info() : null;
    },
    getBufferText: async () => state.text,
    getCursorPosition: () => state.cursor,
    setBufferCursor: (bufferId, position) => {
      state.cursor = position;
      state.cursorMoves.push({ bufferId, position });
      return true;
    },
    deleteRange: (bufferId, start, end) => {
      state.deletes.push({ bufferId, start, end });
      if (options.deleteResult === false) return false;
      state.text = state.text.slice(0, start) + state.text.slice(end);
      return true;
    },
    insertText: (bufferId, position, text) => {
      state.inserts.push({ bufferId, position, text });
      if (insertResults.length > 0 && !insertResults.shift()) return false;
      state.text = state.text.slice(0, position) + text + state.text.slice(position);
      return true;
    },
    pathToFileUri: (value) => `file://${value}`,
    pathJoin: (...parts) => path.posix.join(...parts),
    getCwd: () => '/work',
    getTempDir: () => '/tmp',
    getPluginDir: () => '/plugins/fresh-copilot',
    localPath: (value) => ({ kind: 'local', value }),
    readFile: (target) => {
      const value = filePath(target);
      if (value === '/plugins/fresh-copilot/bin/copilot-agent.mjs') {
        return '// mocked copilot agent';
      }
      if (value.endsWith('/ready.json') && state.processSpawns.length > 0) {
        return '{"ready":true}';
      }
      if (/\/response-\d+\.json$/.test(value)) {
        return materializeResponse(value);
      }
      if (files.has(value)) return files.get(value);
      return options.undefinedForMissingFiles ? undefined : null;
    },
    writeFile: (target, content) => {
      const value = filePath(target);
      state.writes.push({ path: value, content });
      files.set(value, content);
      return true;
    },
    createDir: () => true,
    removePath: (target) => {
      const value = filePath(target);
      state.removals.push(value);
      for (const key of [...files.keys()]) {
        if (key === value || key.startsWith(`${value}/`)) files.delete(key);
      }
      return true;
    },
    workspaceTrustLevel: () => state.trust,

    defineConfigBoolean: (_name, definition) => definition.default,
    defineConfigInteger: (_name, definition) => definition.default,
    defineConfigString: (_name, definition) => definition.default,
    defineConfigStringArray: (_name, definition) => definition.default,
    getPluginConfig: () => state.config,

    addVirtualTextStyled: (bufferId, id, position, text, style, before) => {
      state.virtualTexts.push({ bufferId, id, position, text, style, before });
      return true;
    },
    removeVirtualTextsByPrefix: (bufferId, prefix) => {
      state.virtualTextClears.push({ bufferId, prefix });
      return true;
    },

    spawnBackgroundProcess: (command, args, cwd) => {
      state.processSpawns.push({ command, args, cwd });
      return backgroundHandle();
    },
    delay: (durationMs) => {
      const pending = deferred();
      delays.push({ durationMs, ...pending });
      return pending.promise;
    },

    on: (eventName, handlerName) => state.events.push({ eventName, handlerName }),
    registerCommand: (name, description, handlerName, context) => {
      state.commands.push({ name, description, handlerName, context });
      return true;
    },
    setContext: (name, active) => {
      state.contexts.push({ name, active });
      return true;
    },
    prompt: async () => options.promptResult ?? '',
    copyToClipboard: (value) => state.copied.push(value),
    setStatus: (value) => state.statuses.push(value),
    debug: () => {},
  };

  const previousGetEditor = global.getEditor;
  const previousRegisterHandler = global.registerHandler;
  global.getEditor = () => editor;
  global.registerHandler = (name, handler) => handlers.set(name, handler);
  try {
    delete require.cache[require.resolve(PLUGIN)];
    require(PLUGIN);
  } finally {
    if (previousGetEditor === undefined) delete global.getEditor;
    else global.getEditor = previousGetEditor;
    if (previousRegisterHandler === undefined) delete global.registerHandler;
    else global.registerHandler = previousRegisterHandler;
  }

  async function fire(name, payload = {}) {
    const handler = handlers.get(name);
    assert.ok(handler, `missing handler ${name}`);
    return handler(payload);
  }

  async function resolveNextDelay() {
    const pending = delays.shift();
    assert.ok(pending, 'expected a scheduled delay');
    pending.resolve();
    await flush();
    await flush();
    return pending.durationMs;
  }

  return { state, handlers, delays, fire, resolveNextDelay };
}

test('plugin registers its commands and starts the transport lazily', () => {
  const { state } = createHarness();

  assert.equal(state.processSpawns.length, 0);
  assert.ok(state.commands.some((command) => command.name === 'Copilot: Sign In'));
  assert.ok(state.commands.some((command) => command.name === 'Copilot: Accept Suggestion'));
  assert.ok(state.events.some((event) => event.eventName === 'after_insert'));
});

test('an edit starts one agent, synchronizes the file, and renders a completion', async () => {
  const harness = createHarness({
    undefinedForMissingFiles: true,
    responses: [
      {
        items: [
          {
            insertText: '42;',
            command: { command: 'github.copilot.didAcceptCompletionItem', arguments: ['id'] },
          },
        ],
      },
    ],
  });

  await harness.fire('fresh_copilot_after_insert', { buffer_id: 1 });
  assert.equal(harness.state.bufferInfoReads, 0);
  assert.equal(await harness.resolveNextDelay(), 350);

  assert.equal(harness.state.bufferInfoReads, 1);
  assert.equal(harness.state.processSpawns.length, 1);
  assert.equal(harness.state.processSpawns[0].command, 'node');
  assert.equal(harness.state.agentRequests[0].method, 'textDocument/inlineCompletion');
  assert.equal(harness.state.agentRequests[0].document.text, 'const answer = ');
  assert.deepEqual(harness.state.agentRequests[0].params.position, {
    line: 0,
    character: 15,
  });
  assert.equal(harness.state.virtualTexts.at(-1).text, '42;');
  assert.equal(harness.state.virtualTexts.at(-1).style.fg, 'ui.suggestion_fg');
});

test('rapid edits share one debounce timer and skip empty ghost-text clears', async () => {
  const harness = createHarness({
    responses: [{ items: [{ insertText: '42;' }] }],
  });

  await harness.fire('fresh_copilot_after_insert', { buffer_id: 1 });
  await harness.fire('fresh_copilot_after_insert', { buffer_id: 1 });
  await harness.fire('fresh_copilot_after_insert', { buffer_id: 1 });

  assert.equal(harness.delays.length, 1);
  assert.equal(harness.state.bufferInfoReads, 0);
  assert.equal(harness.state.virtualTextClears.length, 0);

  await harness.resolveNextDelay();
  assert.equal(harness.delays.length, 1, 'only the latest edit gets a follow-up timer');
  assert.equal(harness.state.agentRequests.length, 0);

  await harness.resolveNextDelay();
  assert.equal(harness.state.bufferInfoReads, 1);
  assert.equal(harness.state.agentRequests.length, 1);
});

test('accept applies the completion and acknowledges it through the same agent', async () => {
  const harness = createHarness({
    responses: [
      {
        items: [
          {
            insertText: '42;',
            command: { command: 'github.copilot.didAcceptCompletionItem', arguments: ['id'] },
          },
        ],
      },
      null,
    ],
  });

  await harness.fire('fresh_copilot_after_insert', { buffer_id: 1 });
  await harness.resolveNextDelay();
  await harness.fire('fresh_copilot_accept');

  assert.equal(harness.state.text, 'const answer = 42;');
  assert.equal(harness.state.cursor, 18);
  assert.equal(harness.state.processSpawns.length, 1);
  assert.equal(harness.state.agentRequests.at(-1).method, 'workspace/executeCommand');
});

test('a failed replacement restores the original text', async () => {
  const harness = createHarness({
    text: 'const foo',
    insertResults: [false, true],
    responses: [
      {
        items: [
          {
            insertText: 'foobar',
            range: {
              start: { line: 0, character: 6 },
              end: { line: 0, character: 9 },
            },
          },
        ],
      },
    ],
  });

  await harness.fire('fresh_copilot_after_insert', { buffer_id: 1 });
  await harness.resolveNextDelay();
  await harness.fire('fresh_copilot_accept');

  assert.equal(harness.state.text, 'const foo');
  assert.match(harness.state.statuses.at(-1), /original text was restored/);
});

test('quota status pauses future automatic requests without spamming', async () => {
  const harness = createHarness({
    responses: [
      {
        envelope: {
          ok: true,
          result: { items: [] },
          status: { kind: 'Inactive', message: 'monthly usage limit reached' },
          statusVersion: 1,
        },
      },
      {
        envelope: {
          ok: true,
          result: { items: [{ insertText: '42;' }] },
          status: { kind: 'Inactive', message: 'monthly usage limit reached' },
          statusVersion: 1,
        },
      },
    ],
  });

  await harness.fire('fresh_copilot_after_insert', { buffer_id: 1 });
  await harness.resolveNextDelay();
  assert.equal(harness.state.agentRequests.length, 1);
  assert.match(harness.state.statuses.at(-1), /usage limit reached/);
  assert.match(harness.state.statuses.at(-1), /1 day/);

  await harness.fire('fresh_copilot_after_insert', { buffer_id: 1 });
  assert.equal(harness.delays.length, 0);
  assert.equal(harness.state.agentRequests.length, 1);

  await harness.fire('fresh_copilot_complete');
  await flush();
  await flush();
  assert.equal(harness.state.virtualTexts.at(-1).text, '42;');

  await harness.fire('fresh_copilot_after_insert', { buffer_id: 1 });
  assert.equal(harness.delays.length, 1, 'a successful manual retry resumes automatic requests');
});

test('disabled languages and untrusted workspaces never start a process', async () => {
  const disabled = createHarness({ buffer: { language: 'text' } });
  await disabled.fire('fresh_copilot_after_insert', { buffer_id: 1 });
  await disabled.resolveNextDelay();
  assert.equal(disabled.state.processSpawns.length, 0);

  const untrusted = createHarness({ trust: 'restricted' });
  await untrusted.fire('fresh_copilot_complete');
  assert.equal(untrusted.state.processSpawns.length, 0);
  assert.match(untrusted.state.statuses.at(-1), /Trust this workspace/);
});

test('device sign-in uses one persistent server for both protocol steps', async () => {
  const harness = createHarness({
    promptResult: '',
    responses: [
      {
        verificationUri: 'https://github.com/login/device',
        userCode: 'ABCD-1234',
      },
      { status: 'OK', user: 'octocat' },
    ],
  });

  await harness.fire('fresh_copilot_sign_in');

  assert.deepEqual(harness.state.copied, ['ABCD-1234']);
  assert.deepEqual(
    harness.state.agentRequests.slice(0, 2).map((request) => request.method),
    ['signIn', 'signInConfirm'],
  );
  assert.equal(harness.state.processSpawns.length, 1);
  assert.match(harness.state.statuses.at(-1), /signed in/);
});
