const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  buildChownCommand,
  isValidChownName,
  isValidChmodMode,
  isSafeRemotePath,
  quoteShellArgument,
} = require('../dist/sftp/chown-command.js');
const { SftpService } = require('../dist/sftp/sftp.service.js');

/**
 * 把生成的 chown 命令换成 printf 在真实 /bin/sh 里跑一遍，拿到 shell 解析后的 argv。
 * 这样能直接证明：不管路径里有什么，chown 收到的永远是 [--, spec, path] 三个参数，没有额外命令被执行。
 */
const shellArgv = (command) => {
  assert.ok(command.startsWith('chown '), command);
  const out = execFileSync('/bin/sh', ['-c', `printf '%s\\0' ${command.slice('chown '.length)}`]);
  return out.toString('utf8').split('\0').slice(0, -1);
};

test('owner / group names only accept safe characters', () => {
  for (const ok of ['www-data', 'root', '1000', 'user.name_1', '_apt', '4294967295']) {
    assert.equal(isValidChownName(ok), true, ok);
  }
  for (const bad of ['', '   ', 'a b', 'root:root', 'a/b', '$(id)', 'a;rm -rf /', 'a`whoami`', '-rf', '.hidden',
    "o'neil", 'a\nb', '4294967296', 'x'.repeat(65), null, 42]) {
    assert.equal(isValidChownName(bad), false, String(bad));
  }
});

test('owner only / group only / both', () => {
  assert.deepEqual(buildChownCommand('/var/www', { owner: 'www-data' }), { command: "chown -- 'www-data' '/var/www'", spec: 'www-data' });
  assert.deepEqual(buildChownCommand('/var/www', { group: 'www-data' }), { command: "chown -- ':www-data' '/var/www'", spec: ':www-data' });
  assert.deepEqual(buildChownCommand('/var/www', { owner: ' nginx ', group: '33' }), { command: "chown -- 'nginx:33' '/var/www'", spec: 'nginx:33' });
});

test('nothing to change or invalid input never yields a command', () => {
  assert.deepEqual(buildChownCommand('/x', {}), { command: null, error: 'emptyTargets' });
  assert.deepEqual(buildChownCommand('/x', { owner: '  ', group: '' }), { command: null, error: 'emptyTargets' });
  assert.equal(buildChownCommand('/x', { owner: 'a b' }).error, 'invalidOwner');
  assert.equal(buildChownCommand('/x', { group: 'g;h' }).error, 'invalidGroup');
  assert.equal(buildChownCommand('/x', { owner: 'ok', group: '$(x)' }).command, null);
  assert.equal(buildChownCommand('relative/path', { owner: 'root' }).error, 'invalidPath');
  assert.equal(buildChownCommand('-rf', { owner: 'root' }).error, 'invalidPath');
  assert.equal(buildChownCommand('/a\nb', { owner: 'root' }).error, 'invalidPath');
  assert.equal(buildChownCommand('/a\0b', { owner: 'root' }).error, 'invalidPath');
  assert.equal(buildChownCommand(undefined, { owner: 'root' }).error, 'invalidPath');
});

test('hostile paths reach chown as a single literal argument (checked with a real /bin/sh)', () => {
  const paths = [
    '/opt/my app',
    "/opt/it's",
    "/数据/我的'文件",
    '/tmp/$(touch /tmp/pwned)',
    '/tmp/`id`; rm -rf ~',
    '/tmp/a"b\\c$HOME*?[x]',
    '/tmp/ leading and trailing ',
    '/tmp/--help',
    "/tmp/'; echo injected; '",
  ];
  for (const p of paths) {
    const { command } = buildChownCommand(p, { owner: 'root', group: 'wheel' });
    assert.deepEqual(shellArgv(command), ['--', 'root:wheel', p], p);
  }
  assert.equal(quoteShellArgument("it's"), `'it'"'"'s'`);
  assert.equal(isSafeRemotePath('/ok'), true);
});

test('chmod mode validation', () => {
  for (const ok of [0, 0o644, 0o755, 0o4755, 0o7777]) assert.equal(isValidChmodMode(ok), true, ok.toString(8));
  for (const bad of [-1, 0o10000, 1.5, '755', NaN, null, undefined]) assert.equal(isValidChmodMode(bad), false, String(bad));
});

/** 假 SSH / SFTP：记录 exec 的命令，按需返回退出码与 stderr */
const makeState = ({ code = 0, stderr = '' } = {}) => {
  const sent = [];
  const execs = [];
  const state = {
    ws: { readyState: 1, send: (m) => sent.push(JSON.parse(m)) },
    sshClient: {
      exec(command, cb) {
        execs.push(command);
        const stream = new EventEmitter();
        stream.stderr = new EventEmitter();
        cb(undefined, stream);
        setImmediate(() => {
          if (stderr) stream.stderr.emit('data', Buffer.from(stderr));
          stream.emit('close', code);
        });
      },
    },
    sftp: {
      lstat(path, cb) {
        cb(undefined, {
          size: 1, uid: 33, gid: 33, mode: 0o100644, atime: 1, mtime: 2,
          isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false,
        });
      },
    },
  };
  return { state, sent, execs };
};

const waitFor = async (pred) => {
  for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 5));
};

test('SftpService.chown runs the quoted command and reports the new owner', async () => {
  const { state, sent, execs } = makeState();
  const svc = new SftpService(new Map([['s1', state]]));
  await svc.chown('s1', '/srv/my site', { owner: 'www-data', group: 'www-data' }, 'r1');
  await waitFor(() => sent.length > 0);
  assert.deepEqual(execs, ["chown -- 'www-data:www-data' '/srv/my site'"]);
  assert.equal(sent[0].type, 'sftp:chown:success');
  assert.equal(sent[0].requestId, 'r1');
  assert.equal(sent[0].payload.attrs.uid, 33);
  assert.equal(sent[0].payload.filename, 'my site');
});

test('SftpService.chown rejects bad input without touching SSH and surfaces permission errors', async () => {
  const bad = makeState();
  const svc = new SftpService(new Map([['s1', bad.state]]));
  await svc.chown('s1', '/x', { owner: 'root;reboot' }, 'r2');
  assert.deepEqual(bad.execs, []);
  assert.equal(bad.sent[0].type, 'sftp:chown:error');

  const denied = makeState({ code: 1, stderr: "chown: changing ownership of '/x': Operation not permitted\n" });
  const svc2 = new SftpService(new Map([['s1', denied.state]]));
  await svc2.chown('s1', '/x', { owner: 'root' }, 'r3');
  await waitFor(() => denied.sent.length > 0);
  assert.equal(denied.sent[0].type, 'sftp:chown:error');
  assert.match(denied.sent[0].payload, /Operation not permitted/);
  assert.match(denied.sent[0].payload, /root|CAP_CHOWN/);
});
