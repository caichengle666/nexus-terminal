/**
 * 脚本模式连接批量导入解析器（纯函数，零运行时依赖，可单测）。
 *
 * 移植自上游 93fc9d79「脚本批量导入重做」的结构（逐行结果 + 错误码 + 实时预检），
 * 但**语法保持本分支原有规则**，老脚本无需改动：
 *
 *   user@host[:port] [-type SSH|RDP|VNC] [-name NAME] [-p PASSWORD] [-k KEY_NAME]
 *                    [-proxy PROXY_NAME] [-tags|-folder F1 F2...] [-jump J1,J2] [-note NOTE...]
 *
 * - 直接粘贴 OpenSSH 命令：`ssh -p 2222 user@host`、`ssh -l user host`、`ssh -i key user@host`、
 *   `ssh://user@host:port`，目标之后的 -name/-tags/-note 等脚本选项照常解析（normalizeOpenSshCommand）。
 * - SSH 行既没有 -p 也没有 -k 时按**空密码**的密码认证处理（内网设备可能无密码）；RDP/VNC 仍必须给 -p。
 * - 新增（来自上游）：`#` / `//` / `;` 开头的注释行跳过；`-folder` 作为 `-tags` 的别名；
 *   `-jump` 跳板机链（按连接名，仅 SSH）；host 写 IP 范围 `10.0.0.10~12` / `10.0.0.10~10.0.0.12` 一行展开多台。
 * - 上游的 `-protocol` / `-color` 本分支表单没有对应字段，未移植。
 *
 * 错误返回 i18n key + 参数，由界面翻译。
 */

export type ScriptConnectionType = 'SSH' | 'RDP' | 'VNC';

export interface ParsedScriptConnection {
  type: ScriptConnectionType;
  name: string;
  host: string;
  port: number;
  username: string;
  /** SSH 无 -p/-k 时为空串（空密码）；RDP/VNC 一定非空 */
  password: string | null;
  keyName: string | null;
  proxyName: string | null;
  /** 跳板机链（连接名，按顺序） */
  jumpNames: string[];
  /** 文件夹名（-tags / -folder） */
  tags: string[];
  note: string | null;
  /** 由 IP 范围展开时记录原始范围文本 */
  rangeSource?: string;
}

export interface ScriptLineError {
  /** vue-i18n key（connections.form.* ） */
  key: string;
  params?: Record<string, string | number>;
}

export interface ParsedScriptRow {
  /** 1-based 行号 */
  lineIndex: number;
  raw: string;
  items: ParsedScriptConnection[];
  error?: ScriptLineError;
  skipped?: boolean;
}

export interface ParseScriptResult {
  rows: ParsedScriptRow[];
  validConnections: ParsedScriptConnection[];
  errorRows: ParsedScriptRow[];
  skippedLines: number;
}

const DEFAULT_PORTS: Record<ScriptConnectionType, number> = { SSH: 22, RDP: 3389, VNC: 5900 };

const err = (key: string, params?: Record<string, string | number>): ScriptLineError => ({
  key: `connections.form.${key}`,
  ...(params ? { params } : {}),
});

/** 注释 / 空行：直接跳过 */
export function isSkippableScriptLine(line: string): boolean {
  const s = (line || '').trim();
  return !s || s.startsWith('#') || s.startsWith('//') || s.startsWith(';');
}

/**
 * 把 OpenSSH 命令行转换成脚本格式 "user@host:port ..."。
 * 支持 ssh [-p PORT] [-l USER] [其它常见选项] [user@]host[:port] 以及 ssh://user@host:port。
 * 目标之后的参数按原脚本选项继续解析。非 ssh 开头的行原样返回。
 */
export function normalizeOpenSshCommand(line: string): { line: string; error?: ScriptLineError } {
  const tokens = line.trim().split(/\s+/);
  if (tokens[0]?.toLowerCase() !== 'ssh') return { line };
  let port: string | null = null;
  let user: string | null = null;
  let dest: string | null = null;
  let i = 1;
  const valueOpts = new Set(['-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-m', '-O', '-o', '-Q', '-R', '-S', '-W', '-w']);
  for (; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === '-p' || tok === '-l') {
      const val = tokens[++i];
      if (!val) return { line, error: err('scriptErrorMissingValueForKey', { key: tok }) };
      if (tok === '-p') port = val; else user = val;
    } else if (/^-p\d+$/.test(tok)) {
      port = tok.slice(2);
    } else if (valueOpts.has(tok)) {
      i++; // 忽略这些选项及其值
    } else if (/^-[A-Za-z0-9]+$/.test(tok)) {
      // 无值的开关（-v, -A, -4 等），忽略
    } else {
      dest = tok;
      i++;
      break;
    }
  }
  if (!dest) return { line, error: err('scriptErrorInvalidUserHostPortFormat', { part: line.trim() }) };
  dest = dest.replace(/^ssh:\/\//i, '').replace(/\/$/, '');
  let host = dest;
  const at = dest.lastIndexOf('@');
  if (at !== -1) {
    user = dest.slice(0, at);
    host = dest.slice(at + 1);
  }
  const portMatch = host.match(/^(.*):(\d+)$/);
  if (portMatch) {
    host = portMatch[1];
    if (!port) port = portMatch[2];
  }
  if (!user || !host) return { line, error: err('scriptErrorInvalidUserHostPortFormat', { part: dest }) };
  const rest = tokens.slice(i).join(' ');
  return { line: `${user}@${host}${port ? `:${port}` : ''}${rest ? ` ${rest}` : ''}` };
}

/**
 * 展开 IP 范围：`10.0.0.10~12` / `10.0.0.10~10.0.0.12`（必须同一 C 段）。普通主机名原样返回。
 */
export function expandHostRange(host: string): { hosts: string[]; error?: ScriptLineError } {
  const raw = (host || '').trim();
  if (!raw.includes('~')) return { hosts: [raw] };
  const shortForm = raw.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.(\d{1,3})~(\d{1,3})$/);
  const longForm = raw.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.(\d{1,3})~(\d{1,3}\.\d{1,3}\.\d{1,3})\.(\d{1,3})$/);
  let prefix = '';
  let start = NaN;
  let end = NaN;
  if (shortForm) {
    prefix = shortForm[1];
    start = parseInt(shortForm[2], 10);
    end = parseInt(shortForm[3], 10);
  } else if (longForm && longForm[1] === longForm[3]) {
    prefix = longForm[1];
    start = parseInt(longForm[2], 10);
    end = parseInt(longForm[4], 10);
  }
  const prefixOk = prefix !== '' && prefix.split('.').every((n) => parseInt(n, 10) <= 255);
  if (!prefixOk || [start, end].some((n) => Number.isNaN(n) || n < 0 || n > 255) || start > end) {
    return { hosts: [], error: err('scriptErrorInvalidRange', { range: raw }) };
  }
  const hosts: string[] = [];
  for (let n = start; n <= end; n++) hosts.push(`${prefix}.${n}`);
  return { hosts };
}

/**
 * 解析单行，返回**展开后**的连接列表（IP 范围会变成多条）。
 */
export function parseScriptLine(rawLine: string): { skipped: true } | { error: ScriptLineError } | { items: ParsedScriptConnection[] } {
  if (isSkippableScriptLine(rawLine)) return { skipped: true };
  let line = rawLine.trim();

  // 0. 兼容直接粘贴的 OpenSSH 命令
  const openSsh = normalizeOpenSshCommand(line);
  if (openSsh.error) return { error: openSsh.error };
  line = openSsh.line;

  // 1. user@host[:port]
  const firstSpaceIndex = line.indexOf(' ');
  const userHostPortPart = firstSpaceIndex === -1 ? line : line.substring(0, firstSpaceIndex);
  const optionsString = firstSpaceIndex === -1 ? '' : line.substring(firstSpaceIndex + 1).trim();
  const match = userHostPortPart.match(/^([^@\s]+)@([^:\s]+)(?::([0-9]+))?$/);
  if (!match) return { error: err('scriptErrorInvalidUserHostPortFormat', { part: userHostPortPart }) };
  const [, username, hostPart, portStr] = match;

  let type: ScriptConnectionType = 'SSH';
  let customName: string | null = null;
  let password: string | null = null;
  let keyName: string | null = null;
  let proxyName: string | null = null;
  let jumpNames: string[] = [];
  let tags: string[] = [];
  let note: string | null = null;

  // 2. 选项（按空白切分，保留双引号内的整体）
  const args = optionsString.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  const unquote = (v: string) => v.replace(/^"|"$/g, '');
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (!arg.startsWith('-')) {
      return { error: err('scriptErrorUnexpectedArgument', { argument: arg }) };
    }
    const key = arg.substring(1).toLowerCase();
    i++;
    if (key === 'tags' || key === 'tag' || key === 'folder' || key === 'folders') {
      // 多值：一直吃到下一个 -flag
      tags = [];
      while (i < args.length && !args[i].startsWith('-')) {
        tags.push(unquote(args[i]));
        i++;
      }
      continue;
    }
    if (key === 'jump') {
      jumpNames = [];
      while (i < args.length && !args[i].startsWith('-')) {
        jumpNames.push(...unquote(args[i]).split(',').map((s) => s.trim()).filter(Boolean));
        i++;
      }
      if (!jumpNames.length) return { error: err('scriptErrorMissingValueForKey', { key: arg }) };
      continue;
    }
    if (key === 'note') {
      // -note 吃掉本行剩余全部内容
      note = unquote(args.slice(i).join(' '));
      break;
    }
    if (i >= args.length) return { error: err('scriptErrorMissingValueForKey', { key: arg }) };
    const value = unquote(args[i]);
    switch (key) {
      case 'type': {
        const upper = value.toUpperCase();
        if (upper !== 'SSH' && upper !== 'RDP' && upper !== 'VNC') {
          return { error: err('scriptErrorInvalidType', { value: args[i] }) };
        }
        type = upper;
        break;
      }
      case 'name': customName = value; break;
      case 'p': password = value; break;
      case 'k': keyName = value; break;
      case 'proxy': proxyName = value; break;
      default:
        return { error: err('scriptErrorUnknownOption', { option: arg }) };
    }
    i++;
  }

  // 3. 端口
  const port = portStr ? parseInt(portStr, 10) : DEFAULT_PORTS[type];
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { error: err('scriptErrorInvalidPort', { line: rawLine.trim(), port: portStr || String(port) }) };
  }

  // 4. 按类型校验
  if (type === 'SSH') {
    // SSH 未提供 -p/-k 时按空密码的密码认证处理（内网设备可能无密码）
    if (!password && !keyName) password = '';
    if (proxyName && jumpNames.length) return { error: err('scriptErrorProxyAndJump') };
  } else {
    if (!password) return { error: err(type === 'RDP' ? 'scriptErrorMissingPasswordForRdp' : 'scriptErrorMissingPasswordForVnc') };
    if (keyName) return { error: err(type === 'RDP' ? 'scriptErrorKeyNotApplicableForRdp' : 'scriptErrorKeyNotApplicableForVnc') };
    if (jumpNames.length) return { error: err('scriptErrorJumpSshOnly') };
  }

  // 5. IP 范围展开
  const range = expandHostRange(hostPart);
  if (range.error) return { error: range.error };
  const multi = range.hosts.length > 1;

  return {
    items: range.hosts.map((host) => ({
      type,
      name: customName
        ? (multi ? `${customName}-${host.split('.').pop()}` : customName)
        : `${username}@${host}`,
      host,
      port,
      username,
      password,
      keyName,
      proxyName,
      jumpNames: [...jumpNames],
      tags: [...tags],
      note,
      ...(multi ? { rangeSource: hostPart } : {}),
    })),
  };
}

/** 批量解析多行文本（实时预检用） */
export function parseScriptText(text: string): ParseScriptResult {
  const lines = (text || '').split(/\r?\n/);
  const rows: ParsedScriptRow[] = [];
  const validConnections: ParsedScriptConnection[] = [];
  const errorRows: ParsedScriptRow[] = [];
  let skippedLines = 0;
  lines.forEach((raw, idx) => {
    const res = parseScriptLine(raw);
    const lineIndex = idx + 1;
    if ('skipped' in res) {
      // 结尾的空行不计入「跳过」统计
      if (raw.trim()) skippedLines++;
      rows.push({ lineIndex, raw, items: [], skipped: true });
    } else if ('error' in res) {
      const row = { lineIndex, raw, items: [], error: res.error };
      rows.push(row);
      errorRows.push(row);
    } else {
      validConnections.push(...res.items);
      rows.push({ lineIndex, raw, items: res.items });
    }
  });
  return { rows, validConnections, errorRows, skippedLines };
}
