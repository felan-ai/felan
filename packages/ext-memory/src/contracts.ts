export const MEMORY_ARTIFACT_VERSION = 1 as const;
export const MEMORY_INPUT_MANIFEST_VERSION = 1 as const;

export type MemoryRole = 'root' | 'reader';

export interface MemoryFile {
  /** POSIX path relative to the logical .memory root. */
  readonly path: string;
  readonly content: string;
}

export interface MemoryArtifact {
  readonly version: typeof MEMORY_ARTIFACT_VERSION;
  readonly files: readonly MemoryFile[];
}

export interface MemorySnapshot extends MemoryArtifact {
  /** SHA-256 fingerprint of the complete canonical artifact. */
  readonly fingerprint: string;
  /** Agent-visible path of this session's non-authoritative projection. */
  readonly memoryPath: string;
}

export interface SessionCheckpoint {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly leafId: string | null;
  readonly transcriptDigest: string;
}

export type MemoryProcessingState =
  | 'disabled'
  | 'idle'
  | 'scheduled'
  | 'processing'
  | 'blocked'
  | 'error';

export interface MemoryStatus {
  readonly enabled: boolean;
  readonly state: MemoryProcessingState;
  readonly pendingCheckpoints: number;
  readonly memoryFingerprint?: string;
  readonly lastProcessedAt?: string;
  /** Sanitized diagnostic which must not contain transcript content or credentials. */
  readonly message?: string;
}

export interface MemoryHost {
  readCurrent(): Promise<MemorySnapshot | null>;
  recordCheckpoint(checkpoint: SessionCheckpoint): Promise<void>;
  status(): Promise<MemoryStatus>;
}

export interface MemoryInputSession {
  readonly checkpoint: SessionCheckpoint;
  readonly metadataPath: string;
  readonly transcriptPath: string;
  readonly materializedDigest: string;
  readonly byteLength: number;
  readonly redactionCount: number;
}

export interface MemoryInputManifest {
  readonly version: typeof MEMORY_INPUT_MANIFEST_VERSION;
  readonly createdAt: string;
  readonly baseMemoryFingerprint: string;
  readonly sessions: readonly MemoryInputSession[];
}

export interface MemoryArtifactLimits {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxAreas: number;
  readonly maxPagesPerArea: number;
}

export const DEFAULT_MEMORY_ARTIFACT_LIMITS: MemoryArtifactLimits = Object.freeze({
  maxFiles: 256,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 4 * 1024 * 1024,
  maxAreas: 32,
  maxPagesPerArea: 32,
});

export interface MemoryValidationOptions {
  readonly limits?: Partial<MemoryArtifactLimits>;
  readonly sourceSessionIds?: readonly string[];
  /** Use availability-safe normalization instead of strict publication validation. */
  readonly mode?: 'strict' | 'read';
  /** Require page provenance. Defaults to true except in read mode. */
  readonly requireSources?: boolean;
  /** Validate index/page navigation. Defaults to true except in read mode. */
  readonly validateNavigation?: boolean;
  readonly memoryPath?: string;
}

export interface MemoryValidationError {
  readonly code:
    | 'duplicate_path'
    | 'invalid_path'
    | 'unsupported_version'
    | 'invalid_file_type'
    | 'invalid_markdown'
    | 'missing_required_file'
    | 'file_too_large'
    | 'too_many_files'
    | 'too_many_areas'
    | 'too_many_pages'
    | 'total_too_large'
    | 'summary_has_links'
    | 'invalid_link'
    | 'broken_link'
    | 'unreachable_page'
    | 'missing_sources'
    | 'unknown_source';
  readonly path?: string;
  readonly message: string;
}

export interface MemoryValidationResult {
  readonly ok: boolean;
  readonly artifact?: MemoryArtifact;
  readonly errors: readonly MemoryValidationError[];
}

export interface MemoryHydrationOptions extends MemoryValidationOptions {
  readonly replace?: boolean;
}

export interface MemoryInputManifestOptions {
  readonly baseMemoryFingerprint: string;
  readonly sessions: readonly MemoryInputSession[];
  readonly createdAt?: string;
}
