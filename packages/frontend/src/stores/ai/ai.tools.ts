import {
  MAX_MODEL_MESSAGE_CONTENT_LENGTH,
  MAX_TOOL_RESULT_CONTENT_LENGTH,
  MAX_TOOL_RESULT_SUMMARY_LENGTH,
} from './ai.constants';
import type { AiToolCall, RiskConfirmation, TerminalInputArgs } from './ai.types';

export const aiTools = [
  {
    type: 'function',
    function: {
      name: 'get_terminal_output',
      description: 'Read recent visible output from the target locked SSH terminal immediately. Without afterCursor it returns a full snapshot; with a valid cursor it returns only changes and may omit an unchanged body. Use wait_for_terminal_output when a visible command may still be running.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          maxLines: { type: 'number', description: 'Maximum lines to read. Default 800, maximum 3000.' },
          sinceLastInput: { type: 'boolean', description: 'When true, read only output produced after the last terminal_input call in this session.' },
          afterCursor: { type: 'string', description: 'Optional cursor returned by a previous read. When valid, only changed output after that snapshot is returned.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wait_for_terminal_output',
      description: 'Wait for visible output on the target locked SSH terminal to change, settle, show a shell prompt, or time out. Pass afterCursor to receive only changes; without it the current snapshot is returned. Use after terminal_input instead of sending an empty Enter.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          timeoutMs: { type: 'number', description: 'Maximum wait in milliseconds. Default 15000, maximum 60000.' },
          maxLines: { type: 'number', description: 'Maximum lines to return. Default 800, maximum 3000.' },
          sinceLastInput: { type: 'boolean', description: 'Read only output after the last terminal_input. Default true.' },
          afterCursor: { type: 'string', description: 'Optional cursor returned by a previous read or wait.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'terminal_input',
      description: 'Send visible input to the target locked SSH terminal. Prefer this for ordinary commands on the current terminal so the user can observe every action. Also use it for interactive prompts or text that must appear in the shell.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          text: { type: 'string', description: 'Text or command to send to terminal.' },
          pressEnter: { type: 'boolean', description: 'Append Enter after text. Default false.' },
          waitMs: { type: 'number', description: 'Maximum initial wait for visible output to settle. Default 3000, maximum 10000. Use wait_for_terminal_output for longer operations.' },
          reason: { type: 'string', description: 'Short reason why this input is needed.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_command',
      description: 'Execute one non-interactive command in a background SSH channel and return clean stdout, stderr, exit code, timeout and duration. The command is shown in the AI tool activity but not typed into the visible terminal. Use only when an exact exit status or clean machine-readable output is important; otherwise prefer terminal_input so the user can observe the action.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['command'],
        properties: {
          command: { type: 'string', maxLength: 32768, description: 'Non-interactive shell command to execute. Maximum 32KB.' },
          timeoutMs: { type: 'number', description: 'Execution timeout in milliseconds. Default 30000, maximum 180000.' },
          reason: { type: 'string', description: 'Short reason why this command is needed.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_terminal_key',
      description: 'Send one explicit control key to the visible locked SSH terminal. Use for interactive input only; use wait_for_terminal_output to observe the result.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['key'],
        properties: {
          key: { type: 'string', enum: ['enter', 'ctrl_c', 'escape', 'tab'], description: 'Control key to send.' },
          reason: { type: 'string', description: 'Short reason why this key is needed.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_remote_file',
      description: 'Read a text file from the target locked SSH session through SFTP. This tool is read-only and returns at most 64KB of decoded text.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: {
          path: { type: 'string', maxLength: 4096, description: 'Absolute remote file path to read.' },
          encoding: { type: 'string', maxLength: 64, description: 'Optional text encoding. Omit to use server-side detection.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_remote_directory',
      description: 'List files and directories on the target locked SSH session through SFTP. This tool is read-only and returns at most 500 entries.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: {
          path: { type: 'string', maxLength: 4096, description: 'Absolute remote directory path to list.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_active_terminals',
      description: 'List currently connected SSH terminal sessions. Use before a batch operation to obtain exact target session IDs.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_command_batch',
      description: 'Execute the same non-interactive command on explicitly selected connected SSH terminals. Use only when the user clearly requests a multi-VPS or batch operation. Always requires user confirmation.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['command', 'targetSessionIds'],
        properties: {
          command: { type: 'string', maxLength: 32768, description: 'Non-interactive shell command to execute on every selected target. Maximum 32KB.' },
          targetSessionIds: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' }, description: 'Exact session IDs returned by list_active_terminals.' },
          timeoutMs: { type: 'number', description: 'Per-terminal timeout in milliseconds. Default 30000, maximum 180000.' },
          reason: { type: 'string', description: 'Short reason for the batch operation.' },
        },
      },
    },
  },
] as const;

const extractImportantLines = (content: string, maxLines = 18) => {
  const lines = content.split('\n').map(line => line.trimEnd()).filter(Boolean);
  const important = lines.filter(line => (
    /error|failed|failure|exception|traceback|denied|refused|timeout|warning|fatal|cannot|not found|permission/i.test(line)
    || /^\s*(root|admin|ubuntu|debian|centos|almalinux|rocky)?@?[\w.-]+[:~/$#]/i.test(line)
  ));
  return important.slice(-maxLines);
};

const summarizeLongText = (content: string, maxLength = MAX_TOOL_RESULT_SUMMARY_LENGTH) => {
  if (content.length <= maxLength) return content;
  const lines = content.split('\n');
  const head = lines.slice(0, 12).join('\n');
  const important = extractImportantLines(content).join('\n');
  const tail = lines.slice(-24).join('\n');
  return [
    `<terminal output summarized: ${lines.length} lines, ${content.length} chars>`,
    '[head]',
    head,
    important ? '[important]' : '',
    important,
    '[tail]',
    tail,
  ].filter(Boolean).join('\n').slice(0, maxLength);
};

export const summarizeToolResultContent = (content: string) => {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object') {
      const result = parsed as Record<string, unknown>;
      const output = typeof result.outputAfter === 'string'
        ? result.outputAfter
        : typeof result.output === 'string'
          ? result.output
          : '';
      if (output) {
        return JSON.stringify({
          ...result,
          outputAfter: undefined,
          output: summarizeLongText(output),
          outputSummary: `${output.split('\n').length} lines, ${output.length} chars`,
        });
      }
    }
  } catch {
    // Plain terminal text is summarized below.
  }
  return summarizeLongText(content);
};

export const stringifyToolResultForModel = (result: unknown) => {
  const content = JSON.stringify(result);
  const summarized = summarizeToolResultContent(content);
  if (summarized.length <= MAX_TOOL_RESULT_CONTENT_LENGTH) return summarized;
  return `${summarized.slice(0, MAX_TOOL_RESULT_CONTENT_LENGTH)}\n...<tool result summarized, ask get_terminal_output with sinceLastInput=true or narrower maxLines if needed>`;
};

export const truncateForModel = (content: string, maxLength = MAX_MODEL_MESSAGE_CONTENT_LENGTH) => {
  if (content.length <= maxLength) return content;
  return `${content.slice(0, maxLength)}\n...<content truncated to keep the AI request small>`;
};

export const parseToolArgs = (toolCall: AiToolCall): Record<string, any> => {
  try {
    const parsed = JSON.parse(toolCall.function.arguments || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('arguments must be a JSON object');
    }
    return parsed;
  } catch (error: any) {
    throw new Error(`AI 返回的工具参数不是有效 JSON：${error?.message || '解析失败'}`);
  }
};

export const normalizeCommand = (value: string) => value.trim().replace(/\s+/g, ' ');

export const detectRiskyCommand = (args: TerminalInputArgs): RiskConfirmation | null => {
  if (!args.pressEnter) return null;

  const command = normalizeCommand(String(args.text || ''));
  if (!command) return null;

  const riskyPatterns: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /\brm\s+(-[^\s]*[rf][^\s]*|--recursive|--force)/i, reason: '删除文件或目录，且包含递归/强制参数' },
    { pattern: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: '会重启或关闭服务器' },
    { pattern: /\bmkfs(\.|$|\s)|\bdd\s+.*\bof=/i, reason: '可能格式化或直接写入磁盘设备' },
    { pattern: /\b(chmod|chown)\s+(-[^\s]*R[^\s]*|--recursive)\b/i, reason: '会递归修改权限或所有者' },
    { pattern: /\bapt(-get)?\s+(upgrade|dist-upgrade|full-upgrade|autoremove|remove|purge)\b/i, reason: '会修改系统软件包' },
    { pattern: /\byum\s+(update|remove|erase)|\bdnf\s+(upgrade|remove|erase)|\bpacman\s+-R/i, reason: '会修改系统软件包' },
    { pattern: /\bdocker\s+(rm|rmi|system\s+prune|volume\s+rm|compose\s+down)\b/i, reason: '会删除或停止 Docker 资源' },
    { pattern: /\bsystemctl\s+(restart|stop|disable|mask)\b/i, reason: '会停止或重启系统服务' },
    { pattern: /\biptables\b|\bufw\s+(disable|reset|delete)|\bfirewall-cmd\b/i, reason: '会修改防火墙或网络访问规则' },
    { pattern: />\s*\/etc\/|tee\s+\/etc\/|\bsed\s+-i\b.*\/etc\//i, reason: '会修改系统配置文件' },
  ];

  const hit = riskyPatterns.find(item => item.pattern.test(command));
  return hit ? { command, reason: hit.reason } : null;
};
