import { ref } from 'vue';
import { getMissingVariableNames, type QuickCommandLike } from './quickCommandVariables';

/**
 * 快捷指令「变量补填」弹窗的全局单例状态（移植自上游 f160a2d0）。
 *
 * 触发点不止一个（侧栏快捷指令面板、命令栏弹出的快捷指令、命令栏回车选中、指令表单里的「执行」），
 * 弹窗只在 App 里挂一次；各触发点 `await promptQuickCommandVariables(cmd)` 即可。
 */
export interface QuickCommandVariablePromptState {
  commandName: string;
  template: string;
  /** 需要补填的变量名（按模板出现顺序） */
  missing: string[];
  /** 已有值，交给弹窗预填 */
  values: Record<string, string>;
}

export const quickCommandVariablePromptState = ref<QuickCommandVariablePromptState | null>(null);

let pendingResolver: ((values: Record<string, string> | null) => void) | null = null;

function settle(values: Record<string, string> | null) {
  const resolve = pendingResolver;
  pendingResolver = null;
  quickCommandVariablePromptState.value = null;
  resolve?.(values);
}

/** 请用户补填变量；没有缺失时立刻返回已有变量（不弹窗），取消返回 null */
export function promptQuickCommandVariables(cmd: QuickCommandLike): Promise<Record<string, string> | null> {
  const values = cmd.variables || {};
  const missing = getMissingVariableNames(cmd.command, values);
  if (missing.length === 0) return Promise.resolve({ ...values });

  // 上一个弹窗还没关（连点两下 / 换了一条指令）：当成取消，避免 resolve 泄漏
  if (pendingResolver) settle(null);

  return new Promise((resolve) => {
    pendingResolver = resolve;
    quickCommandVariablePromptState.value = {
      commandName: cmd.name || '',
      template: cmd.command || '',
      missing,
      values: { ...values },
    };
  });
}

export function submitQuickCommandVariables(filled: Record<string, string>) {
  settle({ ...(quickCommandVariablePromptState.value?.values || {}), ...filled });
}

export function cancelQuickCommandVariablePrompt() {
  if (pendingResolver) settle(null);
  else quickCommandVariablePromptState.value = null;
}
