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
      description: 'Read recent visible output from the target locked SSH terminal.',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Target terminal session ID. Defaults to the locked session for this AI run.' },
          maxLines: { type: 'number', description: 'Maximum lines to read. Default 120.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'terminal_input',
      description: 'Send text to the target locked SSH terminal immediately. Use pressEnter=true to submit a command.',
      parameters: {
        type: 'object',
        required: ['text'],
        properties: {
          sessionId: { type: 'string', description: 'Target terminal session ID. Defaults to the locked session for this AI run.' },
          text: { type: 'string', description: 'Text or command to send to terminal.' },
          pressEnter: { type: 'boolean', description: 'Append Enter after text. Default false.' },
          waitMs: { type: 'number', description: 'Milliseconds to wait before reading output after input. Default 900.' },
          reason: { type: 'string', description: 'Short reason why this input is needed.' },
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
  return `${summarized.slice(0, MAX_TOOL_RESULT_CONTENT_LENGTH)}\n...<tool result summarized, ask get_terminal_output with narrower maxLines if needed>`;
};

export const truncateForModel = (content: string, maxLength = MAX_MODEL_MESSAGE_CONTENT_LENGTH) => {
  if (content.length <= maxLength) return content;
  return `${content.slice(0, maxLength)}\n...<content truncated to keep the AI request small>`;
};

export const parseToolArgs = (toolCall: AiToolCall): Record<string, any> => {
  try {
    const parsed = JSON.parse(toolCall.function.arguments || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
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
