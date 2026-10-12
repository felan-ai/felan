import type { AutocompleteItem } from '@earendil-works/pi-tui';

export function insertBeforeSkillCommands(
  items: AutocompleteItem[],
  command: AutocompleteItem,
): AutocompleteItem[] {
  const skillIndex = items.findIndex(({ value }) => value.startsWith('skill:'));
  const insertionIndex = skillIndex === -1 ? items.length : skillIndex;
  return [
    ...items.slice(0, insertionIndex),
    command,
    ...items.slice(insertionIndex),
  ];
}
