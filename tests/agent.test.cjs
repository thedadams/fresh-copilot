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
