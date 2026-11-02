'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const AGENT = path.resolve(__dirname, '../bin/copilot-agent.mjs');
const FAKE_SERVER = path.resolve(__dirname, 'fixtures/fake-copilot-server.mjs');

async function waitForFile(filePath, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

function request(sessionDir, id, method, params, document) {
  const padded = String(id).padStart(10, '0');
  fs.writeFileSync(
    path.join(sessionDir, `request-${padded}.json`),
    JSON.stringify({ id: padded, method, params, document }),
  );
  return waitForFile(path.join(sessionDir, `response-${padded}.json`)).then(JSON.parse);
}

function traceMessages(tracePath) {
  return fs
    .readFileSync(tracePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse);
}

test('agent keeps one server alive, synchronizes documents, and forwards requests', async (t) => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-copilot-agent-test-'));
  const tracePath = path.join(sessionDir, 'trace.jsonl');
  fs.writeFileSync(tracePath, '');
  const configPath = path.join(sessionDir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      sessionDir,
      cwd: sessionDir,
      rootUri: `file://${sessionDir}`,
      serverCommand: process.execPath,
      serverArgs: [FAKE_SERVER, tracePath],
      initializationOptions: {
        editorInfo: { name: 'Fresh', version: 'test' },
        editorPluginInfo: { name: 'fresh-copilot', version: 'test' },
      },
    }),
  );

  const agent = spawn(process.execPath, [AGENT, configPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  agent.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  t.after(async () => {
    agent.kill('SIGTERM');
    await new Promise((resolve) => agent.once('exit', resolve));
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  await waitForFile(path.join(sessionDir, 'ready.json'));
  const uri = 'file:///work/example.ts';
  const document = { uri, languageId: 'typescript', text: 'const answer = ' };
  const first = await request(
    sessionDir,
    1,
    'textDocument/inlineCompletion',
    {
      textDocument: { uri },
      position: { line: 0, character: 15 },
      context: { triggerKind: 2 },
    },
    document,
  );

  assert.equal(first.ok, true, stderr);
  assert.equal(first.result.items[0].insertText, '42;');
  const firstTrace = traceMessages(tracePath);
  const didOpen = firstTrace.find((message) => message.method === 'textDocument/didOpen');
  const completion = firstTrace.find(
    (message) => message.method === 'textDocument/inlineCompletion',
  );
  assert.equal(didOpen.params.textDocument.text, 'const answer = ');
  assert.equal(completion.params.textDocument.version, 0);

  const changed = { ...document, text: 'const answer = 4' };
  const second = await request(
    sessionDir,
    2,
    'textDocument/inlineCompletion',
    {
      textDocument: { uri },
      position: { line: 0, character: 16 },
      context: { triggerKind: 2 },
    },
    changed,
  );
  assert.equal(second.ok, true, stderr);
  const secondTrace = traceMessages(tracePath);
  const didChange = secondTrace.find(
    (message) => message.method === 'textDocument/didChange',
  );
  assert.equal(didChange.params.textDocument.version, 1);
  assert.equal(didChange.params.contentChanges[0].text, 'const answer = 4');

  const signIn = await request(sessionDir, 3, 'signIn', {}, undefined);
  const confirmation = await request(sessionDir, 4, 'signInConfirm', {}, undefined);
  assert.equal(signIn.result.userCode, 'TEST-CODE');
  assert.deepEqual(confirmation.result, { status: 'OK', user: 'tester' });

  const quota = await request(
    sessionDir,
    5,
    'textDocument/inlineCompletion',
    {
      textDocument: { uri },
      position: { line: 0, character: 99 },
      context: { triggerKind: 2 },
    },
    changed,
  );
  assert.equal(quota.ok, true);
  assert.equal(quota.status.message, 'monthly usage limit reached');

  const closed = await request(sessionDir, 6, 'fresh/didClose', { uri }, undefined);
  assert.equal(closed.ok, true);
  assert.ok(
    traceMessages(tracePath).some((message) => message.method === 'textDocument/didClose'),
  );
});

function startAgent(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-copilot-agent-test-'));
  const sessionDir = path.join(root, 'session');
  fs.mkdirSync(sessionDir);
  const tracePath = path.join(root, 'trace.jsonl');
  fs.writeFileSync(tracePath, '');
  const configPath = path.join(sessionDir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      sessionDir,
      cwd: root,
      rootUri: `file://${root}`,
      serverCommand: options.serverCommand ?? process.execPath,
      serverArgs: options.serverArgs ?? [FAKE_SERVER, tracePath],
      initializationOptions: {},
    }),
  );
  const agent = spawn(process.execPath, [AGENT, configPath], {
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise((resolve) => agent.once('exit', (code) => resolve(code)));
  t.after(async () => {
    if (agent.exitCode === null) agent.kill('SIGKILL');
    await exited;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { agent, exited, root, sessionDir, tracePath };
}

test('a shutdown request stops the server and removes only session files', async (t) => {
  const { exited, root, sessionDir, tracePath } = startAgent(t);
  await waitForFile(path.join(sessionDir, 'ready.json'));
  await request(sessionDir, 1, 'fresh/ping', {}, undefined);

  // A file the transport did not create must survive, and a symlink inside the
  // session must be unlinked rather than followed.
  const outside = path.join(root, 'outside.txt');
  fs.writeFileSync(outside, 'keep me');
  fs.symlinkSync(outside, path.join(sessionDir, 'response-0000000099.json'));

  fs.writeFileSync(path.join(sessionDir, 'shutdown.json'), '{}');
  assert.equal(await exited, 0);
  assert.equal(fs.existsSync(sessionDir), false);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep me');
  assert.ok(traceMessages(tracePath).some((message) => message.method === 'shutdown'));
});

test('a shutdown request during initialization cleans up within the plugin grace period', async (t) => {
  const { exited, sessionDir } = startAgent(t, {
    serverArgs: [
      '-e',
      'process.stdin.once("data", () => process.stderr.write("initializing\\n")); process.stdin.resume();',
    ],
  });
  await waitForFile(path.join(sessionDir, 'server.log'));
  assert.equal(fs.existsSync(path.join(sessionDir, 'ready.json')), false);

  fs.writeFileSync(path.join(sessionDir, 'shutdown.json'), '{}');
  let timer;
  try {
    const code = await Promise.race([
      exited,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('shutdown exceeded the plugin grace period')), 3000);
      }),
    ]);
    assert.equal(code, 0);
  } finally {
    clearTimeout(timer);
  }

  assert.equal(fs.existsSync(sessionDir), false);
});

test('unknown files keep the session directory in place', async (t) => {
  const { exited, sessionDir } = startAgent(t);
  await waitForFile(path.join(sessionDir, 'ready.json'));
  fs.writeFileSync(path.join(sessionDir, 'notes.txt'), 'not ours');

  fs.writeFileSync(path.join(sessionDir, 'shutdown.json'), '{}');
  assert.equal(await exited, 0);
  assert.deepEqual(fs.readdirSync(sessionDir), ['notes.txt']);
});

test('stale responses are swept while fresh ones are kept', async (t) => {
  const { sessionDir } = startAgent(t);
  await waitForFile(path.join(sessionDir, 'ready.json'));
  const stale = path.join(sessionDir, 'response-0000000001.json');
  const fresh = path.join(sessionDir, 'response-0000000002.json');
  fs.writeFileSync(stale, '{}');
  fs.writeFileSync(fresh, '{}');
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(stale, old, old);

  const started = Date.now();
  while (fs.existsSync(stale) && Date.now() - started < 5000) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(fresh), true);
});

function installFakeServerPackage(root, { native }) {
  const markerPath = path.join(root, 'server-used');
  const wrapper = (name) =>
    `#!/bin/sh\nprintf ${name} > ${JSON.stringify(markerPath)}\n` +
    `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_SERVER)} "$@"\n`;
  const packageDir = path.join(root, 'lib', 'copilot-language-server');
  const launcher = path.join(packageDir, 'dist', 'language-server.js');
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(launcher, wrapper('launcher'), { mode: 0o755 });
  if (native) {
    const nativePath = path.join(
      packageDir,
      'node_modules',
      '@github',
      `copilot-language-server-${process.platform}-${process.arch}`,
      'copilot-language-server',
    );
    fs.mkdirSync(path.dirname(nativePath), { recursive: true });
    fs.writeFileSync(nativePath, wrapper('native'), { mode: 0o755 });
  }
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir);
  fs.symlinkSync(launcher, path.join(binDir, 'copilot-language-server'));
  return { binDir, markerPath };
}

for (const [native, expected] of [
  [true, 'native'],
  [false, 'launcher'],
]) {
  test(
    `the default server command runs the ${expected} server on macOS`,
    { skip: process.platform !== 'darwin' },
    async (t) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-copilot-package-'));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const { binDir, markerPath } = installFakeServerPackage(root, { native });
      const tracePath = path.join(root, 'trace.jsonl');
      fs.writeFileSync(tracePath, '');

      const { sessionDir } = startAgent(t, {
        serverCommand: 'copilot-language-server',
        serverArgs: [tracePath],
        env: { ...process.env, PATH: binDir },
      });
      await waitForFile(path.join(sessionDir, 'ready.json'));
      assert.equal(fs.readFileSync(markerPath, 'utf8'), expected);
    },
  );
}

test('a startup failure keeps fatal.json until the plugin asks to stop', async (t) => {
  const { agent, exited, sessionDir } = startAgent(t, {
    serverCommand: path.join(os.tmpdir(), 'fresh-copilot-missing-server'),
    serverArgs: [],
  });
  const fatal = JSON.parse(await waitForFile(path.join(sessionDir, 'fatal.json')));
  assert.match(fatal.message, /ENOENT/);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(agent.exitCode, null);

  fs.writeFileSync(path.join(sessionDir, 'shutdown.json'), '{}');
  assert.equal(await exited, 1);
  assert.equal(fs.existsSync(sessionDir), false);
});
