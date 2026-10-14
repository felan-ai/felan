export interface RuntimeFileInfo {
  readonly kind: 'file' | 'directory' | 'symlink' | 'other';
  /** Opaque identity of this node, stable across renames but not replacement. */
  readonly identity: string;
  readonly size: number;
  readonly modifiedAt: number;
}

export interface RuntimeFileSnapshot {
  readonly info: RuntimeFileInfo;
  readonly content: Uint8Array;
  readonly truncated: boolean;
}

/** Atomic operations in the same authorized path namespace as AgentRuntime. */
export interface RuntimeFiles {
  inspect(path: string): Promise<RuntimeFileInfo>;
  canonicalPath(path: string): Promise<string>;
  move(source: string, target: string): Promise<void>;
  removeEmptyDirectory(path: string): Promise<void>;
  touch(path: string, modifiedAt: number): Promise<void>;
  ensurePrivateDirectory(path: string, options?: { recursive?: boolean }): Promise<void>;
  /** Reads a bounded prefix of a regular file without following a symlink; rejects replacement or mutation. */
  snapshot(path: string, maxBytes: number): Promise<RuntimeFileSnapshot>;
  /** Never follows symlinks. An expected snapshot rejects replacement or mutation before appending. */
  append(path: string, content: Uint8Array, expected?: RuntimeFileInfo): Promise<void>;
}
