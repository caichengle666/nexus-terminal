import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  expandHostRange,
  normalizeOpenSshCommand,
  parseScriptLine,
  parseScriptText,
  type ParsedScriptConnection,
} from '../../src/utils/scriptConnectionParser';

const items = (line: string): ParsedScriptConnection[] => {
  const r = parseScriptLine(line);
  assert.ok('items' in r, `expected items for: ${line} -> ${JSON.stringify(r)}`);
  return (r as { items: ParsedScriptConnection[] }).items;
};
const one = (line: string) => {
  const list = items(line);
  assert.equal(list.length, 1);
  return list[0];
};
const errKey = (line: string) => {
  const r = parseScriptLine(line);
  assert.ok('error' in r, `expected error for: ${line}`);
  return (r as { error: { key: string; params?: Record<string, unknown> } }).error;
};

// --- OpenSSH 命令规范化（必须保留的行为）---

test('normalizeOpenSshCommand：ssh -p 2222 user@host → user@host:2222', () => {
  assert.equal(normalizeOpenSshCommand('ssh -p 2222 user@host').line, 'user@host:2222');
  assert.equal(normalizeOpenSshCommand('ssh -p2222 user@host').line, 'user@host:2222');
});

test('normalizeOpenSshCommand：-l 用户、-i 密钥文件忽略、ssh:// 与尾部脚本选项保留', () => {
  assert.equal(normalizeOpenSshCommand('ssh -l admin -i ~/.ssh/id_ed25519 10.0.0.1').line, 'admin@10.0.0.1');
  assert.equal(normalizeOpenSshCommand('ssh ssh://ops@h.example:2200').line, 'ops@h.example:2200');
  assert.equal(normalizeOpenSshCommand('ssh -A -v root@h -name web -tags a b -note hi there').line, 'root@h -name web -tags a b -note hi there');
  assert.equal(normalizeOpenSshCommand('root@h -p x').line, 'root@h -p x'); // 非 ssh 开头原样
});

test('normalizeOpenSshCommand：缺目标 / 缺用户 / -p 缺值时报错', () => {
  assert.equal(normalizeOpenSshCommand('ssh -p 22').error?.key, 'connections.form.scriptErrorInvalidUserHostPortFormat');
  assert.equal(normalizeOpenSshCommand('ssh host.example').error?.key, 'connections.form.scriptErrorInvalidUserHostPortFormat');
  assert.equal(normalizeOpenSshCommand('ssh -p').error?.key, 'connections.form.scriptErrorMissingValueForKey');
});

test('OpenSSH 行：-p 是端口不是密码，且没有 -p/-k 时按空密码', () => {
  const c = one('ssh -p 2222 user@host');
  assert.equal(c.port, 2222);
  assert.equal(c.username, 'user');
  assert.equal(c.host, 'host');
  assert.equal(c.password, '');
  assert.equal(c.keyName, null);
});

test('OpenSSH 行：目标后面的 -name / -tags / -note 照常解析', () => {
  const c = one('ssh -l deploy 10.0.0.6 -name web -tags prod db -note "hello world"');
  assert.equal(c.name, 'web');
  assert.deepEqual(c.tags, ['prod', 'db']);
  assert.equal(c.note, 'hello world');
  assert.equal(c.port, 22);
});

// --- 原有脚本语法 ---

test('脚本行：user@host 默认 SSH 22，名字默认 user@host；无 -p/-k 为空密码', () => {
  const c = one('root@10.0.0.5');
  assert.deepEqual(
    { type: c.type, port: c.port, name: c.name, password: c.password },
    { type: 'SSH', port: 22, name: 'root@10.0.0.5', password: '' }
  );
});

test('脚本行：-p 密码（含空格与 @，加引号）、-k 密钥、-proxy', () => {
  const c = one('admin@h:2222 -p "P@ss word" -proxy corp');
  assert.equal(c.password, 'P@ss word');
  assert.equal(c.proxyName, 'corp');
  assert.equal(c.port, 2222);
  const k = one('ops@h -k my-key');
  assert.equal(k.keyName, 'my-key');
  assert.equal(k.password, null);
});

test('脚本行：RDP/VNC 默认端口，必须给密码且不能用密钥', () => {
  assert.equal(one('Administrator@h -type RDP -p x').port, 3389);
  assert.equal(one('u@h -type vnc -p x').port, 5900);
  assert.equal(errKey('u@h -type RDP').key, 'connections.form.scriptErrorMissingPasswordForRdp');
  assert.equal(errKey('u@h -type VNC -p x -k key').key, 'connections.form.scriptErrorKeyNotApplicableForVnc');
});

test('脚本行：-folder 是 -tags 的别名；-note 吃掉剩余内容', () => {
  const c = one('u@h -folder 生产 核心 -note 别 乱 动 -name x');
  assert.deepEqual(c.tags, ['生产', '核心']);
  assert.equal(c.note, '别 乱 动 -name x');
});

test('脚本行：错误码 —— 未知选项 / 多余参数 / 非法类型 / 缺值 / 目标格式 / 端口越界', () => {
  assert.equal(errKey('u@h -x 1').key, 'connections.form.scriptErrorUnknownOption');
  assert.equal(errKey('u@h extra').key, 'connections.form.scriptErrorUnexpectedArgument');
  assert.equal(errKey('u@h -type telnet').key, 'connections.form.scriptErrorInvalidType');
  assert.equal(errKey('u@h -name').key, 'connections.form.scriptErrorMissingValueForKey');
  assert.equal(errKey('just-a-host').key, 'connections.form.scriptErrorInvalidUserHostPortFormat');
  assert.equal(errKey('u@h:70000').key, 'connections.form.scriptErrorInvalidPort');
});

// --- 新增能力 ---

test('注释与空行跳过，不计为错误', () => {
  const r = parseScriptText('# c1\n\n// c2\n; c3\nroot@h\n');
  assert.equal(r.validConnections.length, 1);
  assert.equal(r.errorRows.length, 0);
  assert.equal(r.skippedLines, 3);
});

test('IP 范围：短写/长写展开，自定义名字补末位，跨 C 段报错', () => {
  const list = items('admin@10.0.0.10~12 -p x -name web');
  assert.deepEqual(list.map((c) => c.host), ['10.0.0.10', '10.0.0.11', '10.0.0.12']);
  assert.deepEqual(list.map((c) => c.name), ['web-10', 'web-11', 'web-12']);
  assert.equal(list[0].rangeSource, '10.0.0.10~12');
  assert.deepEqual(expandHostRange('10.0.0.1~10.0.0.2').hosts, ['10.0.0.1', '10.0.0.2']);
  assert.equal(errKey('u@10.0.0.1~10.0.1.2').key, 'connections.form.scriptErrorInvalidRange');
  assert.equal(errKey('u@10.0.0.9~3').key, 'connections.form.scriptErrorInvalidRange');
});

test('-jump：按连接名的跳板机链（逗号或空格分隔），仅 SSH，且不能与 -proxy 同用', () => {
  assert.deepEqual(one('u@h -jump gw1,gw2 gw3').jumpNames, ['gw1', 'gw2', 'gw3']);
  assert.equal(errKey('u@h -type RDP -p x -jump gw').key, 'connections.form.scriptErrorJumpSshOnly');
  assert.equal(errKey('u@h -proxy p -jump gw').key, 'connections.form.scriptErrorProxyAndJump');
  assert.equal(errKey('u@h -jump').key, 'connections.form.scriptErrorMissingValueForKey');
});

test('parseScriptText：逐行结果带 1-based 行号，有效与错误分开统计', () => {
  const r = parseScriptText('root@a\nbad line\nssh -p 2200 u@b\nu@c -type RDP');
  assert.equal(r.validConnections.length, 2);
  assert.deepEqual(r.errorRows.map((x) => x.lineIndex), [2, 4]);
  assert.equal(r.validConnections[1].port, 2200);
});
