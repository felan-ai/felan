import { stripFrontmatter, type Skill } from '@earendil-works/pi-coding-agent';
import type { AgentRuntime } from '@felan-ai/agent-core';

const SKILL_BYTES = 256 * 1024;

export async function expandSkillCommand(runtime: Pick<AgentRuntime, 'readFile'>, skill: Skill | undefined, rawArgs: string): Promise<string | undefined> {
  if (!skill) return undefined;
  try {
    const bytes = await runtime.readFile(skill.filePath, { maxBytes: SKILL_BYTES + 1 });
    if (bytes.byteLength > SKILL_BYTES) return undefined;
    const body = stripFrontmatter(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).trim();
    const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
    const args = rawArgs.trim();
    return args ? `${block}\n\n${args}` : block;
  } catch { return undefined; }
}

export function unknownCommandMessage(name: string, commands: readonly { name: string }[]): string {
  const query = [...name.toLowerCase()];
  // Every skill name shares the prefix, so it must not count toward the length that allows a second edit.
  const threshold = [...name.replace(/^skill:/u, '')].length > 3 ? 2 : 1;
  const label = (value: string) => `/${value.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')}`;
  const matches = commands.flatMap(command => {
    const candidate = [...command.name.toLowerCase()];
    if (Math.abs(query.length - candidate.length) > threshold) return [];
    const distance = editDistance(query, candidate);
    return distance <= threshold ? [{ name: command.name, distance }] : [];
  }).sort((a, b) => a.distance - b.distance || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, 3).map(match => label(match.name));
  return `Unknown or unavailable command: ${label(name)}.${matches.length ? ` Did you mean ${matches.join(', ')}?` : ''}`;
}

function editDistance(left: readonly string[], right: readonly string[]): number {
  const row = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (const char of left) {
    let diagonal = row[0]!;
    row[0] = diagonal + 1;
    for (let j = 1; j <= right.length; j++) {
      const previous = row[j]!;
      row[j] = Math.min(previous + 1, row[j - 1]! + 1, diagonal + Number(char !== right[j - 1]));
      diagonal = previous;
    }
  }
  return row[right.length]!;
}
