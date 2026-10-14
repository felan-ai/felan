import { configField, defineExtensionConfig, getExtensionConfigCliOptions } from '@felan-ai/agent-core';
import { DEFAULT_CONFIG } from './renderers/powerline/config.js';
import { DEFAULT_ASK_USER_CONFIG } from './ask-user-preferences.js';

export const presentationDefinitions = [
  defineExtensionConfig({ id: 'askUser', title: 'Ask User', fields: {
    displayMode: configField.enum(['overlay', 'inline'], { default: DEFAULT_ASK_USER_CONFIG.displayMode, label: 'Display mode', description: 'Render questions inline or in a centered overlay' }),
    singleSelectLayout: configField.enum(['auto', 'list'], { default: DEFAULT_ASK_USER_CONFIG.singleSelectLayout, label: 'Single-select layout', description: 'Use a wide-terminal preview automatically or always show a list' }),
    overlayToggleKey: configField.string({ default: 'alt+o', label: 'Overlay toggle key', description: 'Shortcut for hiding or reopening an overlay; use off to disable' }),
    commentToggleKey: configField.string({ default: 'ctrl+g', label: 'Comment toggle key', description: 'Shortcut for toggling optional extra context; use off to disable' }),
  } }),
  defineExtensionConfig({ id: 'tasks', title: 'Tasks', fields: {
    displayMode: configField.enum(['inline', 'overlay'], { default: 'inline', label: 'Display mode', description: 'Render session tasks inline or in a centered overlay' }),
  } }),
  defineExtensionConfig({ id: 'promptHistory', title: 'Prompt History', fields: {
    displayMode: configField.enum(['inline', 'overlay'], { default: 'inline', label: 'Display mode', description: 'Render prompt history inline or in a centered overlay' }),
  } }),
  defineExtensionConfig({ id: 'contextView', title: 'Context View', fields: {
    displayMode: configField.enum(['inline', 'overlay'], { default: 'inline', label: 'Display mode', description: 'Render context usage inline or in a centered overlay' }),
  } }),
  defineExtensionConfig({ id: 'powerline', title: 'Powerline', fields: {
    style: configField.enum(['minimal', 'powerline', 'capsule'], { default: DEFAULT_CONFIG.display.style, description: 'Powerline footer style' }),
    charset: configField.enum(['text', 'unicode'], { default: DEFAULT_CONFIG.display.charset, description: 'Powerline footer charset' }),
    autoWrap: configField.boolean({ default: DEFAULT_CONFIG.display.autoWrap, description: 'Wrap long powerline segments' }),
    padding: configField.number({ default: DEFAULT_CONFIG.display.padding, description: 'Horizontal segment padding' }),
    lines: configField.json({ default: DEFAULT_CONFIG.display.lines, description: 'Ordered powerline lines and segments' }),
  } }),
];
export const presentationCliOptions = getExtensionConfigCliOptions(presentationDefinitions);
