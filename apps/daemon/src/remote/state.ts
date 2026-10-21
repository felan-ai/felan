import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import type { RemoteDatabase } from '../daemon/persistence.js';
import { Type, type Static } from 'typebox';
import { HostProjectSchema, parseSchema, text, type HostProject } from '@felan-ai/session-protocol';

export const REMOTE_UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const uuid = Type.String({ pattern: REMOTE_UUID_PATTERN });
const object = { additionalProperties: false } as const;
export const RemoteSettingsSchema = Type.Object({
  installId: uuid, share: Type.Union([Type.Literal('all'), Type.Literal('on-request')]),
  appliedShare: Type.Optional(Type.Union([Type.Literal('all'), Type.Literal('on-request')])),
  projects: Type.Array(Type.Object(HostProjectSchema.properties, object), { maxItems: 256 }),
  apiUrl: Type.Optional(text(2048, 1)),
}, object);
export const RemoteSessionRecordSchema = Type.Object({
  shared: Type.Boolean(), explicit: Type.Optional(Type.Boolean()), origin: Type.Union([Type.Literal('local'), Type.Literal('web')]),
  backfilled: Type.Boolean(), unsharedPending: Type.Boolean(), sharedPending: Type.Optional(Type.Boolean()),
  uploadAttempted: Type.Optional(Type.Boolean()),
  skippedChanges: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  terminal: Type.Optional(Type.Union([Type.Literal('deleted'), Type.Literal('forbidden')])), hostId: Type.Optional(uuid), indexedHostId: Type.Optional(uuid),
}, object);
const settingsFile = Type.Object({ version: Type.Literal(1), settings: RemoteSettingsSchema }, object);
const sessionFile = Type.Object({ version: Type.Literal(1), record: RemoteSessionRecordSchema }, object);
const settingsPatch = Type.Partial(Type.Omit(RemoteSettingsSchema, ['installId']));
export type RemoteSettings = Static<typeof RemoteSettingsSchema>;
export type RemoteSessionRecord = Static<typeof RemoteSessionRecordSchema>;
export function remoteSessionId(value: string): string {
  if (!new RegExp(REMOTE_UUID_PATTERN).test(value)) throw new Error('Invalid remote session UUID.');
  return value.toLowerCase();
}

export class RemoteIntegrityError extends Error {}
export class RemoteStorageError extends Error {}

function storage<T>(action: () => T): T {
  try { return action(); }
  catch (error) {
    if (error instanceof RemoteIntegrityError || error instanceof RemoteStorageError) throw error;
    throw new RemoteStorageError('Remote storage access failed.', { cause: error });
  }
}

export class RemoteStore {
  private settingsValue: RemoteSettings;
  private readonly sessionValues = new Map<string, RemoteSessionRecord | undefined>();
  private sessionIds: Set<string> | undefined;
  constructor(private readonly database: RemoteDatabase) {
    const loaded = this.load('settings', 'settings', raw => this.validateSettings(parseSchema(settingsFile, raw).settings));
    this.settingsValue = loaded ?? { installId: randomUUID(), share: 'on-request', projects: [] };
    if (!loaded) storage(() => database.transaction(() => database.putRecord('settings', 'settings', JSON.stringify({ version: 1, settings: this.settingsValue }))));
  }
  settings(): RemoteSettings { storage(() => this.database.assertCurrent()); return structuredClone(this.settingsValue); }
  configure(patch: Partial<Omit<RemoteSettings, 'installId'>>): RemoteSettings {
    const parsed = parseSchema(settingsPatch, patch);
    const next = this.validateSettings({ ...this.settings(), ...parsed });
    if (parsed.projects) next.projects = next.projects.map(project => ({ ...project, path: canonicalProjectPath(project.path) }));
    this.validateSettings(next);
    storage(() => this.database.transaction(() => this.database.putRecord('settings', 'settings', JSON.stringify({ version: 1, settings: next }))));
    this.settingsValue = next;
    return this.settings();
  }
  addProject(path: string, name?: string): HostProject {
    const canonical = canonicalProjectPath(path);
    const current = this.settings(); const existing = current.projects.find(project => project.path === canonical);
    if (existing) return existing;
    const project = { id: randomUUID(), name: name ?? (basename(canonical) || canonical), path: canonical };
    this.configure({ projects: [...current.projects, project] }); return structuredClone(project);
  }
  removeProject(id: string): void { this.configure({ projects: this.settings().projects.filter(project => project.id !== id) }); }
  session(session: string): RemoteSessionRecord | undefined {
    storage(() => this.database.assertCurrent());
    const id = remoteSessionId(session);
    if (!this.sessionValues.has(id)) {
      const value = this.load('session', id, raw => parseSchema(sessionFile, raw).record);
      this.sessionValues.set(id, value);
      if (!value) this.sessionIds?.delete(id);
    }
    return structuredClone(this.sessionValues.get(id));
  }
  setSession(session: string, record: RemoteSessionRecord): RemoteSessionRecord {
    const id = remoteSessionId(session); const value = parseSchema(RemoteSessionRecordSchema, record);
    storage(() => this.database.transaction(() => this.database.putRecord('session', id, JSON.stringify({ version: 1, record: value }))));
    this.sessionValues.set(id, structuredClone(value)); this.sessionIds?.add(id);
    return structuredClone(value);
  }
  removeSession(session: string): void {
    const id = remoteSessionId(session);
    storage(() => this.database.transaction(() => this.database.deleteRecord('session', id)));
    this.sessionValues.delete(id); this.sessionIds?.delete(id);
  }
  sessions(): string[] {
    storage(() => this.database.assertCurrent());
    this.sessionIds ??= new Set(storage(() => this.database.records('session')).map(row => row.id).filter(id => new RegExp(REMOTE_UUID_PATTERN).test(id)));
    return [...this.sessionIds].sort();
  }
  private validateSettings(value: unknown): RemoteSettings {
    const settings = parseSchema(RemoteSettingsSchema, value);
    const paths = new Set<string>(); const ids = new Set<string>();
    for (const project of settings.projects) {
      if (!isAbsolute(project.path) || resolve(project.path) !== project.path || project.path.includes('\0') || paths.has(project.path) || ids.has(project.id)) throw new Error('Invalid or duplicate remote project.');
      paths.add(project.path); ids.add(project.id);
    }
    if (settings.apiUrl !== undefined) {
      let url: URL;
      try { url = new URL(settings.apiUrl); } catch { throw new Error('Invalid remote API URL.'); }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid remote API URL.');
    }
    return settings;
  }
  private load<T>(kind: string, id: string, parse: (raw: unknown) => T): T | undefined {
    const bytes = storage(() => this.database.record(kind, id));
    if (bytes === undefined) return undefined;
    try {
      if (Buffer.byteLength(bytes) > 2 * 1024 * 1024) throw new RemoteIntegrityError('Remote record exceeds its size limit.');
      return parse(JSON.parse(bytes));
    } catch {
      storage(() => this.database.transaction(() => {
        this.database.putRecord('quarantine', `${kind}:${id}:${randomUUID()}`, bytes);
        this.database.deleteRecord(kind, id);
      }));
      return undefined;
    }
  }
}

function canonicalProjectPath(path: string): string {
  if (!isAbsolute(path) || path.includes('\0')) throw new Error('Remote project path must be absolute.');
  const canonical = storage(() => realpathSync(path));
  if (!storage(() => statSync(canonical)).isDirectory()) throw new Error('Remote project path must be a directory.');
  return canonical;
}
