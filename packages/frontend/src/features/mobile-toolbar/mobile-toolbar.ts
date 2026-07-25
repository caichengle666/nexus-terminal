export const mobileToolbarModuleIds = [
  'clearTerminal',
  'quickCommands',
  'commandInput',
  'aiAssistant',
  'suspendedSessions',
  'virtualKeyboard',
  'fileManager',
  'fileEditor',
] as const;

export type MobileToolbarModuleId = typeof mobileToolbarModuleIds[number];

export interface MobileToolbarModuleDefinition {
  id: MobileToolbarModuleId;
  label: string;
  icon: string;
  required?: boolean;
}

export const mobileToolbarModules: MobileToolbarModuleDefinition[] = [
  { id: 'clearTerminal', label: '清空终端', icon: 'fas fa-eraser' },
  { id: 'quickCommands', label: '快捷指令', icon: 'fas fa-bolt' },
  { id: 'commandInput', label: '命令输入框', icon: 'fas fa-terminal', required: true },
  { id: 'aiAssistant', label: 'AI 终端助手', icon: 'fas fa-robot' },
  { id: 'suspendedSessions', label: '挂起会话', icon: 'fas fa-pause-circle' },
  { id: 'virtualKeyboard', label: '扩展键盘', icon: 'fas fa-keyboard' },
  { id: 'fileManager', label: '文件管理器', icon: 'fas fa-folder' },
  { id: 'fileEditor', label: '文件编辑器', icon: 'fas fa-edit' },
];

export const defaultMobileToolbarItems: MobileToolbarModuleId[] = [
  'clearTerminal',
  'quickCommands',
  'commandInput',
  'aiAssistant',
  'virtualKeyboard',
  'fileManager',
];

const validModuleIds = new Set<MobileToolbarModuleId>(mobileToolbarModuleIds);

export function sanitizeMobileToolbarItems(value: unknown): MobileToolbarModuleId[] {
  const source = Array.isArray(value) ? value : [];
  const seen = new Set<MobileToolbarModuleId>();
  const result: MobileToolbarModuleId[] = [];

  for (const item of source) {
    if (typeof item !== 'string' || !validModuleIds.has(item as MobileToolbarModuleId)) continue;
    const moduleId = item as MobileToolbarModuleId;
    if (seen.has(moduleId)) continue;
    seen.add(moduleId);
    result.push(moduleId);
  }

  if (!seen.has('commandInput')) {
    const defaultInputIndex = defaultMobileToolbarItems.indexOf('commandInput');
    result.splice(Math.min(defaultInputIndex, result.length), 0, 'commandInput');
  }

  return result.length > 1 ? result : [...defaultMobileToolbarItems];
}

export function parseMobileToolbarItems(value?: string): MobileToolbarModuleId[] {
  if (!value) return [...defaultMobileToolbarItems];
  try {
    return sanitizeMobileToolbarItems(JSON.parse(value));
  } catch {
    return [...defaultMobileToolbarItems];
  }
}