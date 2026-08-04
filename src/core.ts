export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface CompletionCommand {
  command: string;
  arguments?: unknown[];
  title?: string;
}

export interface InlineCompletionItem {
  insertText: string;
  range?: LspRange;
  command?: CompletionCommand;
  [key: string]: unknown;
}

export interface CompletionEdit {
  start: number;
  end: number;
  insertText: string;
  replacedText: string;
  previewText: string;
}

export interface TextSnapshot {
  text: string;
  requestedOffset: number;
  byteLength: number;
  cursor: number;
  cursorJsIndex: number;
  cursorPosition: LspPosition;
  cursorLineStartJsIndex: number;
  cursorLineStartByteOffset: number;
}

interface TextLocation {
  byteOffset: number;
  jsIndex: number;
}

export type FailureKind =
  | "quota"
  | "authentication"
  | "server-missing"
  | "cancelled"
  | "transient";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLspPosition(value: unknown): value is LspPosition {
  return (
    isRecord(value) &&
    typeof value.line === "number" &&
    Number.isInteger(value.line) &&
    value.line >= 0 &&
    typeof value.character === "number" &&
    Number.isInteger(value.character) &&
    value.character >= 0
  );
}

function isLspRange(value: unknown): value is LspRange {
  return (
    isRecord(value) &&
    isLspPosition(value.start) &&
    isLspPosition(value.end)
  );
}

function isCompletionCommand(value: unknown): value is CompletionCommand {
  if (!isRecord(value) || typeof value.command !== "string") {
    return false;
  }
  return value.arguments === undefined || Array.isArray(value.arguments);
}

// Packed as (UTF-16 code units << 3) | UTF-8 bytes to avoid allocating an
// object for every code point while indexing a buffer.
function encodedCodePointSize(text: string, index: number): number {
  const first = text.charCodeAt(index);
  if (first <= 0x7f) return (1 << 3) | 1;
  if (first <= 0x7ff) return (1 << 3) | 2;
  if (first >= 0xd800 && first <= 0xdbff && index + 1 < text.length) {
    const second = text.charCodeAt(index + 1);
    if (second >= 0xdc00 && second <= 0xdfff) return (2 << 3) | 4;
  }
  return (1 << 3) | 3;
}

function normalizedOffset(value: number): number {
  return Math.max(0, Math.floor(value));
}

/** Return the UTF-8 byte length Fresh uses for buffer offsets. */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  let index = 0;
  while (index < text.length) {
    const size = encodedCodePointSize(text, index);
    bytes += size & 7;
    index += size >> 3;
  }
  return bytes;
}

/** Convert a Fresh UTF-8 byte offset to an LSP UTF-16 position. */
export function positionAtByteOffset(
  text: string,
  requestedOffset: number,
): LspPosition {
  const offset = normalizedOffset(requestedOffset);
  let bytes = 0;
  let index = 0;
  let line = 0;
  let character = 0;

  while (index < text.length) {
    const codeUnit = text.charCodeAt(index);
    const size = encodedCodePointSize(text, index);
    const codeUnits = size >> 3;
    const nextBytes = bytes + (size & 7);
    if (nextBytes > offset) break;

    bytes = nextBytes;
    index += codeUnits;
    if (codeUnit === 10) {
      line += 1;
      character = 0;
    } else {
      character += codeUnits;
    }
  }

  return { line, character };
}

function byteLocationAtPosition(
  text: string,
  position: LspPosition,
): TextLocation {
  const requestedLine = normalizedOffset(position.line);
  const requestedCharacter = normalizedOffset(position.character);
  let byteOffset = 0;
  let index = 0;
  let line = 0;

  while (index < text.length && line < requestedLine) {
    const codeUnit = text.charCodeAt(index);
    const size = encodedCodePointSize(text, index);
    byteOffset += size & 7;
    index += size >> 3;
    if (codeUnit === 10) line += 1;
  }
  if (line < requestedLine) return { byteOffset, jsIndex: index };

  let character = 0;
  while (index < text.length && character < requestedCharacter) {
    const codeUnit = text.charCodeAt(index);
    if (
      codeUnit === 10 ||
      (codeUnit === 13 && text.charCodeAt(index + 1) === 10)
    ) {
      break;
    }
    const size = encodedCodePointSize(text, index);
    const codeUnits = size >> 3;
    if (character + codeUnits > requestedCharacter) break;
    byteOffset += size & 7;
    index += codeUnits;
    character += codeUnits;
  }

  return { byteOffset, jsIndex: index };
}

/** Convert an LSP UTF-16 position to a Fresh UTF-8 byte offset. */
export function byteOffsetAtPosition(
  text: string,
  position: LspPosition,
): number {
  return byteLocationAtPosition(text, position).byteOffset;
}

/** Scan once and retain the cursor metrics reused across one completion RPC. */
export function createTextSnapshot(
  text: string,
  requestedOffset: number,
): TextSnapshot {
  const target = normalizedOffset(requestedOffset);
  let byteOffset = 0;
  let index = 0;
  let line = 0;
  let character = 0;
  let lineStartJsIndex = 0;
  let lineStartByteOffset = 0;
  let captured = false;
  let cursor = 0;
  let cursorJsIndex = 0;
  let cursorLine = 0;
  let cursorCharacter = 0;
  let cursorLineStartJsIndex = 0;
  let cursorLineStartByteOffset = 0;

  while (index < text.length) {
    const codeUnit = text.charCodeAt(index);
    const size = encodedCodePointSize(text, index);
    const codeUnits = size >> 3;
    const byteWidth = size & 7;
    if (!captured && (byteOffset >= target || byteOffset + byteWidth > target)) {
      captured = true;
      cursor = byteOffset;
      cursorJsIndex = index;
      cursorLine = line;
      cursorCharacter = character;
      cursorLineStartJsIndex = lineStartJsIndex;
      cursorLineStartByteOffset = lineStartByteOffset;
    }

    byteOffset += byteWidth;
    index += codeUnits;
    if (codeUnit === 10) {
      line += 1;
      character = 0;
      lineStartJsIndex = index;
      lineStartByteOffset = byteOffset;
    } else {
      character += codeUnits;
    }
  }

  if (!captured) {
    cursor = byteOffset;
    cursorJsIndex = index;
    cursorLine = line;
    cursorCharacter = character;
    cursorLineStartJsIndex = lineStartJsIndex;
    cursorLineStartByteOffset = lineStartByteOffset;
  }

  return {
    text,
    requestedOffset: target,
    byteLength: byteOffset,
    cursor,
    cursorJsIndex,
    cursorPosition: { line: cursorLine, character: cursorCharacter },
    cursorLineStartJsIndex,
    cursorLineStartByteOffset,
  };
}

function byteLocationOnSnapshotLine(
  snapshot: TextSnapshot,
  character: number,
): TextLocation {
  const requestedCharacter = normalizedOffset(character);
  let byteOffset = snapshot.cursorLineStartByteOffset;
  let index = snapshot.cursorLineStartJsIndex;
  let currentCharacter = 0;

  while (index < snapshot.text.length && currentCharacter < requestedCharacter) {
    const codeUnit = snapshot.text.charCodeAt(index);
    if (
      codeUnit === 10 ||
      (codeUnit === 13 && snapshot.text.charCodeAt(index + 1) === 10)
    ) {
      break;
    }
    const size = encodedCodePointSize(snapshot.text, index);
    const codeUnits = size >> 3;
    if (currentCharacter + codeUnits > requestedCharacter) break;
    byteOffset += size & 7;
    index += codeUnits;
    currentCharacter += codeUnits;
  }

  return { byteOffset, jsIndex: index };
}

function comparePositions(left: LspPosition, right: LspPosition): number {
  return left.line === right.line
    ? left.character - right.character
    : left.line - right.line;
}

/** Validate an inline item and turn its UTF-16 range into a Fresh edit. */
export function buildCompletionEdit(
  text: string,
  cursor: number,
  item: InlineCompletionItem,
  snapshot?: TextSnapshot,
): CompletionEdit | null {
  if (item.insertText.length === 0) return null;

  const requestedCursor = normalizedOffset(cursor);
  const textSnapshot =
    snapshot?.text === text && snapshot.requestedOffset === requestedCursor
      ? snapshot
      : createTextSnapshot(text, requestedCursor);
  const bufferLength = textSnapshot.byteLength;
  const safeCursor = textSnapshot.cursor;
  const cursorPosition = textSnapshot.cursorPosition;
  const range = item.range ?? {
    start: cursorPosition,
    end: cursorPosition,
  };
  if (
    comparePositions(range.start, range.end) > 0 ||
    comparePositions(range.start, cursorPosition) > 0 ||
    comparePositions(range.end, cursorPosition) < 0
  ) {
    return null;
  }

  const cursorLocation = {
    byteOffset: safeCursor,
    jsIndex: textSnapshot.cursorJsIndex,
  };
  const startLocation =
    item.range === undefined
      ? cursorLocation
      : range.start.line === cursorPosition.line
        ? byteLocationOnSnapshotLine(textSnapshot, range.start.character)
        : byteLocationAtPosition(text, range.start);
  const endLocation =
    item.range === undefined
      ? cursorLocation
      : range.end.line === cursorPosition.line
        ? byteLocationOnSnapshotLine(textSnapshot, range.end.character)
        : byteLocationAtPosition(text, range.end);
  const start = startLocation.byteOffset;
  const end = endLocation.byteOffset;

  if (
    start > end ||
    start > safeCursor ||
    end < safeCursor ||
    end > bufferLength
  ) {
    return null;
  }

  const replaced = text.slice(startLocation.jsIndex, endLocation.jsIndex);
  if (replaced === item.insertText) {
    return null;
  }

  const typedPrefix = text.slice(startLocation.jsIndex, textSnapshot.cursorJsIndex);
  const previewText =
    typedPrefix.length > 0 && item.insertText.startsWith(typedPrefix)
      ? item.insertText.slice(typedPrefix.length)
      : item.insertText;

  if (previewText.length === 0) {
    return null;
  }

  return {
    start,
    end,
    insertText: item.insertText,
    replacedText: replaced,
    previewText,
  };
}

/** Compact multiline completion text into a single ghost-text label. */
export function formatGhostPreview(
  previewText: string,
  maximumLength = 160,
): string {
  const sanitized = previewText.replace(/\u0000/g, "").replace(/\r\n?/g, "\n");
  const lines = sanitized.split("\n");
  const extraLines = lines.length - 1;
  const suffix =
    extraLines > 0
      ? `  ↵ +${extraLines} ${extraLines === 1 ? "line" : "lines"}`
      : "";
  let firstLine = lines[0] ?? "";

  if (firstLine.length === 0 && extraLines > 0) {
    return `↵ +${extraLines} ${extraLines === 1 ? "line" : "lines"}`;
  }

  const available = Math.max(1, maximumLength - suffix.length);
  if (firstLine.length > available) {
    firstLine = `${firstLine.slice(0, Math.max(1, available - 1))}…`;
  }
  return `${firstLine}${suffix}`;
}

/** Parse only the subset of the Copilot inline response the plugin consumes. */
export function parseInlineCompletionResponse(
  response: unknown,
): InlineCompletionItem[] {
  if (!isRecord(response) || !Array.isArray(response.items)) {
    return [];
  }

  const items: InlineCompletionItem[] = [];
  for (const value of response.items) {
    if (!isRecord(value) || typeof value.insertText !== "string") {
      continue;
    }
    if (value.range !== undefined && !isLspRange(value.range)) {
      continue;
    }
    if (value.command !== undefined && !isCompletionCommand(value.command)) {
      continue;
    }
    items.push(value as InlineCompletionItem);
  }
  return items;
}

export function errorText(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  try {
    const serialized = JSON.stringify(error);
    return serialized === undefined ? String(error) : serialized;
  } catch {
    return String(error);
  }
}

/** Classify failures so expected Free-tier and sign-in states stay quiet. */
export function classifyFailure(error: unknown): FailureKind {
  const message = errorText(error).toLowerCase();

  if (
    /(?:^|\D)402(?:\D|$)|quota|usage\s+(?:limit|allowance)|monthly\s+(?:limit|allowance)|(?:limit|allowance)\s+(?:reached|exceeded|exhausted)|no\s+(?:code\s+)?completions?\s+(?:left|remaining)|rate\s+limit/.test(
      message,
    )
  ) {
    return "quota";
  }
  if (
    /(?:^|\D)401(?:\D|$)|unauthori[sz]ed|not.?signed.?in|not\s+logged\s+in|sign[ -]?in\s+required|authentication\s+(?:required|failed)|invalid\s+(?:token|credentials)/.test(
      message,
    )
  ) {
    return "authentication";
  }
  if (
    /no such file|command not found|enoent|failed to spawn|not configured|server.+(?:unavailable|not running)|executable.+not found/.test(
      message,
    )
  ) {
    return "server-missing";
  }
  if (/cancelled|canceled|request superseded/.test(message)) {
    return "cancelled";
  }
  return "transient";
}

export function statusText(response: unknown): string {
  if (!isRecord(response)) {
    return errorText(response);
  }

  const status = typeof response.status === "string" ? response.status : "unknown";
  const user = typeof response.user === "string" ? response.user : "";
  const message = typeof response.message === "string" ? response.message : "";
  return [status, user, message].filter((part) => part.length > 0).join(" — ");
}

export function statusNeedsSignIn(response: unknown): boolean {
  if (!isRecord(response) || typeof response.status !== "string") {
    return false;
  }
  return /not.?signed.?in|signed.?out|not.?authenticated/i.test(response.status);
}
