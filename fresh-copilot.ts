import {
  buildCompletionEdit,
  buildInlineEdit,
  classifyFailure,
  createTextSnapshot,
  errorText,
  formatGhostSuggestion,
  parseInlineCompletionResponse,
  parseInlineEditResponse,
  statusNeedsSignIn,
  statusText,
  utf8ByteLength,
} from "./src/core";

type InlineCompletionItem = ReturnType<typeof parseInlineCompletionResponse>[number];
type InlineEditItem = ReturnType<typeof parseInlineEditResponse>[number];
type SuggestionItem = InlineCompletionItem | InlineEditItem;
type SuggestionRequestMode = "auto" | "completion" | "next-edit";

const editor = getEditor();

const PLUGIN_VERSION = "0.1.0";
const GHOST_PREFIX = "fresh-copilot:";
const GHOST_ID = `${GHOST_PREFIX}suggestion`;
const GHOST_NAMESPACE = "fresh-copilot-suggestion";
const SUGGESTION_CONTEXT = "fresh-copilot-suggestion-visible";
const SUGGESTION_MODE = "fresh-copilot-suggestion";
const SUGGESTION_VI_INSERT_MODE = "fresh-copilot-suggestion-vi-insert";
const DEFAULT_DISABLED_LANGUAGES = [
  "diff",
  "git-commit",
  "gitcommit",
  "log",
  "plaintext",
  "text",
];
const SESSION_TOKEN =
  Date.now().toString(36) +
  "-" +
  Math.floor(Math.random() * 0x100000000).toString(36);

interface PluginConfig {
  enabled?: boolean;
  automatic?: boolean;
  nextEditSuggestions?: boolean;
  debounceMs?: number;
  maxFileSizeKb?: number;
  disabledLanguages?: string[];
  nodeCommand?: string;
  serverCommand?: string;
  serverArgs?: string[];
  quotaCooldownMinutes?: number;
  debug?: boolean;
}

interface ResolvedConfig {
  enabled: boolean;
  automatic: boolean;
  nextEditSuggestions: boolean;
  debounceMs: number;
  maxFileSizeKb: number;
  disabledLanguages: string[];
  nodeCommand: string;
  serverCommand: string;
  serverArgs: string[];
  quotaCooldownMinutes: number;
  debug: boolean;
}

interface ActiveSuggestion {
  kind: "completion" | "next-edit";
  bufferId: number;
  revision: number;
  cursor: number;
  item: SuggestionItem;
  start: number;
  end: number;
  insertText: string;
  replacedText: string;
}

interface PauseState {
  kind: "quota" | "authentication" | "server-missing" | "transient";
  message: string;
  until: number | null;
}

interface ScheduledCompletion {
  bufferId: number;
  generation: number;
  dueAt: number;
}

interface BufferEvent {
  buffer_id: number;
}

interface AgentDocument {
  uri: string;
  languageId: string;
  text: string;
}

interface AgentEnvelope {
  ok: boolean;
  result?: unknown;
  error?: unknown;
  status?: unknown;
  statusVersion?: number;
  event?: unknown;
  eventVersion?: number;
}

editor.defineConfigBoolean("enabled", {
  default: true,
  description: "Enable GitHub Copilot code completions",
});
editor.defineConfigBoolean("automatic", {
  default: true,
  description: "Request completions automatically while editing",
});
editor.defineConfigBoolean("nextEditSuggestions", {
  default: true,
  description: "Predict edits elsewhere in the current file after changes",
});
editor.defineConfigInteger("debounceMs", {
  default: 350,
  minimum: 100,
  maximum: 5000,
  description: "Delay after an edit before requesting a completion",
});
editor.defineConfigInteger("maxFileSizeKb", {
  default: 512,
  minimum: 16,
  maximum: 16384,
  description: "Do not request completions for files larger than this",
});
editor.defineConfigStringArray("disabledLanguages", {
  default: DEFAULT_DISABLED_LANGUAGES,
  description: "Fresh language IDs where Copilot should remain off",
});
editor.defineConfigString("nodeCommand", {
  default: "node",
  description: "Node.js executable used for the private Copilot transport",
});
editor.defineConfigString("serverCommand", {
  default: "copilot-language-server",
  description: "GitHub Copilot language-server executable",
});
editor.defineConfigStringArray("serverArgs", {
  default: ["--stdio"],
  description: "Arguments passed to the Copilot language server",
});
editor.defineConfigInteger("quotaCooldownMinutes", {
  default: 1440,
  minimum: 1,
  maximum: 10080,
  description: "How long automatic requests pause after a usage-limit response",
});
editor.defineConfigBoolean("debug", {
  default: false,
  description: "Write Fresh Copilot diagnostics to the plugin log",
});

let config = readConfig();
let activeSuggestion: ActiveSuggestion | null = null;
let suggestionModeActive = false;
let suggestionPreviousMode: string | null = null;
let activeSuggestionMode: string | null = null;
let pauseState: PauseState | null = null;
let requestGeneration = 0;
let scheduledCompletion: ScheduledCompletion | null = null;
let completionScheduler: Promise<void> | null = null;
let transientFailures = 0;
let quotaNoticeShown = false;
let agentHandle: ProcessHandle<BackgroundProcessResult> | null = null;
let agentReady = false;
let agentStartPromise: Promise<void> | null = null;
let agentSessionDir = "";
let agentFailure = "";
let agentStartCount = 0;
let rpcCounter = 0;
let lastAgentStatusVersion = 0;
let lastAgentEventVersion = 0;
const revisions = new Map<number, number>();
const documentUris = new Map<number, string>();

function readConfig(): ResolvedConfig {
  const value = editor.getPluginConfig<PluginConfig>() ?? {};
  return {
    enabled: value.enabled ?? true,
    automatic: value.automatic ?? true,
    nextEditSuggestions: value.nextEditSuggestions ?? true,
    debounceMs: value.debounceMs ?? 350,
    maxFileSizeKb: value.maxFileSizeKb ?? 512,
    disabledLanguages: (value.disabledLanguages ?? DEFAULT_DISABLED_LANGUAGES).map(
      (language) => language.toLowerCase(),
    ),
    nodeCommand: value.nodeCommand?.trim() || "node",
    serverCommand: value.serverCommand?.trim() || "copilot-language-server",
    serverArgs: value.serverArgs ?? ["--stdio"],
    quotaCooldownMinutes: value.quotaCooldownMinutes ?? 1440,
    debug: value.debug ?? false,
  };
}

function debug(message: string): void {
  if (config.debug) {
    editor.debug(`[fresh-copilot] ${message}`);
  }
}

function revision(bufferId: number): number {
  return revisions.get(bufferId) ?? 0;
}

function bumpRevision(bufferId: number): void {
  revisions.set(bufferId, revision(bufferId) + 1);
}

function activateSuggestionMode(): void {
  if (suggestionModeActive) return;
  const previousMode = editor.getEditorMode();
  const mode =
    previousMode === null
      ? SUGGESTION_MODE
      : previousMode === "vi-insert"
        ? SUGGESTION_VI_INSERT_MODE
        : null;
  if (mode === null) return;
  suggestionPreviousMode = previousMode;
  activeSuggestionMode = mode;
  suggestionModeActive = editor.setEditorMode(mode);
  if (!suggestionModeActive) {
    suggestionPreviousMode = null;
    activeSuggestionMode = null;
  }
}

function deactivateSuggestionMode(): void {
  if (!suggestionModeActive) return;
  const previousMode = suggestionPreviousMode;
  const mode = activeSuggestionMode;
  suggestionModeActive = false;
  suggestionPreviousMode = null;
  activeSuggestionMode = null;
  if (editor.getEditorMode() === mode) {
    editor.setEditorMode(previousMode);
  }
}

function clearSuggestion(bufferId?: number): void {
  const suggestion = activeSuggestion;
  if (suggestion === null) return;

  const target = bufferId ?? suggestion.bufferId;
  if (target !== suggestion.bufferId) return;

  editor.removeVirtualTextsByPrefix(target, GHOST_PREFIX);
  editor.clearVirtualTextNamespace(target, GHOST_NAMESPACE);
  editor.clearNamespace(target, GHOST_NAMESPACE);
  activeSuggestion = null;
  editor.setContext(SUGGESTION_CONTEXT, false);
  deactivateSuggestionMode();
}

function renderSuggestion(
  bufferId: number,
  position: number,
  previewText: string,
  replacementStart: number,
  replacementEnd: number,
  kind: "completion" | "next-edit",
  showReplacement: boolean,
): boolean {
  const preview = formatGhostSuggestion(previewText);
  const displayPosition = showReplacement ? replacementEnd : position;
  const prefix = showReplacement ? " → " : kind === "next-edit" ? "→ " : "";
  const inline =
    preview.inline.length > 0
      ? `${prefix}${preview.inline}`
      : showReplacement
        ? " → delete"
        : "";
  if (inline.length > 0) {
    editor.addVirtualTextStyled(
      bufferId,
      GHOST_ID,
      displayPosition,
      inline,
      { fg: "ui.suggestion_fg", italic: true },
      true,
    );
  }
  preview.lines.forEach((line, index) => {
    editor.addVirtualLine(
      bufferId,
      displayPosition,
      line,
      { fg: "ui.suggestion_fg", italic: true },
      false,
      GHOST_NAMESPACE,
      index,
    );
  });
  if (showReplacement) {
    editor.addOverlay(
      bufferId,
      GHOST_NAMESPACE,
      replacementStart,
      replacementEnd,
      { underline: true },
    );
  }
  return inline.length > 0 || preview.lines.length > 0 || showReplacement;
}

function eligibleBufferInfo(bufferId: number): BufferInfo | null {
  const info = editor.getBufferInfo(bufferId);
  if (
    !config.enabled ||
    info === null ||
    info.path.length === 0 ||
    info.is_virtual ||
    info.is_terminal ||
    info.editing_disabled ||
    info.is_preview ||
    info.length > config.maxFileSizeKb * 1024
  ) {
    return null;
  }
  return config.disabledLanguages.includes(info.language.toLowerCase()) ? null : info;
}

function currentPause(): PauseState | null {
  if (
    pauseState !== null &&
    pauseState.until !== null &&
    Date.now() >= pauseState.until
  ) {
    pauseState = null;
    transientFailures = 0;
  }
  return pauseState;
}

function formatCooldown(minutes: number): string {
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return `${days} ${days === 1 ? "day" : "days"}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  return `${minutes} minutes`;
}

function pauseForQuota(message: string): void {
  const minutes = config.quotaCooldownMinutes;
  pauseState = {
    kind: "quota",
    message,
    until: Date.now() + minutes * 60_000,
  };
  clearSuggestion();
  if (!quotaNoticeShown) {
    quotaNoticeShown = true;
    editor.setStatus(
      `Copilot usage limit reached — automatic completions paused for ${formatCooldown(minutes)}; editing is unaffected`,
    );
  }
}

function handleFailure(error: unknown, showTransient: boolean): void {
  const kind = classifyFailure(error);
  const message = errorText(error);
  debug(`${kind}: ${message}`);

  switch (kind) {
    case "quota":
      pauseForQuota(message);
      break;
    case "authentication":
      pauseState = { kind: "authentication", message, until: null };
      clearSuggestion();
      editor.setStatus("Copilot is signed out — run ‘Copilot: Sign In’ to enable completions");
      break;
    case "server-missing":
      pauseState = { kind: "server-missing", message, until: null };
      clearSuggestion();
      editor.setStatus(
        "Copilot language server is unavailable — install @github/copilot-language-server or update the plugin setting",
      );
      break;
    case "cancelled":
      break;
    case "transient": {
      transientFailures += 1;
      const backoff = Math.min(300_000, 5000 * 2 ** (transientFailures - 1));
      pauseState = { kind: "transient", message, until: Date.now() + backoff };
      clearSuggestion();
      if (showTransient) {
        editor.setStatus(`Copilot request failed — retrying later (${message})`);
      }
      break;
    }
  }
}

function parseJson(value: unknown): unknown | null {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function stopAgent(): void {
  const handle = agentHandle;
  const oldSession = agentSessionDir;
  agentHandle = null;
  agentReady = false;
  agentStartPromise = null;
  agentSessionDir = "";
  agentFailure = "";
  lastAgentStatusVersion = 0;
  lastAgentEventVersion = 0;
  if (handle !== null) {
    void handle.kill().then(
      () => {
        if (oldSession.length > 0) editor.removePath(oldSession);
      },
      () => {
        if (oldSession.length > 0) editor.removePath(oldSession);
      },
    );
  } else if (oldSession.length > 0) {
    editor.removePath(oldSession);
  }
}

async function startAgent(): Promise<void> {
  if (editor.workspaceTrustLevel() !== "trusted") {
    throw new Error("workspace is not trusted");
  }

  agentStartCount += 1;
  const sessionDir = editor.pathJoin(
    editor.getTempDir(),
    `fresh-copilot-${SESSION_TOKEN}-${agentStartCount}`,
  );
  if (!editor.createDir(sessionDir)) {
    throw new Error(`could not create Copilot session directory: ${sessionDir}`);
  }

  const sourcePath = editor.pathJoin(
    editor.getPluginDir(),
    "bin",
    "copilot-agent.mjs",
  );
  const source = editor.readFile(editor.localPath(sourcePath));
  if (typeof source !== "string") {
    throw new Error(`Copilot transport is missing: ${sourcePath}`);
  }
  const agentPath = editor.pathJoin(sessionDir, "copilot-agent.mjs");
  const configPath = editor.pathJoin(sessionDir, "config.json");
  if (!editor.writeFile(agentPath, source)) {
    throw new Error(`could not stage Copilot transport: ${agentPath}`);
  }

  const cwd = editor.getCwd();
  const rootUri = editor.pathToFileUri(cwd);
  const bridgeConfig = {
    sessionDir,
    cwd,
    rootUri: rootUri.length > 0 ? rootUri : null,
    serverCommand: config.serverCommand,
    serverArgs: config.serverArgs,
    initializationOptions: {
      editorInfo: { name: "Fresh", version: "0.4.6+" },
      editorPluginInfo: { name: "fresh-copilot", version: PLUGIN_VERSION },
    },
  };
  if (!editor.writeFile(configPath, JSON.stringify(bridgeConfig))) {
    throw new Error(`could not write Copilot transport config: ${configPath}`);
  }

  const handle = editor.spawnBackgroundProcess(
    config.nodeCommand,
    [agentPath, configPath],
    cwd,
  );
  agentHandle = handle;
  agentSessionDir = sessionDir;
  agentFailure = "";
  void handle.result.then(
    (result) => {
      if (agentHandle === handle) {
        agentReady = false;
        agentHandle = null;
        agentSessionDir = "";
        agentFailure = `Copilot transport exited with code ${result.exit_code}`;
        editor.removePath(sessionDir);
      }
    },
    (error) => {
      if (agentHandle === handle) {
        agentReady = false;
        agentHandle = null;
        agentSessionDir = "";
        agentFailure = errorText(error);
        editor.removePath(sessionDir);
      }
    },
  );

  const readyPath = editor.pathJoin(sessionDir, "ready.json");
  const fatalPath = editor.pathJoin(sessionDir, "fatal.json");
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (parseJson(editor.readFile(readyPath)) !== null) {
      agentReady = true;
      debug(`transport ready in ${sessionDir}`);
      return;
    }
    const fatal = parseJson(editor.readFile(fatalPath));
    if (fatal !== null) {
      throw new Error(errorText(fatal));
    }
    if (agentFailure.length > 0) {
      throw new Error(agentFailure);
    }
    await editor.delay(100);
  }
  throw new Error("Copilot transport did not start within 30 seconds");
}

async function ensureAgent(): Promise<void> {
  if (agentReady && agentHandle !== null) return;
  if (agentStartPromise !== null) return agentStartPromise;

  const start = startAgent();
  agentStartPromise = start;
  try {
    await start;
  } catch (error) {
    stopAgent();
    throw error;
  } finally {
    if (agentStartPromise === start) agentStartPromise = null;
  }
}

function signalText(value: unknown): string {
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record.message === "string") return record.message;
  }
  return errorText(value);
}

function inspectAgentSignals(envelope: AgentEnvelope, method: string): void {
  const signals = [
    {
      value: envelope.status,
      version: envelope.statusVersion,
      last: lastAgentStatusVersion,
      update: (version: number) => {
        lastAgentStatusVersion = version;
      },
    },
    {
      value: envelope.event,
      version: envelope.eventVersion,
      last: lastAgentEventVersion,
      update: (version: number) => {
        lastAgentEventVersion = version;
      },
    },
  ];
  for (const signal of signals) {
    if (
      signal.version !== undefined &&
      signal.version > 0 &&
      signal.version <= signal.last
    ) {
      continue;
    }
    if (signal.version !== undefined && signal.version > 0) {
      signal.update(signal.version);
    }
    if (signal.value === undefined || signal.value === null) continue;
    const message = signalText(signal.value);
    const kind = classifyFailure(message);
    if (kind === "quota") {
      pauseForQuota(message);
    } else if (
      kind === "authentication" &&
      method !== "signIn" &&
      method !== "signInConfirm"
    ) {
      pauseState = { kind: "authentication", message, until: null };
      clearSuggestion();
      editor.setStatus("Copilot is signed out — run ‘Copilot: Sign In’ to enable completions");
    }
  }
}

async function agentRpc(
  method: string,
  params: Record<string, unknown> | null,
  document?: AgentDocument,
): Promise<unknown> {
  await ensureAgent();
  const sessionDir = agentSessionDir;
  rpcCounter += 1;
  const id = String(rpcCounter).padStart(10, "0");
  const requestPath = editor.pathJoin(sessionDir, `request-${id}.json`);
  const responsePath = editor.pathJoin(sessionDir, `response-${id}.json`);
  const fatalPath = editor.pathJoin(sessionDir, "fatal.json");
  const request = { id, method, params, document };

  if (!editor.writeFile(requestPath, JSON.stringify(request))) {
    throw new Error("could not write a Copilot transport request");
  }

  const timeoutMs = method === "signInConfirm" ? 190_000 : 35_000;
  const started = Date.now();
  let nextFatalCheck = started;
  while (Date.now() - started < timeoutMs) {
    if (sessionDir !== agentSessionDir) {
      throw new Error("Copilot transport restarted during a request");
    }
    const raw = editor.readFile(responsePath);
    if (typeof raw === "string") {
      editor.removePath(requestPath);
      editor.removePath(responsePath);
      const parsed = parseJson(raw);
      if (typeof parsed !== "object" || parsed === null) {
        throw new Error("Copilot transport returned invalid JSON");
      }
      const envelope = parsed as AgentEnvelope;
      inspectAgentSignals(envelope, method);
      if (!envelope.ok) {
        throw new Error(errorText(envelope.error));
      }
      return envelope.result;
    }
    const now = Date.now();
    if (now >= nextFatalCheck) {
      const fatal = parseJson(editor.readFile(fatalPath));
      if (fatal !== null) {
        throw new Error(errorText(fatal));
      }
      nextFatalCheck = now + 500;
    }
    if (agentFailure.length > 0) {
      throw new Error(agentFailure);
    }
    const elapsed = now - started;
    await editor.delay(elapsed < 1000 ? 20 : elapsed < 5000 ? 50 : 100);
  }

  editor.removePath(requestPath);
  throw new Error(`${method} timed out waiting for the Copilot transport`);
}

function finishCompletionScheduler(scheduler: Promise<void>): void {
  if (completionScheduler !== scheduler) return;
  completionScheduler = null;
  if (scheduledCompletion !== null) startCompletionScheduler();
}

async function drainScheduledCompletion(): Promise<void> {
  while (scheduledCompletion !== null) {
    const scheduled = scheduledCompletion;
    const delayMs = Math.max(0, scheduled.dueAt - Date.now());
    if (delayMs > 0) await editor.delay(delayMs);

    if (scheduledCompletion !== scheduled) continue;
    scheduledCompletion = null;
    if (
      scheduled.generation !== requestGeneration ||
      scheduled.bufferId !== editor.getActiveBufferId() ||
      currentPause() !== null
    ) {
      continue;
    }
    void requestCompletion(scheduled.bufferId, scheduled.generation, "auto");
  }
}

function startCompletionScheduler(): void {
  if (completionScheduler !== null || scheduledCompletion === null) return;

  const scheduler = drainScheduledCompletion();
  completionScheduler = scheduler;
  void scheduler.then(
    () => finishCompletionScheduler(scheduler),
    (error) => {
      scheduledCompletion = null;
      debug(`completion scheduler failed: ${errorText(error)}`);
      finishCompletionScheduler(scheduler);
    },
  );
}

function scheduleCompletion(
  bufferId: number,
  mode: SuggestionRequestMode = "auto",
): void {
  requestGeneration += 1;
  const generation = requestGeneration;
  clearSuggestion(bufferId);

  if (mode !== "auto") {
    scheduledCompletion = null;
    void requestCompletion(bufferId, generation, mode);
    return;
  }
  if (!config.enabled || !config.automatic || currentPause() !== null) {
    scheduledCompletion = null;
    return;
  }

  scheduledCompletion = {
    bufferId,
    generation,
    dueAt: Date.now() + config.debounceMs,
  };
  startCompletionScheduler();
}

async function requestCompletion(
  bufferId: number,
  generation: number,
  mode: SuggestionRequestMode,
): Promise<void> {
  const explicit = mode !== "auto";
  try {
    if (
      generation !== requestGeneration ||
      bufferId !== editor.getActiveBufferId()
    ) {
      return;
    }
    const info = eligibleBufferInfo(bufferId);
    if (info === null) return;
    if (editor.workspaceTrustLevel() !== "trusted") {
      if (explicit) {
        editor.setStatus(
          "Trust this workspace before starting the Copilot language server",
        );
      }
      return;
    }

    const text = await editor.getBufferText(bufferId);
    if (
      generation !== requestGeneration ||
      bufferId !== editor.getActiveBufferId()
    ) {
      return;
    }
    const cursor = editor.getCursorPosition();
    const textSnapshot = createTextSnapshot(text, cursor);
    const requestedRevision = revision(bufferId);
    const uri = editor.pathToFileUri(info.path);
    if (uri.length === 0) return;
    documentUris.set(bufferId, uri);

    let item: SuggestionItem | undefined;
    let kind: "completion" | "next-edit" = "completion";
    let edit = null;
    const tryNextEdit =
      mode === "next-edit" || (mode === "auto" && config.nextEditSuggestions);
    if (tryNextEdit) {
      try {
        const response = await agentRpc(
          "textDocument/copilotInlineEdit",
          {
            textDocument: { uri },
            position: textSnapshot.cursorPosition,
          },
          { uri, languageId: info.language, text },
        );
        const nextEdit = parseInlineEditResponse(response).find(
          (candidate) => candidate.textDocument.uri === uri,
        );
        if (nextEdit !== undefined) {
          const candidateEdit = buildInlineEdit(text, nextEdit);
          if (candidateEdit !== null) {
            item = nextEdit;
            kind = "next-edit";
            edit = candidateEdit;
          }
        }
      } catch (error) {
        const failure = classifyFailure(error);
        if (
          failure === "quota" ||
          failure === "authentication" ||
          failure === "server-missing"
        ) {
          throw error;
        }
        debug(`next-edit request unavailable: ${errorText(error)}`);
      }
    }

    if (
      generation !== requestGeneration ||
      bufferId !== editor.getActiveBufferId() ||
      requestedRevision !== revision(bufferId) ||
      cursor !== editor.getCursorPosition()
    ) {
      return;
    }

    if (edit === null && mode !== "next-edit") {
      const response = await agentRpc(
        "textDocument/inlineCompletion",
        {
          textDocument: { uri },
          position: textSnapshot.cursorPosition,
          formattingOptions: { insertSpaces: true, tabSize: 4 },
          context: { triggerKind: explicit ? 1 : 2 },
        },
        { uri, languageId: info.language, text },
      );
      const completion = parseInlineCompletionResponse(response)[0];
      if (completion !== undefined) {
        const candidateEdit = buildCompletionEdit(
          text,
          cursor,
          completion,
          textSnapshot,
        );
        if (candidateEdit !== null) {
          item = completion;
          edit = candidateEdit;
        }
      }
    }
    transientFailures = 0;
    if (pauseState?.kind === "transient") pauseState = null;

    if (
      generation !== requestGeneration ||
      bufferId !== editor.getActiveBufferId() ||
      requestedRevision !== revision(bufferId) ||
      cursor !== editor.getCursorPosition()
    ) {
      return;
    }

    if (item === undefined || edit === null) {
      clearSuggestion(bufferId);
      if (mode === "next-edit") editor.setStatus("Copilot has no next edit to suggest");
      return;
    }
    if (pauseState?.kind === "quota" || pauseState?.kind === "authentication") {
      pauseState = null;
      quotaNoticeShown = false;
    }

    activeSuggestion = {
      kind,
      bufferId,
      revision: requestedRevision,
      cursor,
      item,
      start: edit.start,
      end: edit.end,
      insertText: edit.insertText,
      replacedText: edit.replacedText,
    };
    const simplePrefixCompletion =
      kind === "completion" &&
      edit.end === cursor &&
      edit.insertText.startsWith(edit.replacedText);
    const showReplacement =
      edit.end > edit.start && !simplePrefixCompletion;
    const displayPosition = kind === "completion" ? cursor : edit.start;
    if (
      !renderSuggestion(
        bufferId,
        displayPosition,
        edit.previewText,
        edit.start,
        edit.end,
        kind,
        showReplacement,
      )
    ) {
      activeSuggestion = null;
      return;
    }
    editor.setContext(SUGGESTION_CONTEXT, true);
    activateSuggestionMode();
  } catch (error) {
    if (generation === requestGeneration) handleFailure(error, explicit);
  }
}

async function completeNow(): Promise<void> {
  if (!config.enabled) {
    editor.setStatus("GitHub Copilot completions are disabled in plugin settings");
    return;
  }
  const paused = currentPause();
  if (paused?.kind === "authentication") {
    editor.setStatus("Copilot is signed out — run ‘Copilot: Sign In’");
    return;
  }
  if (paused?.kind === "server-missing") {
    editor.setStatus(
      "Copilot language server is unavailable — run ‘Copilot: Retry’ after installing it",
    );
    return;
  }
  scheduleCompletion(editor.getActiveBufferId(), "completion");
}

async function nextEditNow(): Promise<void> {
  if (!config.enabled) {
    editor.setStatus("GitHub Copilot completions are disabled in plugin settings");
    return;
  }
  scheduleCompletion(editor.getActiveBufferId(), "next-edit");
}

async function acceptSuggestion(): Promise<void> {
  const suggestion = activeSuggestion;
  if (suggestion === null) {
    editor.setStatus("Copilot has no suggestion to accept");
    return;
  }
  if (
    suggestion.bufferId !== editor.getActiveBufferId() ||
    suggestion.revision !== revision(suggestion.bufferId) ||
    suggestion.cursor !== editor.getCursorPosition()
  ) {
    clearSuggestion(suggestion.bufferId);
    editor.setStatus("Copilot suggestion expired; request a new completion");
    return;
  }

  clearSuggestion(suggestion.bufferId);
  requestGeneration += 1;
  if (
    suggestion.end > suggestion.start &&
    !editor.deleteRange(suggestion.bufferId, suggestion.start, suggestion.end)
  ) {
    editor.setStatus("Copilot could not apply the suggestion");
    return;
  }
  if (!editor.insertText(suggestion.bufferId, suggestion.start, suggestion.insertText)) {
    const restored =
      suggestion.replacedText.length === 0 ||
      editor.insertText(
        suggestion.bufferId,
        suggestion.start,
        suggestion.replacedText,
      );
    editor.setStatus(
      restored
        ? "Copilot could not apply the suggestion; the original text was restored"
        : "Copilot could not apply the suggestion or restore the replaced text",
    );
    return;
  }
  editor.setBufferCursor(
    suggestion.bufferId,
    suggestion.start + utf8ByteLength(suggestion.insertText),
  );
  bumpRevision(suggestion.bufferId);

  if (suggestion.item.command !== undefined) {
    try {
      await agentRpc(
        "workspace/executeCommand",
        suggestion.item.command as unknown as Record<string, unknown>,
      );
    } catch (error) {
      debug(`accept telemetry failed: ${errorText(error)}`);
    }
  }
}

function dismissSuggestion(): void {
  requestGeneration += 1;
  clearSuggestion();
}

async function signIn(): Promise<void> {
  pauseState = null;
  quotaNoticeShown = false;
  editor.setStatus("Starting GitHub Copilot sign-in…");
  try {
    const response = await agentRpc("signIn", {});
    if (typeof response !== "object" || response === null) {
      editor.setStatus("Copilot sign-in did not return a device code");
      return;
    }
    const data = response as Record<string, unknown>;
    const code = typeof data.userCode === "string" ? data.userCode : "";
    const uri =
      typeof data.verificationUri === "string"
        ? data.verificationUri
        : "https://github.com/login/device";
    if (code.length === 0) {
      editor.setStatus(`Copilot: ${statusText(response)}`);
      return;
    }

    editor.copyToClipboard(code);
    const confirmed = await editor.prompt(
      `Open ${uri}, enter copied code ${code}, then press Enter`,
      "",
    );
    if (confirmed === null) {
      editor.setStatus("Copilot sign-in cancelled");
      return;
    }
    const result = await agentRpc("signInConfirm", {});
    editor.setStatus(`Copilot signed in — ${statusText(result)}`);
  } catch (error) {
    handleFailure(error, true);
  }
}

async function signOut(): Promise<void> {
  try {
    await agentRpc("signOut", {});
    pauseState = { kind: "authentication", message: "signed out", until: null };
    clearSuggestion();
    editor.setStatus("Signed out of GitHub Copilot");
  } catch (error) {
    handleFailure(error, true);
  }
}

async function showStatus(): Promise<void> {
  const paused = currentPause();
  if (paused !== null) {
    const retry =
      paused.until === null
        ? ""
        : `; retry in ${Math.max(1, Math.ceil((paused.until - Date.now()) / 60_000))} minutes`;
    editor.setStatus(`Copilot paused (${paused.kind})${retry} — ${paused.message}`);
    return;
  }
  try {
    const response = await agentRpc("checkStatus", {
      options: { localChecksOnly: true },
    });
    if (statusNeedsSignIn(response)) {
      pauseState = {
        kind: "authentication",
        message: statusText(response),
        until: null,
      };
    }
    editor.setStatus(`Copilot: ${statusText(response)}`);
  } catch (error) {
    handleFailure(error, true);
  }
}

function retryNow(): void {
  pauseState = null;
  quotaNoticeShown = false;
  transientFailures = 0;
  stopAgent();
  editor.setStatus("Retrying GitHub Copilot…");
  scheduleCompletion(editor.getActiveBufferId(), "completion");
}

function onEdit(event: BufferEvent): void {
  bumpRevision(event.buffer_id);
  scheduleCompletion(event.buffer_id);
}

function onCursorMoved(event: BufferEvent): void {
  if (activeSuggestion?.bufferId === event.buffer_id) {
    requestGeneration += 1;
    clearSuggestion(event.buffer_id);
  }
}

function onBufferActivated(event: BufferEvent): void {
  clearSuggestion();
  revisions.set(event.buffer_id, revision(event.buffer_id));
}

function onBufferClosed(event: BufferEvent): void {
  clearSuggestion(event.buffer_id);
  revisions.delete(event.buffer_id);
  const uri = documentUris.get(event.buffer_id);
  documentUris.delete(event.buffer_id);
  if (uri !== undefined && agentReady) {
    void agentRpc("fresh/didClose", { uri }).catch((error) => {
      debug(`didClose failed: ${errorText(error)}`);
    });
  }
}

function onConfigChanged(): void {
  config = readConfig();
  pauseState = null;
  quotaNoticeShown = false;
  transientFailures = 0;
  requestGeneration += 1;
  clearSuggestion();
  stopAgent();
}

function onTrustChanged(): void {
  if (editor.workspaceTrustLevel() !== "trusted") {
    requestGeneration += 1;
    clearSuggestion();
    stopAgent();
  }
}

registerHandler("fresh_copilot_complete", completeNow);
registerHandler("fresh_copilot_next_edit", nextEditNow);
registerHandler("fresh_copilot_accept", acceptSuggestion);
registerHandler("fresh_copilot_dismiss", dismissSuggestion);
registerHandler("fresh_copilot_sign_in", signIn);
registerHandler("fresh_copilot_sign_out", signOut);
registerHandler("fresh_copilot_status", showStatus);
registerHandler("fresh_copilot_retry", retryNow);
registerHandler("fresh_copilot_after_insert", onEdit);
registerHandler("fresh_copilot_after_delete", onEdit);
registerHandler("fresh_copilot_cursor_moved", onCursorMoved);
registerHandler("fresh_copilot_buffer_activated", onBufferActivated);
registerHandler("fresh_copilot_buffer_closed", onBufferClosed);
registerHandler("fresh_copilot_config_changed", onConfigChanged);
registerHandler("fresh_copilot_trust_changed", onTrustChanged);

editor.defineMode(
  SUGGESTION_MODE,
  [["Tab", "fresh_copilot_accept"]],
  false,
  false,
  true,
);
editor.defineMode(
  SUGGESTION_VI_INSERT_MODE,
  [
    ["Tab", "fresh_copilot_accept"],
    ["Escape", "fresh_copilot_dismiss"],
    ["Left", "move_left"],
    ["Down", "move_down"],
    ["Up", "move_up"],
    ["Right", "move_right"],
    ["C-p", "command_palette"],
    ["C-q", "quit"],
  ],
  false,
  false,
  false,
);

editor.registerCommand(
  "Copilot: Complete",
  "Request a GitHub Copilot completion now",
  "fresh_copilot_complete",
);
editor.registerCommand(
  "Copilot: Next Edit",
  "Request a predicted edit elsewhere in the current file",
  "fresh_copilot_next_edit",
);
editor.registerCommand(
  "Copilot: Accept Suggestion",
  "Apply the visible GitHub Copilot suggestion",
  "fresh_copilot_accept",
);
editor.registerCommand(
  "Copilot: Dismiss Suggestion",
  "Hide the visible GitHub Copilot suggestion",
  "fresh_copilot_dismiss",
);
editor.registerCommand(
  "Copilot: Sign In",
  "Sign in to GitHub Copilot with a device code",
  "fresh_copilot_sign_in",
);
editor.registerCommand(
  "Copilot: Sign Out",
  "Sign out of GitHub Copilot",
  "fresh_copilot_sign_out",
);
editor.registerCommand(
  "Copilot: Status",
  "Show sign-in, server, and usage-pause status",
  "fresh_copilot_status",
);
editor.registerCommand(
  "Copilot: Retry",
  "Clear a completion cooldown and retry now",
  "fresh_copilot_retry",
);

editor.on("after_insert", "fresh_copilot_after_insert");
editor.on("after_delete", "fresh_copilot_after_delete");
editor.on("cursor_moved", "fresh_copilot_cursor_moved");
editor.on("buffer_activated", "fresh_copilot_buffer_activated");
editor.on("buffer_closed", "fresh_copilot_buffer_closed");
editor.on("config_changed", "fresh_copilot_config_changed");
editor.on("trust_changed", "fresh_copilot_trust_changed");

editor.setContext(SUGGESTION_CONTEXT, false);
debug("plugin initialized; transport starts lazily on first use");
