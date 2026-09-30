import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createScenario, scenarioIds } from './scenarios.mjs';

async function fixture(t, id) {
  const cwd = await mkdtemp(join(tmpdir(), 'codemode-scenario-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, scenario: await createScenario(id, cwd) };
}

function assertMatchesSchema(value, schema) {
  assert.ok(schema && typeof schema === 'object', 'outputSchema must be present');
  if (schema.anyOf) {
    assert.ok(schema.anyOf.some((branch) => {
      try { assertMatchesSchema(value, branch); return true; } catch { return false; }
    }), 'result must match an output union branch');
    return;
  }
  if (schema.enum) assert.ok(schema.enum.includes(value), 'enum value');
  switch (schema.type) {
    case 'object':
      assert.ok(value && typeof value === 'object' && !Array.isArray(value));
      assert.equal(schema.additionalProperties, false);
      assert.ok(Array.isArray(schema.required));
      for (const key of schema.required) assert.ok(Object.hasOwn(value, key), `required: ${key}`);
      for (const [key, entry] of Object.entries(value)) {
        assert.ok(Object.hasOwn(schema.properties, key), `declared: ${key}`);
        assertMatchesSchema(entry, schema.properties[key]);
      }
      break;
    case 'array':
      assert.ok(Array.isArray(value));
      for (const entry of value) assertMatchesSchema(entry, schema.items);
      break;
    case 'integer':
      assert.ok(Number.isSafeInteger(value));
      if (schema.minimum !== undefined) assert.ok(value >= schema.minimum);
      break;
    case 'string':
      assert.equal(typeof value, 'string');
      if (schema.minLength !== undefined) assert.ok(value.length >= schema.minLength);
      break;
    case 'boolean':
      assert.equal(typeof value, 'boolean');
      break;
    default:
      assert.fail(`Unsupported or unspecified schema type: ${schema.type}`);
  }
}

async function call(scenario, name, args = {}) {
  const tool = scenario.tools.find((entry) => entry.name === name);
  assert.ok(tool, name);
  const result = await tool.execute('oracle', args, new AbortController().signal);
  assert.deepEqual(result.content, [{ type: 'text', text: JSON.stringify(result.structuredContent) }]);
  assert.equal(result.details, undefined);
  assertMatchesSchema(result.structuredContent, tool.outputSchema);
  assert.throws(() => assertMatchesSchema(result.content[0].text, tool.outputSchema));
  assert.throws(() => assertMatchesSchema({ ...result.structuredContent, unexpected: true }, tool.outputSchema));
  return result.structuredContent;
}

async function passes(scenario, answer) {
  const result = await scenario.grade(JSON.stringify(answer));
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.ok(result.checks.every((check) => check.passed));
  assert.ok(result.evidence);
  assert.deepEqual(JSON.parse(JSON.stringify(result.evidence)), result.evidence);
  for (const text of ['not JSON', `\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``, JSON.stringify({ ...answer, selfClaim: 'passed' })]) {
    assert.equal((await scenario.grade(text)).passed, false);
  }
}

test('service risk oracle joins the large result sets; omissions and false positives fail', async (t) => {
  const { scenario } = await fixture(t, 'service-risk-audit');
  const { services } = await call(scenario, 'list_services');
  const { teams } = await call(scenario, 'list_teams');
  const { incidents } = await call(scenario, 'list_incidents');
  assert.equal(services.length, 240);
  assert.equal(incidents.length, 960);
  const risks = [];
  for (const service of services) {
    const team = teams.find((entry) => entry.teamId === service.teamId);
    const incidentIds = incidents.filter((entry) => entry.serviceId === service.serviceId && entry.status === 'open' && [1, 2].includes(entry.severity)).map((entry) => entry.incidentId).sort();
    if (service.environment === 'production' && service.tier === 'critical' && !team.onCall && incidentIds.length >= 2) risks.push({ serviceId: service.serviceId, owner: team.owner, incidentIds });
  }
  risks.sort((a, b) => a.serviceId.localeCompare(b.serviceId));
  assert.ok(risks.length > 1);
  await passes(scenario, { risks });
  assert.equal((await scenario.grade(JSON.stringify({ risks: risks.slice(1) }))).passed, false);
  assert.equal((await scenario.grade(JSON.stringify({ risks: [...risks, { serviceId: 'svc-000', owner: 'owner-0', incidentIds: [] }] }))).passed, false);
  services[0].teamId = 'corrupted';
  assert.notEqual((await call(scenario, 'list_services')).services[0].teamId, 'corrupted');
});

async function migrateConfig(cwd) {
  const path = join(cwd, 'service-config.json');
  const config = JSON.parse(await readFile(path, 'utf8'));
  config.version = 2;
  for (const service of config.services) {
    service.transport = { timeoutMs: service.timeoutMs, retry: { maxAttempts: service.retries + 1, backoffMs: 100 } };
    delete service.timeoutMs;
    delete service.retries;
  }
  const valid = JSON.stringify(config);
  await writeFile(path, valid);
  return { config, valid, path };
}

test('migration requires actual edits, preserves unrelated fields and file bytes', async (t) => {
  const { scenario, cwd } = await fixture(t, 'structured-migration');
  assert.deepEqual(scenario.tools, []);
  const answer = { migrated: 3, version: 2 };
  assert.equal((await scenario.grade(JSON.stringify(answer))).passed, false);
  const { config, valid, path } = await migrateConfig(cwd);
  await passes(scenario, answer);
  config.metadata.nested.zero = 1;
  await writeFile(path, JSON.stringify(config));
  assert.equal((await scenario.grade(JSON.stringify(answer))).passed, false);
  await writeFile(path, valid);
  await writeFile(join(cwd, 'unrelated.mjs'), 'changed');
  assert.equal((await scenario.grade(JSON.stringify(answer))).passed, false);
});

test('migration rejects extra files, directories and symlinks and records actual inventory', async (t) => {
  const { scenario, cwd } = await fixture(t, 'structured-migration');
  const { valid } = await migrateConfig(cwd);
  const answer = JSON.stringify({ migrated: 3, version: 2 });
  const success = await scenario.grade(answer);
  assert.equal(success.passed, true);
  assert.deepEqual(success.evidence.actualInventory.map((entry) => entry.path), ['service-config.json', 'unrelated.mjs']);
  assert.equal(Buffer.from(success.evidence.actualInventory[0].contentBase64, 'base64').toString('utf8'), valid);
  assert.equal(JSON.parse(Buffer.from(success.evidence.initialInventory[0].contentBase64, 'base64').toString('utf8')).version, 1);
  await writeFile(join(cwd, 'extra.bin'), Buffer.from([0, 255, 128]));
  const extra = await scenario.grade(answer);
  assert.equal(extra.passed, false);
  assert.equal(extra.checks.find((check) => check.name === 'workspace-inventory-preserved').passed, false);
  assert.deepEqual(extra.evidence.actualInventory.find((entry) => entry.path === 'extra.bin'), { path: 'extra.bin', type: 'file' });
  assert.equal(success.evidence.actualInventory.length, 2);
  await rm(join(cwd, 'extra.bin'));
  await mkdir(join(cwd, 'extra-directory'));
  assert.equal((await scenario.grade(answer)).passed, false);
  await rm(join(cwd, 'extra-directory'), { recursive: true });
  await rm(join(cwd, 'unrelated.mjs'));
  await symlink('service-config.json', join(cwd, 'unrelated.mjs'));
  const linked = await scenario.grade(answer);
  assert.equal(linked.passed, false);
  assert.deepEqual(linked.evidence.actualInventory.find((entry) => entry.path === 'unrelated.mjs'), {
    path: 'unrelated.mjs', type: 'symlink',
  });
});

test('migration evidence excludes unexpected auth/config contents and invalid replacements', async (t) => {
  const { scenario, cwd } = await fixture(t, 'structured-migration');
  await migrateConfig(cwd);
  const marker = 'DO_NOT_CAPTURE_FIXTURE_MARKER';
  await writeFile(join(cwd, 'auth.json'), marker);
  await writeFile(join(cwd, 'models.json'), marker);
  await writeFile(join(cwd, 'unrelated.mjs'), marker);
  const result = await scenario.grade(JSON.stringify({ migrated: 3, version: 2 }));
  assert.equal(result.passed, false);
  assert.ok(!JSON.stringify(result.evidence).includes(Buffer.from(marker).toString('base64')));
  for (const path of ['auth.json', 'models.json']) assert.deepEqual(result.evidence.actualInventory.find(entry => entry.path === path), { path, type: 'file' });
});

test('migration preserves all preexisting nested files byte-for-byte and detects deletion', async (t) => {
  const { cwd } = await fixture(t, 'structured-migration');
  await mkdir(join(cwd, 'nested'));
  const bytes = Buffer.from([0, 255, 128]);
  await writeFile(join(cwd, 'nested', 'existing.bin'), bytes);
  const scenario = await createScenario('structured-migration', cwd);
  await migrateConfig(cwd);
  const answer = JSON.stringify({ migrated: 3, version: 2 });
  assert.equal((await scenario.grade(answer)).passed, true);
  await writeFile(join(cwd, 'nested', 'existing.bin'), Buffer.from([0, 255, 129]));
  const changed = await scenario.grade(answer);
  assert.equal(changed.passed, false);
  assert.equal(changed.checks.find((check) => check.name === 'all-unrelated-bytes-preserved').passed, false);
  await writeFile(join(cwd, 'nested', 'existing.bin'), bytes);
  await rm(join(cwd, 'nested'), { recursive: true });
  assert.equal((await scenario.grade(answer)).passed, false);
});

test('listening oracle deduplicates actual plays and enriches albums', async (t) => {
  const { scenario } = await fixture(t, 'listening-summary');
  const { events } = await call(scenario, 'playback_events');
  const { tracks } = await call(scenario, 'music_tracks');
  const { albums: metadata } = await call(scenario, 'music_albums');
  const seen = new Set();
  const albumMap = new Map();
  let selected = 0;
  for (const event of events) {
    if (seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    if (event.type === 'selected') selected += 1;
    if (event.type !== 'played' || event.playedSeconds < 30) continue;
    const { albumId } = tracks.find((track) => track.trackId === event.trackId);
    const { title, artist } = metadata.find((album) => album.albumId === albumId);
    const album = albumMap.get(albumId) ?? { albumId, title, artist, playCount: 0, playedSeconds: 0 };
    album.playCount += 1;
    album.playedSeconds += event.playedSeconds;
    albumMap.set(albumId, album);
  }
  assert.ok(selected > 0 && events.length > seen.size);
  const albums = [...albumMap.values()].sort((a, b) => b.playedSeconds - a.playedSeconds || a.albumId.localeCompare(b.albumId));
  await passes(scenario, { albums });
  const wrong = structuredClone(albums);
  wrong[0].playedSeconds += 30;
  assert.equal((await scenario.grade(JSON.stringify({ albums: wrong }))).passed, false);
  assert.equal((await scenario.grade(JSON.stringify({ albums: albums.toReversed() }))).passed, false);
});

async function populatePlaylist(scenario) {
  const { tracks: manifest } = await call(scenario, 'playlist_manifest');
  const { tracks: catalog } = await call(scenario, 'track_catalog');
  const playlistId = 'existing-weekly';
  const { trackIds } = await call(scenario, 'get_playlist', { playlistId });
  const originalLength = trackIds.length;
  const recordings = new Set(trackIds.map((id) => catalog.find((entry) => entry.trackId === id).recordingId));
  for (const desired of manifest) {
    if (recordings.has(desired.recordingId)) continue;
    let track = catalog.find((entry) => entry.trackId === desired.trackId);
    if (!track.available) {
      const alternatives = await call(scenario, 'lookup_recording', { recordingId: desired.recordingId });
      track = alternatives.tracks.find((entry) => entry.available);
    }
    let result = await call(scenario, 'append_track', { playlistId, trackId: track.trackId });
    if (!result.ok && result.retryable) result = await call(scenario, 'append_track', { playlistId, trackId: track.trackId });
    assert.equal(result.ok, true);
    trackIds.push(track.trackId);
    recordings.add(desired.recordingId);
  }
  return { playlistId, trackIds, added: trackIds.length - originalLength };
}

test('playlist oracle recovers without duplicates; claims cannot replace mutation', async (t) => {
  const { scenario } = await fixture(t, 'playlist-recovery');
  const answer = await populatePlaylist(scenario);
  assert.equal(scenario.state.transientFailures, 1);
  assert.equal(scenario.state.attempts.length, 11);
  await passes(scenario, answer);
  assert.deepEqual(scenario.state.lookups.map((lookup) => lookup.recordingId), ['recording-5', 'recording-9']);
  const evidence = (await scenario.grade(JSON.stringify(answer))).evidence;
  assert.deepEqual(evidence.state, scenario.state);
  const { scenario: fresh } = await fixture(t, 'playlist-recovery');
  assert.equal((await fresh.grade(JSON.stringify(answer))).passed, false);
  await call(scenario, 'append_track', { playlistId: 'existing-weekly', trackId: 'catalog-002' });
  assert.deepEqual(evidence.state.trackIds, answer.trackIds);
  assert.equal((await scenario.grade(JSON.stringify(answer))).passed, false);
});

test('playlist hides alternates and rejects bypassed, partial and late exact-recording lookups', async (t) => {
  const { scenario: oracle } = await fixture(t, 'playlist-recovery');
  const answer = await populatePlaylist(oracle);
  for (const recordings of [[], ['recording-5'], ['recording-9'], ['Recording 5', 'Recording 9']]) {
    const { scenario } = await fixture(t, 'playlist-recovery');
    const { tracks } = await call(scenario, 'track_catalog');
    assert.equal(tracks.some((track) => track.trackId.startsWith('alternate-')), false);
    for (const recordingId of recordings) await call(scenario, 'lookup_recording', { recordingId });
    for (const trackId of answer.trackIds.slice(2)) {
      const args = { playlistId: answer.playlistId, trackId };
      const result = await call(scenario, 'append_track', args);
      if (result.retryable) await call(scenario, 'append_track', args);
    }
    const result = await scenario.grade(JSON.stringify(answer));
    assert.equal(result.passed, false);
    assert.deepEqual(result.checks.filter((check) => !check.passed).map((check) => check.name), ['exact-recording-alternates-looked-up']);
    for (const recordingId of ['recording-5', 'recording-9']) await call(scenario, 'lookup_recording', { recordingId });
    assert.equal((await scenario.grade(JSON.stringify(answer))).passed, false);
  }
});

test('playlist unavailable tracks never mutate; order and transient recovery matter', async (t) => {
  const { scenario } = await fixture(t, 'playlist-recovery');
  const result = await call(scenario, 'append_track', { playlistId: 'existing-weekly', trackId: 'catalog-005' });
  assert.deepEqual(result, { ok: false, retryable: false, error: 'track_unavailable' });
  assert.equal(scenario.state.trackIds.length, 2);
  const answer = await populatePlaylist(scenario);
  [scenario.state.trackIds[2], scenario.state.trackIds[3]] = [scenario.state.trackIds[3], scenario.state.trackIds[2]];
  assert.equal((await scenario.grade(JSON.stringify(answer))).passed, false);
});

async function feedbackReport(scenario) {
  const { tracks } = await call(scenario, 'recommendation_manifest');
  const { events } = await call(scenario, 'listening_events');
  const { feedback } = await call(scenario, 'explicit_feedback');
  const scores = new Map(tracks.map(({ trackId, seedScore }) => [trackId, { score: seedScore, seconds: 0 }]));
  const seenEvents = new Set();
  for (const event of events) {
    if (seenEvents.has(event.eventId)) continue;
    seenEvents.add(event.eventId);
    if (event.type !== 'played' || event.playedSeconds < 30) continue;
    const entry = scores.get(event.trackId);
    entry.score += 3;
    entry.seconds += event.playedSeconds;
  }
  const seenFeedback = new Set();
  for (const vote of feedback) {
    if (seenFeedback.has(vote.feedbackId)) continue;
    seenFeedback.add(vote.feedbackId);
    scores.get(vote.trackId).score += { like: 7, dislike: -9, skip: -2 }[vote.kind];
  }
  const recommendations = [...scores].map(([trackId, entry]) => ({ trackId, score: entry.score + Math.floor(entry.seconds / 60) }));
  recommendations.sort((a, b) => b.score - a.score || a.trackId.localeCompare(b.trackId));
  return { cycleId: 'cycle-01', recommendations: recommendations.slice(0, 12) };
}

test('feedback oracle joins, scores and persists; output alone and wrong persistence fail', async (t) => {
  const { scenario } = await fixture(t, 'feedback-cycle');
  const report = await feedbackReport(scenario);
  assert.equal((await scenario.grade(JSON.stringify(report))).passed, false);
  await call(scenario, 'save_feedback_report', { report });
  await passes(scenario, report);
  const evidence = (await scenario.grade(JSON.stringify(report))).evidence;
  assert.deepEqual(evidence.state, { report, saves: 1 });
  const wrong = structuredClone(report);
  wrong.recommendations[0].score += 1;
  assert.equal((await scenario.grade(JSON.stringify(wrong))).passed, false);
  await call(scenario, 'save_feedback_report', { report: wrong });
  assert.deepEqual(evidence.state, { report, saves: 1 });
  assert.equal((await scenario.grade(JSON.stringify(report))).passed, false);
});

for (const id of scenarioIds) {
  test(`${id}: fresh state and validated tool boundaries`, async (t) => {
    const { scenario, cwd } = await fixture(t, id);
    const fresh = await createScenario(id, cwd);
    assert.notEqual(scenario.state, fresh.state);
    assert.deepEqual(scenario.state, fresh.state);
    scenario.state.injected = true;
    assert.equal(fresh.state.injected, undefined);
    for (const tool of scenario.tools) {
      assert.equal(tool.outputSchema?.type, 'object', `${tool.name} must declare structured output`);
      assert.equal(tool.parameters.additionalProperties, false);
      await assert.rejects(tool.execute('bad', { unexpected: true }), /unexpected field/);
      await assert.rejects(tool.execute('bad', null), /expected object/);
      for (const key of tool.parameters.required) {
        await assert.rejects(tool.execute('bad', {}), /required/);
        await assert.rejects(tool.execute('bad', { [key]: 123 }), /expected|invalid|required/);
      }
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(tool.execute('aborted', {}, controller.signal), /aborted/);
    }
  });
}

test('mutating tool state is isolated between scenarios and rejects malformed nested reports', async (t) => {
  const { scenario } = await fixture(t, 'playlist-recovery');
  const { scenario: fresh } = await fixture(t, 'playlist-recovery');
  await call(scenario, 'append_track', { playlistId: 'existing-weekly', trackId: 'catalog-002' });
  assert.deepEqual(fresh.state.trackIds, ['catalog-000', 'catalog-001']);
  const append = scenario.tools.find((tool) => tool.name === 'append_track');
  await assert.rejects(append.execute('bad', { playlistId: 'different', trackId: 'catalog-003' }), /enum/);
  const { scenario: feedback } = await fixture(t, 'feedback-cycle');
  const save = feedback.tools.find((tool) => tool.name === 'save_feedback_report');
  for (const recommendations of [[{ trackId: 'track-000', score: 1.5 }], [{ trackId: 'track-000', score: 1, extra: true }], 'invalid']) {
    await assert.rejects(save.execute('bad', { report: { cycleId: 'cycle-01', recommendations } }));
  }
  assert.equal(feedback.state.saves, 0);
  assert.equal(feedback.state.report, null);
});

test('unknown scenarios are rejected', async () => {
  await assert.rejects(createScenario('unknown', '/unused'), /Unknown scenario/);
});

test('output schemas cover empty lookup and discriminate success, transient and permanent failure', async (t) => {
  const { scenario } = await fixture(t, 'playlist-recovery');
  assert.deepEqual(await call(scenario, 'lookup_recording', { recordingId: 'missing' }), { tracks: [] });
  const schema = scenario.tools.find((tool) => tool.name === 'append_track').outputSchema;
  for (const invalid of [
    { ok: true },
    { ok: false, retryable: true, error: 'track_unavailable' },
    { ok: false, retryable: false, error: 'temporary_unavailable' },
    { ok: true, playlistId: 'existing-weekly', length: '3' },
    { ok: true, playlistId: 'existing-weekly', length: -1 },
  ]) assert.throws(() => assertMatchesSchema(invalid, schema));
  const { scenario: audit } = await fixture(t, 'service-risk-audit');
  const teamsSchema = audit.tools.find((tool) => tool.name === 'list_teams').outputSchema;
  assert.throws(() => assertMatchesSchema({ teams: [{ teamId: 'a', owner: 'b', onCall: 'false' }] }, teamsSchema));
  assert.throws(() => assertMatchesSchema({ teams: [{ teamId: 'a', onCall: false }] }, teamsSchema));
});
