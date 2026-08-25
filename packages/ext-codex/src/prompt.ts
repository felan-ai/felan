import type { Skill } from '@felan-ai/agent-core';

interface PromptSkill {
  readonly name: string;
  readonly description: string;
  readonly filePath: string;
}

const SKILLS_SECTION_OPEN = '<skills_instructions>';

export function injectCodexSkills(
  systemPrompt: string,
  skills: readonly Skill[] | undefined,
): string {
  if (systemPrompt.includes(SKILLS_SECTION_OPEN)) return systemPrompt;
  const visibleSkills = (skills ?? [])
    .filter((skill) => !skill.disableModelInvocation)
    .map(({ name, description, filePath }) => ({ name, description, filePath }));
  if (visibleSkills.length === 0) return systemPrompt;
  return insertBeforeTrailingContext(systemPrompt, formatSkillsSection(visibleSkills));
}

function formatSkillsSection(skills: readonly PromptSkill[]): string {
  const lines = [
    SKILLS_SECTION_OPEN,
    '## Skills',
    'Skills are local instructions stored in `SKILL.md` files.',
    '### Available skills',
    '<available_skills>',
  ];
  for (const skill of skills) {
    lines.push('  <skill>');
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push('  </skill>');
  }
  lines.push('</available_skills>');
  lines.push('### How to use skills');
  lines.push('- Use a skill when the user names it or the request clearly matches its description.');
  lines.push('- Use the minimal required set. If multiple skills apply, state the order briefly.');
  lines.push('- Open each selected `SKILL.md` before acting, resolve relative paths from its directory, and load only the referenced files you need.');
  lines.push('- Prefer existing skill scripts, assets, and templates over recreating them.');
  lines.push('### Fallback');
  lines.push('- If a skill is missing or its path cannot be read, say so briefly and continue with the best available approach.');
  lines.push('</skills_instructions>');
  return lines.join('\n');
}

function insertBeforeTrailingContext(systemPrompt: string, section: string): string {
  const markers = ['\nCurrent working directory:', '\nCurrent date:'];
  let insertionIndex = systemPrompt.length;
  for (const marker of markers) {
    const index = systemPrompt.lastIndexOf(marker);
    if (index !== -1) insertionIndex = Math.min(insertionIndex, index);
  }
  if (insertionIndex === systemPrompt.length) {
    const separator = systemPrompt.endsWith('\n') ? '\n' : '\n\n';
    return `${systemPrompt}${separator}${section}`;
  }
  return `${systemPrompt.slice(0, insertionIndex)}\n\n${section}${systemPrompt.slice(insertionIndex)}`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}
