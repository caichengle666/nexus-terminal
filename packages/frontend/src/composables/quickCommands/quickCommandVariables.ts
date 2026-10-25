/**
 * 快捷指令变量的纯函数层（移植自上游 useQuickCommandExecution，f160a2d0）。
 *
 * 必须保持零运行时依赖（只能 import type），便于单测直接打包运行。
 */

export interface QuickCommandLike {
  id?: number;
  name?: string | null;
  command: string;
  variables?: Record<string, string> | null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 用变量值替换 `${name}` 占位符。
 * 未定义的变量保持原样，不做静默清空（清空会变成执行一条不完整的命令）。
 */
export function resolveCommandVariables(
  template: string,
  savedVariables: Record<string, string> | null | undefined
): string {
  if (!template) return '';
  const vars = savedVariables || {};
  let result = template;
  for (const varName of Object.keys(vars)) {
    const value = vars[varName];
    if (value === undefined || value === null) continue;
    const placeholder = new RegExp(`\\$\\{${escapeRegExp(varName)}\\}`, 'g');
    // 函数式替换：值里的 $& / $1 不会被当成替换模式
    result = result.replace(placeholder, () => value);
  }
  return result;
}

/** 取出模板里声明的变量名（去重，按出现顺序） */
export function extractVariableNames(template: string): string[] {
  const matches = template?.match(/\$\{([^}]+)\}/g) || [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const raw of matches) {
    const name = raw.slice(2, -1);
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/**
 * 当前还缺值的变量名：模板里出现、但没定义 / 空串 / 纯空白都算缺。
 * `${path}` 填成空串拼出来就是 `rm -rf ` 这种残废命令，宁可让用户先补一个字符。
 */
export function getMissingVariableNames(
  template: string,
  savedVariables: Record<string, string> | null | undefined
): string[] {
  const vars = savedVariables || {};
  return extractVariableNames(template).filter((name) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) return true;
    const value = vars[name];
    return typeof value !== 'string' || value.trim() === '';
  });
}

/** 变量为空时请用户补填，返回补全后的变量表；返回 null 表示用户取消 */
export type QuickCommandVariablePrompter = (
  command: QuickCommandLike
) => Promise<Record<string, string> | null>;

/**
 * 发送前把指令准备好：缺变量就先 await 补填弹窗，再做替换。
 *
 * @returns 替换后的最终命令；用户取消或弹窗异常时返回 null（调用方不发、不计使用次数）。
 */
export async function prepareQuickCommandForSend(
  cmd: QuickCommandLike,
  promptVariables?: QuickCommandVariablePrompter
): Promise<string | null> {
  let variables: Record<string, string> = { ...(cmd.variables || {}) };
  if (cmd.command && promptVariables) {
    const missing = getMissingVariableNames(cmd.command, variables);
    if (missing.length > 0) {
      try {
        const filled = await promptVariables(cmd);
        if (!filled) return null;
        variables = { ...variables, ...filled };
      } catch (error) {
        console.error('[QuickCommand] 变量补填弹窗异常，已取消本次执行:', error);
        return null;
      }
    }
  }
  return resolveCommandVariables(cmd.command, variables);
}
