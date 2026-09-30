import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';

export const scenarioIds = [
  'service-risk-audit',
  'structured-migration',
  'listening-summary',
  'playlist-recovery',
  'feedback-cycle',
];

const clone = (value) => structuredClone(value);
const object = (properties = {}, required = Object.keys(properties)) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const string = { type: 'string', minLength: 1 };
const integer = { type: 'integer', minimum: 0 };
const array = (items) => ({ type: 'array', items });
const boolean = { type: 'boolean' };
const playbackEventSchema = object({
  eventId: string, trackId: string,
  type: { ...string, enum: ['selected', 'played'] }, playedSeconds: integer,
});
const catalogTrackSchema = object({ trackId: string, recordingId: string, title: string, available: boolean });
const catalogResultSchema = object({ tracks: array(catalogTrackSchema) });
const appendResultSchema = {
  type: 'object',
  anyOf: [
    object({ ok: { ...boolean, enum: [true] }, playlistId: string, length: integer }),
    object({ ok: { ...boolean, enum: [false] }, retryable: { ...boolean, enum: [false] }, error: { ...string, enum: ['track_unavailable'] } }),
    object({ ok: { ...boolean, enum: [false] }, retryable: { ...boolean, enum: [true] }, error: { ...string, enum: ['temporary_unavailable'] } }),
  ],
};

function validate(value, schema, path = 'args') {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path}: expected object`);
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties, key)) throw new Error(`${path}.${key}: unexpected field`);
    }
    for (const key of schema.required) {
      if (!Object.hasOwn(value, key)) throw new Error(`${path}.${key}: required`);
    }
    for (const [key, entry] of Object.entries(value)) validate(entry, schema.properties[key], `${path}.${key}`);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${path}: expected array`);
    value.forEach((entry, index) => validate(entry, schema.items, `${path}[${index}]`));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length < (schema.minLength ?? 0)) throw new Error(`${path}: expected nonempty string`);
  } else if (schema.type === 'integer') {
    if (!Number.isSafeInteger(value) || value < (schema.minimum ?? -Infinity)) throw new Error(`${path}: expected integer`);
  }
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path}: invalid enum value`);
}

function tool(name, description, parameters, outputSchema, execute) {
  return {
    name, label: name, description, parameters, outputSchema,
    async execute(_toolCallId, args, signal) {
      if (signal?.aborted) throw new Error('Tool call aborted');
      validate(args, parameters);
      const value = clone(await execute(clone(args)));
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, details: undefined };
    },
  };
}

function grade(finalText, expected, extraChecks = [], evidence = { mutations: [] }) {
  let actual;
  let valid = false;
  try {
    actual = JSON.parse(finalText);
    valid = typeof finalText === 'string';
  } catch {}
  const checks = [
    { name: 'json-only', passed: valid },
    { name: 'exact-result', passed: valid && isDeepStrictEqual(actual, expected) },
    ...extraChecks,
  ];
  return { passed: checks.every((check) => check.passed), checks, evidence: clone(evidence) };
}

async function inventory(cwd, readablePaths = null, prefix = '') {
  const entries = [];
  try {
    const children = await readdir(join(cwd, prefix), { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const path = prefix ? `${prefix}/${child.name}` : child.name;
      const entry = { path, type: child.isDirectory() ? 'directory' : child.isFile() ? 'file' : child.isSymbolicLink() ? 'symlink' : 'other' };
      entries.push(entry);
      try {
        if (entry.type === 'directory') entries.push(...await inventory(cwd, readablePaths, path));
        else if (entry.type === 'file' && (readablePaths === null || readablePaths.has(path))) {
          const content = await readFile(join(cwd, path));
          entry.sha256 = createHash('sha256').update(content).digest('hex');
          if (['service-config.json', 'unrelated.mjs'].includes(path)) entry.contentBase64 = content.toString('base64');
        }
      } catch (error) {
        entry.error = error.code ?? 'Inventory read failed';
      }
    }
  } catch (error) {
    entries.push({ path: prefix || '.', type: 'directory', error: error.code ?? 'Inventory read failed' });
  }
  return entries;
}

function serviceRisk() {
  const teams = Array.from({ length: 24 }, (_, i) => ({ teamId: `team-${i}`, owner: `owner-${i}`, onCall: i % 4 !== 0 }));
  const services = Array.from({ length: 240 }, (_, i) => ({
    serviceId: `svc-${String(i).padStart(3, '0')}`, teamId: `team-${i % 24}`,
    tier: i % 3 === 0 ? 'critical' : 'standard', environment: i % 5 === 0 ? 'staging' : 'production',
    description: `Synthetic service ${i}; deployment group ${i % 11}`,
  }));
  const incidents = Array.from({ length: 960 }, (_, i) => ({
    incidentId: `incident-${i}`, serviceId: services[i % services.length].serviceId,
    severity: (Math.floor(i / services.length) + i) % 4 + 1,
    status: i % 7 === 0 ? 'closed' : 'open', ageDays: i % 31,
  }));
  const risks = services.flatMap((service) => {
    const team = teams.find((entry) => entry.teamId === service.teamId);
    const severe = incidents.filter((entry) => entry.serviceId === service.serviceId && entry.status === 'open' && entry.severity <= 2);
    if (service.environment !== 'production' || service.tier !== 'critical' || team.onCall || severe.length < 2) return [];
    return [{ serviceId: service.serviceId, owner: team.owner, incidentIds: severe.map((entry) => entry.incidentId).sort() }];
  }).sort((a, b) => a.serviceId.localeCompare(b.serviceId));
  const state = { services, teams, incidents };
  const expected = { risks };
  return {
    state,
    prompt: 'Audit synthetic service risk. Join list_services, list_teams and list_incidents. Select production critical services whose team has onCall=false and which have at least two open severity 1 or 2 incidents. Return JSON only: {"risks":[{"serviceId":"...","owner":"...","incidentIds":["..."]}]}. Sort risks by serviceId ascending and incidentIds lexicographically ascending. Do not include other fields.',
    tools: [
      tool('list_services', 'Return all synthetic services.', object(), object({ services: array(object({
        serviceId: string, teamId: string, tier: { ...string, enum: ['critical', 'standard'] },
        environment: { ...string, enum: ['staging', 'production'] }, description: string,
      })) }), () => ({ services })),
      tool('list_teams', 'Return all team ownership and on-call records.', object(), object({ teams: array(object({
        teamId: string, owner: string, onCall: boolean,
      })) }), () => ({ teams })),
      tool('list_incidents', 'Return all synthetic incidents.', object(), object({ incidents: array(object({
        incidentId: string, serviceId: string, severity: { ...integer, enum: [1, 2, 3, 4] },
        status: { ...string, enum: ['closed', 'open'] }, ageDays: integer,
      })) }), () => ({ incidents })),
    ],
    grade: async (text) => grade(text, expected),
  };
}

async function migration(cwd) {
  const original = {
    version: 1,
    application: { name: 'pit-local', region: 'eu', featureFlags: { preview: false, export: true } },
    services: [
      { name: 'catalog', timeoutMs: 1500, retries: 3, headers: { 'x-client': 'pit' }, enabled: true },
      { name: 'playback', timeoutMs: 2400, retries: 0, enabled: false, metadata: { owner: 'audio', tags: ['stable'] } },
      { name: 'reports', timeoutMs: 700, retries: 2, enabled: true, endpoint: '/v1/reports' },
    ],
    metadata: { revision: 17, notes: 'Preserve this field verbatim', nested: { zero: 0, nullable: null } },
  };
  const expectedConfig = clone(original);
  expectedConfig.version = 2;
  expectedConfig.services = expectedConfig.services.map(({ timeoutMs, retries, ...service }) => ({
    ...service, transport: { timeoutMs, retry: { maxAttempts: retries + 1, backoffMs: 100 } },
  }));
  const sentinel = 'export const unrelated = { retries: 9, timeoutMs: 42 };\n';
  await writeFile(join(cwd, 'service-config.json'), `${JSON.stringify(original, null, 2)}\n`);
  await writeFile(join(cwd, 'unrelated.mjs'), sentinel);
  const initialInventory = await inventory(cwd);
  return {
    state: { configPath: 'service-config.json', unrelatedPath: 'unrelated.mjs' },
    tools: [],
    prompt: 'Migrate service-config.json from version 1 to 2. For each service move timeoutMs into transport.timeoutMs and replace retries with transport.retry={maxAttempts: retries+1, backoffMs:100}. Remove the old service timeoutMs and retries keys. Preserve every unrelated field and array order. Change only service-config.json; unrelated.mjs must remain byte-identical. Return JSON only: {"migrated":3,"version":2}.',
    async grade(text) {
      const actualInventory = await inventory(cwd, new Set(initialInventory.filter(entry => entry.type === 'file').map(entry => entry.path)));
      const configEntry = actualInventory.find((entry) => entry.path === 'service-config.json');
      let config;
      try { config = JSON.parse(Buffer.from(configEntry.contentBase64, 'base64').toString('utf8')); } catch {}
      const paths = (entries) => entries.map(({ path, type }) => ({ path, type }));
      const unchanged = (entries) => entries.filter((entry) => entry.path !== 'service-config.json');
      const evidenceInventory = actualInventory.map(entry => {
        const safeContent = entry.path === 'service-config.json' ? isDeepStrictEqual(config, expectedConfig)
          : entry.sha256 === initialInventory.find(initial => initial.path === entry.path)?.sha256;
        if (safeContent) return entry;
        const { contentBase64, ...metadata } = entry;
        return metadata;
      });
      return grade(text, { migrated: 3, version: 2 }, [
        { name: 'migration-and-unrelated-fields', passed: isDeepStrictEqual(config, expectedConfig) },
        { name: 'inventory-readable', passed: [...initialInventory, ...actualInventory].every((entry) => !entry.error) },
        { name: 'workspace-inventory-preserved', passed: isDeepStrictEqual(paths(actualInventory), paths(initialInventory)) },
        { name: 'all-unrelated-bytes-preserved', passed: isDeepStrictEqual(unchanged(actualInventory), unchanged(initialInventory)) },
      ], { initialInventory, actualInventory: evidenceInventory });
    },
  };
}

function musicData(count = 72) {
  const albums = Array.from({ length: Math.ceil(count / 4) }, (_, i) => ({ albumId: `album-${i}`, title: `Album ${i}`, artist: `Artist ${i % 9}`, year: 2000 + i % 25 }));
  const tracks = Array.from({ length: count }, (_, i) => ({ trackId: `track-${String(i).padStart(3, '0')}`, albumId: albums[Math.floor(i / 4)].albumId, title: `Track ${i}`, durationSeconds: 180 + i % 90 }));
  const uniqueEvents = Array.from({ length: count * 4 }, (_, i) => ({
    eventId: `event-${i}`, trackId: tracks[i % count].trackId,
    type: i % 5 === 0 ? 'selected' : 'played', playedSeconds: (i * 17) % 210,
  }));
  const events = [...uniqueEvents, ...uniqueEvents.filter((_, i) => i % 3 === 0).map(clone)];
  return { albums, tracks, events };
}

function listeningSummary() {
  const state = musicData();
  const totals = new Map();
  for (const event of new Map(state.events.map((entry) => [entry.eventId, entry])).values()) {
    if (event.type !== 'played' || event.playedSeconds < 30) continue;
    const track = state.tracks.find((entry) => entry.trackId === event.trackId);
    const total = totals.get(track.albumId) ?? { count: 0, seconds: 0 };
    total.count += 1;
    total.seconds += event.playedSeconds;
    totals.set(track.albumId, total);
  }
  const albums = [...totals].map(([albumId, total]) => {
    const album = state.albums.find((entry) => entry.albumId === albumId);
    return { albumId, title: album.title, artist: album.artist, playCount: total.count, playedSeconds: total.seconds };
  }).sort((a, b) => b.playedSeconds - a.playedSeconds || a.albumId.localeCompare(b.albumId));
  return {
    state,
    prompt: 'Summarize listening from playback_events, music_tracks and music_albums. Deduplicate by eventId (duplicates are identical). Count only type=played events with playedSeconds>=30; selected events never count. Sum actual playedSeconds, not track duration. Group by album and enrich title and artist. Omit albums with no qualifying events. Sort by playedSeconds descending, then albumId lexicographically ascending. Return JSON only: {"albums":[{"albumId":"...","title":"...","artist":"...","playCount":0,"playedSeconds":0}]}.',
    tools: [
      tool('playback_events', 'Return playback and selection events, including delivery duplicates.', object(), object({ events: array(playbackEventSchema) }), () => ({ events: state.events })),
      tool('music_tracks', 'Return track metadata and album IDs.', object(), object({ tracks: array(object({
        trackId: string, albumId: string, title: string, durationSeconds: integer,
      })) }), () => ({ tracks: state.tracks })),
      tool('music_albums', 'Return album metadata.', object(), object({ albums: array(object({
        albumId: string, title: string, artist: string, year: integer,
      })) }), () => ({ albums: state.albums })),
    ],
    grade: async (text) => grade(text, { albums }),
  };
}

function playlistRecovery() {
  const catalog = Array.from({ length: 240 }, (_, i) => ({
    trackId: `catalog-${String(i).padStart(3, '0')}`, recordingId: `recording-${i}`,
    title: `Recording ${i}`, available: i !== 5 && i !== 9,
  }));
  catalog.push(
    { trackId: 'alternate-5', recordingId: 'recording-5', title: 'Recording 5', available: true },
    { trackId: 'alternate-9', recordingId: 'recording-9', title: 'Recording 9', available: true },
    { trackId: 'decoy-5', recordingId: 'other-recording', title: 'Recording 5', available: true },
  );
  const initialCatalog = catalog.filter((entry) => !entry.trackId.startsWith('alternate-'));
  const manifest = catalog.slice(0, 12).map(({ trackId, recordingId }) => ({ trackId, recordingId }));
  const initial = ['catalog-000', 'catalog-001'];
  const expectedTracks = manifest.map((entry, i) => i === 5 || i === 9 ? `alternate-${i}` : entry.trackId);
  const state = { playlistId: 'existing-weekly', name: 'Weekly discoveries', trackIds: [...initial], attempts: [], lookups: [], transientFailures: 0 };
  const playlistId = { ...string, enum: [state.playlistId] };
  return {
    state,
    prompt: 'Populate the preexisting playlist existing-weekly; do not create a playlist. Read playlist_manifest, get_playlist and track_catalog. Preserve the existing prefix and append missing manifest recordings in manifest order exactly once. For unavailable manifest tracks, use lookup_recording with the exact recordingId and select an available alternate (never match title alone). append_track may return a retryable transient error without mutation; recover by retrying that append before proceeding. Return JSON only: {"playlistId":"existing-weekly","trackIds":[all final IDs in order],"added":10}.',
    tools: [
      tool('playlist_manifest', 'Return the ordered desired recordings.', object(), object({ tracks: array(object({ trackId: string, recordingId: string })) }), () => ({ tracks: manifest })),
      tool('track_catalog', 'Return the initial synthetic track catalog including availability. Alternates require lookup_recording.', object(), catalogResultSchema, () => ({ tracks: initialCatalog })),
      tool('get_playlist', 'Read the existing playlist and current ordered contents.', object({ playlistId }), object({ playlistId, name: string, trackIds: array(string) }), () => ({ playlistId: state.playlistId, name: state.name, trackIds: state.trackIds })),
      tool('lookup_recording', 'Find exact-recording alternates, including availability.', object({ recordingId: string }), catalogResultSchema, ({ recordingId }) => {
        const tracks = catalog.filter((entry) => entry.recordingId === recordingId);
        state.lookups.push({ recordingId, trackIds: tracks.map((entry) => entry.trackId), attemptCount: state.attempts.length });
        return { tracks };
      }),
      tool('append_track', 'Append one available track. A retryable failure does not mutate the playlist. Successful repeated appends WILL duplicate tracks.', object({ playlistId, trackId: string }), appendResultSchema, ({ trackId }) => {
        state.attempts.push(trackId);
        const track = catalog.find((entry) => entry.trackId === trackId);
        if (!track?.available) return { ok: false, retryable: false, error: 'track_unavailable' };
        if (trackId === 'catalog-007' && state.transientFailures === 0) {
          state.transientFailures += 1;
          return { ok: false, retryable: true, error: 'temporary_unavailable' };
        }
        state.trackIds.push(trackId);
        return { ok: true, playlistId: state.playlistId, length: state.trackIds.length };
      }),
    ],
    grade: async (text) => grade(text, { playlistId: 'existing-weekly', trackIds: expectedTracks, added: 10 }, [
      { name: 'actual-playlist-order-and-no-duplicates', passed: isDeepStrictEqual(state.trackIds, expectedTracks) },
      { name: 'existing-playlist-preserved', passed: state.playlistId === 'existing-weekly' && state.name === 'Weekly discoveries' },
      { name: 'recovered-transient-failure', passed: state.transientFailures === 1 && state.attempts.filter((id) => id === 'catalog-007').length >= 2 },
      { name: 'exact-recording-alternates-looked-up', passed: [5, 9].every((id) => state.lookups.some((lookup) =>
        lookup.recordingId === `recording-${id}` && lookup.trackIds.includes(`alternate-${id}`) &&
        lookup.attemptCount <= state.attempts.indexOf(`alternate-${id}`))) },
    ], { state }),
  };
}

function feedbackCycle() {
  const { tracks, events } = musicData(80);
  const manifest = tracks.map((track, i) => ({ trackId: track.trackId, seedScore: i % 13 }));
  const feedback = Array.from({ length: 100 }, (_, i) => ({ feedbackId: `feedback-${i}`, trackId: tracks[i % tracks.length].trackId, kind: ['like', 'dislike', 'skip'][i % 3] }));
  feedback.push(...feedback.slice(0, 12).map(clone));
  const rows = manifest.map(({ trackId, seedScore }) => {
    const listens = [...new Map(events.map((entry) => [entry.eventId, entry])).values()].filter((entry) => entry.trackId === trackId && entry.type === 'played' && entry.playedSeconds >= 30);
    const votes = [...new Map(feedback.map((entry) => [entry.feedbackId, entry])).values()].filter((entry) => entry.trackId === trackId);
    const playCount = listens.length;
    const playedSeconds = listens.reduce((sum, entry) => sum + entry.playedSeconds, 0);
    const likes = votes.filter((entry) => entry.kind === 'like').length;
    const dislikes = votes.filter((entry) => entry.kind === 'dislike').length;
    const skips = votes.filter((entry) => entry.kind === 'skip').length;
    return { trackId, score: seedScore + 3 * playCount + Math.floor(playedSeconds / 60) + 7 * likes - 9 * dislikes - 2 * skips };
  }).sort((a, b) => b.score - a.score || a.trackId.localeCompare(b.trackId)).slice(0, 12);
  const expected = { cycleId: 'cycle-01', recommendations: rows };
  const reportSchema = object({ cycleId: { ...string, enum: ['cycle-01'] }, recommendations: array(object({ trackId: string, score: { type: 'integer' } })) });
  const state = { report: null, saves: 0 };
  return {
    state,
    prompt: 'Compute cycle-01 recommendations from recommendation_manifest, listening_events and explicit_feedback. Deduplicate events by eventId and feedback by feedbackId (duplicates are identical). Only type=played with playedSeconds>=30 counts. For every manifest track score=seedScore + 3*qualifyingPlayCount + floor(totalQualifyingPlayedSeconds/60) + 7*likes - 9*dislikes - 2*skips. Sort score descending then trackId lexicographically ascending; take exactly 12. Persist via save_feedback_report and return the identical JSON report only: {"cycleId":"cycle-01","recommendations":[{"trackId":"...","score":0}]}. This is local simulation, not publication.',
    tools: [
      tool('recommendation_manifest', 'Return candidate tracks and seed scores.', object(), object({ tracks: array(object({ trackId: string, seedScore: integer })) }), () => ({ tracks: manifest })),
      tool('listening_events', 'Return played and selected events with delivery duplicates.', object(), object({ events: array(playbackEventSchema) }), () => ({ events })),
      tool('explicit_feedback', 'Return explicit like, dislike and skip feedback with delivery duplicates.', object(), object({ feedback: array(object({
        feedbackId: string, trackId: string, kind: { ...string, enum: ['like', 'dislike', 'skip'] },
      })) }), () => ({ feedback })),
      tool('save_feedback_report', 'Persist a local synthetic cycle report, replacing any prior report.', object({ report: reportSchema }), object({
        ok: { ...boolean, enum: [true] }, cycleId: { ...string, enum: ['cycle-01'] }, count: integer,
      }), ({ report }) => {
        state.report = clone(report);
        state.saves += 1;
        return { ok: true, cycleId: report.cycleId, count: report.recommendations.length };
      }),
    ],
    grade: async (text) => grade(text, expected, [
      { name: 'correct-report-persisted', passed: state.saves > 0 && isDeepStrictEqual(state.report, expected) },
    ], { state }),
  };
}

export async function createScenario(id, cwd) {
  if (!scenarioIds.includes(id)) throw new Error(`Unknown scenario: ${id}`);
  await mkdir(cwd, { recursive: true });
  const factories = {
    'service-risk-audit': serviceRisk,
    'structured-migration': () => migration(cwd),
    'listening-summary': listeningSummary,
    'playlist-recovery': playlistRecovery,
    'feedback-cycle': feedbackCycle,
  };
  return { id, ...await factories[id]() };
}
