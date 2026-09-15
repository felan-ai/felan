import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = '/agent-config/felan/storage/sessions';
const expectedTitle = 'TASK_STORAGE_SENTINEL_7C91';

async function findState(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const matches = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) matches.push(...await findState(path));
    else if (entry.isFile() && entry.name === 'state.json') matches.push(path);
  }
  return matches;
}

const states = await findState(root);
const matches = [];
for (const path of states) {
  try {
    const state = JSON.parse(await readFile(path, 'utf8'));
    if (state.tasks?.some((task) => task.title === expectedTitle && task.status === 'pending')) matches.push(path);
  } catch {
    // Ignore unrelated or incomplete session state files.
  }
}
if (matches.length !== 1) {
  console.error(`expected one persisted pending task, found ${matches.length}`);
  process.exit(1);
}
console.log(`persisted task verified in ${matches[0]}`);
