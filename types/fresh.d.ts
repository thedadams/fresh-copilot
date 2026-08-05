declare function getEditor(): EditorAPI;
declare function registerHandler(name: string, fn: Function): void;

interface ProcessHandle<T> extends PromiseLike<T> {
  readonly result: Promise<T>;
  kill(): Promise<boolean>;
}

interface BackgroundProcessResult {
  process_id: number;
  exit_code: number;
}

interface LocalPath {
  kind: "local";
  value: string;
}

interface BufferInfo {
  id: number;
  path: string;
  modified: boolean;
  length: number;
  line_count: number | null;
  is_virtual: boolean;
  is_terminal: boolean;
  editing_disabled: boolean;
  language: string;
  is_preview: boolean;
  splits: number[];
}

interface EditorAPI {
  getActiveBufferId(): number;
  getBufferInfo(bufferId: number): BufferInfo | null;
  getBufferText(bufferId: number, start?: number, end?: number): Promise<string>;
  getCursorPosition(): number;
  setBufferCursor(bufferId: number, position: number): boolean;
  deleteRange(bufferId: number, start: number, end: number): boolean;
  insertText(bufferId: number, position: number, text: string): boolean;
  pathToFileUri(path: string): string;
  pathJoin(...parts: string[]): string;
  getCwd(): string;
  getTempDir(): string;
  getPluginDir(): string;
  localPath(path: string): LocalPath;
  readFile(path: string | LocalPath): string | null | undefined;
  writeFile(path: string | LocalPath, content: string): boolean;
  createDir(path: string | LocalPath): boolean;
  removePath(path: string | LocalPath): boolean;
  workspaceTrustLevel(): string;

  defineConfigBoolean(
    name: string,
    options: { default: boolean; description?: string },
  ): boolean;
  defineConfigInteger(
    name: string,
    options: {
      default: number;
      description?: string;
      minimum?: number;
      maximum?: number;
    },
  ): number;
  defineConfigString(
    name: string,
    options: { default: string; description?: string },
  ): string;
  defineConfigStringArray(
    name: string,
    options: { default: string[]; description?: string },
  ): string[];
  getPluginConfig<T = unknown>(): T;

  addVirtualTextStyled(
    bufferId: number,
    virtualTextId: string,
    position: number,
    text: string,
    options: Record<string, unknown>,
    before: boolean,
  ): boolean;
  removeVirtualTextsByPrefix(bufferId: number, prefix: string): boolean;
  addVirtualLine(
    bufferId: number,
    position: number,
    text: string,
    options: Record<string, unknown>,
    above: boolean,
    namespace: string,
    priority: number,
  ): boolean;
  clearVirtualTextNamespace(bufferId: number, namespace: string): boolean;
  addOverlay(
    bufferId: number,
    namespace: string,
    start: number,
    end: number,
    options: Record<string, unknown>,
  ): boolean;
  clearNamespace(bufferId: number, namespace: string): boolean;

  spawnBackgroundProcess(
    command: string,
    args: string[],
    cwd?: string,
  ): ProcessHandle<BackgroundProcessResult>;
  delay(durationMs: number): Promise<void>;

  on(eventName: string, handlerName: string): void;
  registerCommand(
    name: string,
    description: string,
    handlerName: string,
    context?: string | null,
  ): boolean;
  defineMode(
    name: string,
    bindingsArr: string[][],
    readOnly?: boolean,
    allowTextInput?: boolean,
    inheritNormalBindings?: boolean,
  ): boolean;
  setEditorMode(mode: string | null): boolean;
  getEditorMode(): string | null;
  setContext(name: string, active: boolean): boolean;
  prompt(label: string, initialValue: string): Promise<string | null>;
  copyToClipboard(text: string): void;
  setStatus(message: string): void;
  debug(message: string): void;
}
