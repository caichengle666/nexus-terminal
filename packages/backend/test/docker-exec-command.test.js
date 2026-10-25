const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildDockerExecCommand,
  buildShellProbeCommand,
  parseShellProbeOutput,
  isAllowedContainerShell,
} = require('../dist/docker/exec-command.js');
const { clientStates } = require('../dist/websocket/state.js');
const { handleDockerGetExecCommand, detectContainerShell } = require('../dist/websocket/handlers/docker.handler.js');

/**
 * 假 docker：
 *   docker inspect -f '{{.Os}}' <cid>  → 按容器名返回 linux / windows，未知容器退出 1
 *   docker exec <cid> <shell> ...      → 只有 SHELLS_<cid> 里列出的 shell 成功
 * 每次调用把 argv 记到 $DOCKER_LOG，用来证明容器 ID 原样作为单个参数到达 docker。
 */
const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-docker-'));
const dockerLog = path.join(fakeBinDir, 'calls.log');
fs.writeFileSync(path.join(fakeBinDir, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> "$DOCKER_LOG"
case "$1" in
  inspect)
    cid="$4"
    case "$cid" in
      alpine1|debian1|distroless1) echo linux ;;
      win1) echo windows ;;
      *) echo "Error: No such object: $cid" >&2; exit 1 ;;
    esac ;;
  exec)
    cid="$2"; sh_name="$3"
    case "$cid:$sh_name" in
      alpine1:ash|alpine1:sh|debian1:bash|debian1:sh|win1:pwsh|win1:cmd) exit 0 ;;
      *) echo 'OCI runtime exec failed: executable file not found in $PATH' >&2; exit 126 ;;
    esac ;;
esac
`, { mode: 0o755 });
const env = { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}`, DOCKER_LOG: dockerLog };

const runProbe = (cid) => execFileSync('/bin/sh', ['-c', buildShellProbeCommand(cid)], { env }).toString();

test.after(() => fs.rmSync(fakeBinDir, { recursive: true, force: true }));

test('exec command uses the detected shell, whitelisted, and falls back to sh', () => {
  assert.equal(buildDockerExecCommand('abc123', 'bash'), 'docker exec -it abc123 bash');
  assert.equal(buildDockerExecCommand('web-1', ''), 'docker exec -it web-1 sh');
  assert.equal(buildDockerExecCommand('web-1', null), 'docker exec -it web-1 sh');
  assert.equal(buildDockerExecCommand('web-1', 'bash; rm -rf /'), 'docker exec -it web-1 sh');
  assert.equal(buildDockerExecCommand('web-1', 'zsh'), 'docker exec -it web-1 sh', 'not in whitelist');
  assert.throws(() => buildDockerExecCommand('abc; reboot', 'sh'), /Invalid container ID/);
  assert.throws(() => buildShellProbeCommand('$(id)'), /Invalid container ID/);
  for (const s of ['bash', 'ash', 'sh', 'powershell', 'pwsh', 'cmd']) assert.equal(isAllowedContainerShell(s), true);
  assert.equal(isAllowedContainerShell('sh -c id'), false);
});

test('probe output parsing ignores noise and non-whitelisted values', () => {
  assert.deepEqual(parseShellProbeOutput('junk\nNEXUS_OS=linux\nNEXUS_SHELL=ash\n'), { shell: 'ash', os: 'linux' });
  assert.deepEqual(parseShellProbeOutput('NEXUS_OS=\nNEXUS_SHELL=\n'), { shell: '', os: 'unknown' });
  assert.deepEqual(parseShellProbeOutput('NEXUS_OS=linux\nNEXUS_SHELL=evil;id\n'), { shell: '', os: 'linux' });
  assert.deepEqual(parseShellProbeOutput(''), { shell: '', os: 'unknown' });
});

test('probe script picks bash > ash > sh on linux and powershell > pwsh > cmd on windows (real /bin/sh)', () => {
  assert.deepEqual(parseShellProbeOutput(runProbe('debian1')), { shell: 'bash', os: 'linux' });
  assert.deepEqual(parseShellProbeOutput(runProbe('alpine1')), { shell: 'ash', os: 'linux' });
  assert.deepEqual(parseShellProbeOutput(runProbe('win1')), { shell: 'pwsh', os: 'windows' });
  assert.deepEqual(parseShellProbeOutput(runProbe('distroless1')), { shell: '', os: 'linux' });
  // 探测期 docker 写到 stderr 的噪音不能出现在 stdout 里
  assert.doesNotMatch(runProbe('distroless1'), /executable file not found/);
});

test('container id reaches docker as one literal argument', () => {
  fs.writeFileSync(dockerLog, '');
  runProbe('app.service_2');
  const calls = fs.readFileSync(dockerLog, 'utf8').trim().split('\n');
  assert.equal(calls[0], 'inspect -f {{.Os}} app.service_2');
  assert.ok(calls.slice(1).every((c) => c.startsWith('exec app.service_2 ')), calls.join('|'));
});

/** 把 sshClient.exec 接到本机 /bin/sh（PATH 里是假 docker），走完整的 handler 链路 */
const makeLocalSshClient = () => {
  const commands = [];
  return {
    commands,
    exec(command, _opts, cb) {
      commands.push(command);
      const child = spawn('/bin/sh', ['-c', command], { env });
      const stream = new EventEmitter();
      stream.stderr = child.stderr;
      stream.signal = () => child.kill('SIGKILL');
      stream.close = () => child.kill('SIGKILL');
      child.stdout.on('data', (d) => stream.emit('data', d));
      child.on('close', (code) => stream.emit('close', code));
      cb(undefined, stream);
    },
  };
};

test('docker:get_exec_command replies with the detected command and caches per container', async () => {
  const sshClient = makeLocalSshClient();
  const sent = [];
  const ws = { readyState: 1, send: (m) => sent.push(JSON.parse(m)) };
  clientStates.set('sess-docker', { ws, sshClient });
  try {
    await handleDockerGetExecCommand(ws, 'sess-docker', { containerId: 'alpine1', requestId: 'r1' });
    assert.deepEqual(sent[0], { type: 'docker:exec_command', payload: { containerId: 'alpine1', requestId: 'r1', command: 'docker exec -it alpine1 ash', shell: 'ash', detected: true } });

    const before = sshClient.commands.length;
    const again = await detectContainerShell(clientStates.get('sess-docker'), 'alpine1');
    assert.equal(again.shell, 'ash');
    assert.equal(again.cached, true);
    assert.equal(sshClient.commands.length, before, 'second lookup must hit the cache');

    await handleDockerGetExecCommand(ws, 'sess-docker', { containerId: 'distroless1', requestId: 'r2' });
    assert.equal(sent[1].payload.command, 'docker exec -it distroless1 sh');
    assert.equal(sent[1].payload.detected, false);

    await handleDockerGetExecCommand(ws, 'sess-docker', { containerId: 'x; reboot', requestId: 'r3' });
    assert.equal(sent[2].payload.command, undefined);
    assert.match(sent[2].payload.error, /Invalid container ID/);
    assert.equal(sent[2].payload.containerId, '');
    assert.ok(sshClient.commands.every((c) => !c.includes('reboot')));
  } finally {
    clientStates.delete('sess-docker');
  }
});

test('docker:get_exec_command without an SSH session reports an error', async () => {
  const sent = [];
  const ws = { readyState: 1, send: (m) => sent.push(JSON.parse(m)) };
  await handleDockerGetExecCommand(ws, 'missing', { containerId: 'abc', requestId: 'r' });
  assert.match(sent[0].payload.error, /SSH connection not active/);
});
