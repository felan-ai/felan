import { join } from 'node:path';
import { runScenario } from './driver.mjs';
const [id, mode, modelId, encodedSource] = process.argv.slice(2);
try {
  const authDir = process.env.FELAN_AGENT_DIR;
  if (!authDir) throw new Error('Isolated authenticated Pi runtime is required');
  const base = '/usr/local/lib/node_modules/@felan-ai';
  const core = await import(`${base}/agent-core/dist/index.js`);
  const felan = await import(`${base}/felan/dist/index.js`);
  const modelRuntime = await core.ModelRuntime.create({ authPath: join(authDir, 'auth.json'), modelsPath: join(authDir, 'models.json') });
  const result = await runScenario({ core, felan, modelRuntime, id, mode, modelId, workspace: '/workspace',
    source: JSON.parse(Buffer.from(encodedSource, 'base64url').toString()) });
  console.log(JSON.stringify(result));
  if (result.status !== 'completed') process.exitCode = 1;
} catch {
  console.error('Turn-classification driver failed; raw provider errors are not retained.');
  process.exitCode = 1;
}
