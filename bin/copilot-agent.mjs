import { spawn } from "node:child_process";
import {
  appendFileSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  unwatchFile,
  watch,
  watchFile,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

const configPath = process.argv[2];
if (!configPath) {
  process.stderr.write("usage: node copilot-agent.mjs CONFIG_PATH\n");
  process.exit(2);
}

const config = JSON.parse(readFileSync(configPath, "utf8"));
const sessionDir = config.sessionDir;
const readyPath = join(sessionDir, "ready.json");
const fatalPath = join(sessionDir, "fatal.json");
const statusPath = join(sessionDir, "status.json");
const logPath = join(sessionDir, "server.log");
const shutdownPath = join(sessionDir, "shutdown.json");
const initialParentPid = process.ppid;

const RESPONSE_MAX_AGE_MS = 60_000;
const SESSION_FILE_PATTERN =
  /^(copilot-agent\.mjs|config\.json|ready\.json|fatal\.json|status\.json|server\.log|shutdown\.json|(request|response)-\d+\.json)(\.\d+\.tmp)?$/;

function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, path);
}

function removeSessionDir() {
  let entries = [];
  try {
    entries = readdirSync(sessionDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!SESSION_FILE_PATTERN.test(entry)) continue;
    try {
      unlinkSync(join(sessionDir, entry));
    } catch {
      // Already gone or not ours to remove.
    }
  }
  try {
    rmdirSync(sessionDir);
  } catch {
    // Unknown files remain, or the editor already discarded the directory.
  }
}

function sweepStaleResponses() {
  let entries;
  try {
    entries = readdirSync(sessionDir).filter((entry) =>
      /^response-\d+\.json$/.test(entry),
    );
  } catch {
    return;
  }
  const cutoff = Date.now() - RESPONSE_MAX_AGE_MS;
  for (const entry of entries) {
    const path = join(sessionDir, entry);
    try {
      if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
    } catch {
      // The plugin may be reading it right now; try again next sweep.
    }
  }
}

function shutdownRequested() {
  try {
    statSync(shutdownPath);
    return true;
  } catch {
    return false;
  }
}

function serializeError(error) {
  if (error && typeof error === "object") {
    return {
      name: typeof error.name === "string" ? error.name : "Error",
      message:
        typeof error.message === "string" ? error.message : JSON.stringify(error),
      code: error.code,
      data: error.data,
    };
  }
  return { name: "Error", message: String(error) };
}

class JsonRpcClient {
  constructor(command, args, cwd) {
    this.buffer = Buffer.alloc(0);
    this.documents = new Map();
    this.latestEvent = null;
    this.latestStatus = null;
    this.eventVersion = 0;
    this.statusVersion = 0;
    this.nextId = 1;
    this.pending = new Map();
    this.stopping = false;

    this.child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
    this.child.stderr.on("data", (chunk) => {
      try {
        appendFileSync(logPath, chunk);
      } catch {
        // Logging must never break completion transport.
      }
    });
    this.child.on("error", (error) => this.failAll(error));
    this.child.on("exit", (code, signal) => {
      if (!this.stopping) {
        this.failAll(
          new Error(
            `Copilot language server exited (code=${String(code)}, signal=${String(signal)})`,
          ),
        );
      }
    });
  }

  send(message) {
    const json = JSON.stringify(message);
    this.child.stdin.write(
      `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`,
    );
  }

  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  request(method, params, timeoutMs = 30_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.notify("$/cancelRequest", { id });
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  respond(id, result) {
    this.send({ jsonrpc: "2.0", id, result });
  }

  updateStatus(value) {
    this.latestStatus = value;
    this.statusVersion += 1;
    try {
      writeJsonAtomic(statusPath, value);
    } catch {
      // Status is advisory; RPC responses still carry the latest value.
    }
  }

  handleServerCall(message) {
    const method = message.method;
    const params = message.params ?? {};

    if (message.id !== undefined) {
      if (method === "workspace/configuration") {
        const items = Array.isArray(params.items) ? params.items : [];
        this.respond(message.id, items.map(() => null));
      } else if (method === "workspace/workspaceFolders") {
        this.respond(message.id, []);
      } else if (method === "window/showDocument") {
        this.respond(message.id, { success: false });
      } else if (method === "window/showMessageRequest") {
        this.latestEvent = params;
        this.eventVersion += 1;
        this.respond(message.id, null);
      } else {
        this.respond(message.id, null);
      }
      return;
    }

    if (method === "didChangeStatus") {
      this.updateStatus(params);
    } else if (method === "window/showMessage") {
      this.latestEvent = params;
      this.eventVersion += 1;
    }
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.failAll(new Error(`Invalid LSP header: ${header}`));
        return;
      }
      const length = Number(match[1]);
      const messageEnd = headerEnd + 4 + length;
      if (this.buffer.length < messageEnd) return;
      const body = this.buffer.subarray(headerEnd + 4, messageEnd).toString("utf8");
      this.buffer = this.buffer.subarray(messageEnd);

      let message;
      try {
        message = JSON.parse(body);
      } catch (error) {
        this.failAll(error);
        return;
      }

      if (message.id !== undefined && !message.method) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error !== undefined) {
          const rpcError = new Error(message.error.message ?? JSON.stringify(message.error));
          rpcError.code = message.error.code;
          rpcError.data = message.error.data;
          pending.reject(rpcError);
        } else {
          pending.resolve(message.result);
        }
      } else if (message.method) {
        this.handleServerCall(message);
      }
    }
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (!this.stopping) {
      try {
        writeJsonAtomic(fatalPath, serializeError(error));
      } catch {
        // There is nowhere else reliable to report a bridge failure.
      }
    }
  }

  async initialize() {
    await this.request(
      "initialize",
      {
        processId: process.pid,
        rootUri: config.rootUri ?? null,
        workspaceFolders: config.rootUri
          ? [{ uri: config.rootUri, name: basename(config.cwd) || "workspace" }]
          : null,
        capabilities: {
          workspace: {
            configuration: true,
            workspaceFolders: true,
          },
          window: {
            showDocument: { support: false },
          },
          textDocument: {
            synchronization: { dynamicRegistration: false },
            inlineCompletion: { dynamicRegistration: false },
          },
        },
        initializationOptions: config.initializationOptions,
      },
      30_000,
    );
    this.notify("initialized", {});
  }

  async syncDocument(document) {
    const previous = this.documents.get(document.uri);
    if (!previous) {
      const version = 0;
      this.notify("textDocument/didOpen", {
        textDocument: {
          uri: document.uri,
          languageId: document.languageId,
          version,
          text: document.text,
        },
      });
      this.documents.set(document.uri, { text: document.text, version });
      return version;
    }
    if (previous.text !== document.text) {
      const version = previous.version + 1;
      this.notify("textDocument/didChange", {
        textDocument: { uri: document.uri, version },
        contentChanges: [{ text: document.text }],
      });
      this.documents.set(document.uri, { text: document.text, version });
      return version;
    }
    return previous.version;
  }

  closeDocument(uri) {
    if (this.documents.delete(uri)) {
      this.notify("textDocument/didClose", { textDocument: { uri } });
    }
  }

  async stop() {
    this.stopping = true;
    try {
      await this.request("shutdown", null, 2000);
      this.notify("exit", null);
    } catch {
      this.child.kill();
    }
  }
}

let client;
let documentSync = Promise.resolve();
let lastActivity = Date.now();
const claimed = new Set();
let requestScanQueued = false;

function queueDocumentOperation(operation) {
  const queued = documentSync.then(operation);
  documentSync = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued;
}

async function processRequest(path) {
  let request;
  try {
    request = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    writeJsonAtomic(path.replace("request-", "response-"), {
      ok: false,
      error: serializeError(error),
    });
    try {
      unlinkSync(path);
    } catch {
      // The plugin may already have removed a timed-out request.
    }
    return;
  }

  const responsePath = join(sessionDir, `response-${request.id}.json`);
  lastActivity = Date.now();
  try {
    let version;
    if (request.document) {
      version = await queueDocumentOperation(() =>
        client.syncDocument(request.document),
      );
    }

    let result;
    if (request.method === "fresh/didClose") {
      await queueDocumentOperation(() =>
        client.closeDocument(request.params.uri),
      );
      result = null;
    } else if (request.method === "fresh/ping") {
      result = { ready: true };
    } else {
      const params = request.params ?? {};
      if (
        version !== undefined &&
        params.textDocument &&
        typeof params.textDocument === "object"
      ) {
        params.textDocument.version = version;
      }
      const timeout = request.method === "signInConfirm" ? 180_000 : 30_000;
      result = await client.request(request.method, params, timeout);
    }

    writeJsonAtomic(responsePath, {
      ok: true,
      result,
      status: client.latestStatus,
      statusVersion: client.statusVersion,
      event: client.latestEvent,
      eventVersion: client.eventVersion,
    });
    client.latestEvent = null;
  } catch (error) {
    writeJsonAtomic(responsePath, {
      ok: false,
      error: serializeError(error),
      status: client?.latestStatus ?? null,
      statusVersion: client?.statusVersion ?? 0,
      event: client?.latestEvent ?? null,
      eventVersion: client?.eventVersion ?? 0,
    });
    if (client) client.latestEvent = null;
  } finally {
    try {
      unlinkSync(path);
    } catch {
      // The plugin may already have removed a timed-out request.
    }
  }
}

function scanRequests() {
  if (shutdownRequested()) {
    void shutdown(0);
    return;
  }
  let entries;
  try {
    entries = readdirSync(sessionDir)
      .filter((entry) => /^request-\d+\.json$/.test(entry))
      .sort();
  } catch {
    return;
  }
  for (const entry of entries) {
    if (claimed.has(entry)) continue;
    claimed.add(entry);
    const request = processRequest(join(sessionDir, entry));
    void request.then(
      () => claimed.delete(entry),
      (error) => {
        claimed.delete(entry);
        try {
          appendFileSync(
            logPath,
            `[fresh-copilot] request ${entry} failed: ${serializeError(error).message}\n`,
          );
        } catch {
          // Logging must never break completion transport.
        }
      },
    );
  }
}

function queueRequestScan() {
  if (requestScanQueued) return;
  requestScanQueued = true;
  setImmediate(() => {
    requestScanQueued = false;
    scanRequests();
  });
}

function onRequestDirectoryChanged(current, previous) {
  if (current.mtimeMs !== previous.mtimeMs || current.ctimeMs !== previous.ctimeMs) {
    queueRequestScan();
  }
}

function startRequestStatWatcher() {
  if (requestStatWatcherActive) return;
  requestStatWatcherActive = true;
  try {
    watchFile(
      sessionDir,
      { persistent: false, interval: 50 },
      onRequestDirectoryChanged,
    );
  } catch {
    requestStatWatcherActive = false;
  }
}

let shuttingDown = false;

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(requestTimer);
  clearInterval(lifecycleTimer);
  if (requestWatcher) {
    try {
      requestWatcher.close();
    } catch {
      // The watcher may already have closed during shutdown.
    }
  }
  if (requestStatWatcherActive) {
    unwatchFile(sessionDir, onRequestDirectoryChanged);
    requestStatWatcherActive = false;
  }
  if (client) await client.stop();
  removeSessionDir();
  process.exit(code);
}

function exitAfterFatal() {
  const started = Date.now();
  const timer = setInterval(() => {
    let parentGone = false;
    if (initialParentPid > 1) {
      try {
        process.kill(initialParentPid, 0);
      } catch {
        parentGone = true;
      }
    }
    if (shutdownRequested() || parentGone || Date.now() - started > 60_000) {
      clearInterval(timer);
      if (client) client.child.kill();
      removeSessionDir();
      process.exit(1);
    }
  }, 200);
}

let requestTimer;
let lifecycleTimer;
let requestWatcher;
let requestStatWatcherActive = false;

try {
  client = new JsonRpcClient(config.serverCommand, config.serverArgs, config.cwd);
  await client.initialize();
  writeJsonAtomic(readyPath, { ready: true, pid: process.pid });
} catch (error) {
  writeJsonAtomic(fatalPath, serializeError(error));
  exitAfterFatal();
  await new Promise(() => {});
}

try {
  requestWatcher = watch(sessionDir, { persistent: false }, (_eventType, filename) => {
    if (
      filename === null ||
      /^(request-\d+|shutdown)\.json$/.test(String(filename))
    ) {
      queueRequestScan();
    }
  });
  const watcher = requestWatcher;
  watcher.on("error", () => {
    try {
      watcher.close();
    } catch {
      // The watcher may already be closed after emitting its error.
    }
    if (requestWatcher === watcher) requestWatcher = undefined;
    startRequestStatWatcher();
  });
} catch {
  startRequestStatWatcher();
}
scanRequests();
requestTimer = setInterval(() => {
  scanRequests();
  sweepStaleResponses();
}, 1000);
lifecycleTimer = setInterval(() => {
  if (Date.now() - lastActivity > 30 * 60_000) {
    void shutdown(0);
    return;
  }
  if (initialParentPid > 1) {
    try {
      process.kill(initialParentPid, 0);
    } catch {
      void shutdown(0);
    }
  }
}, 5000);

process.on("SIGTERM", () => void shutdown(0));
process.on("SIGINT", () => void shutdown(0));
