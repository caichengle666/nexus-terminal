const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { Client, Server, utils } = require('ssh2');
const {
  computeFingerprint,
  decideHostKey,
  normalizeFingerprint,
  isValidFingerprint,
  HostKeyMismatchError,
  isHostKeyMismatchError,
} = require('../dist/services/host-key.js');

// Build an SSH wire-format public key blob: string(type) || string(key)
const sshString = buf => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
};
const ed25519Blob = rawPub => Buffer.concat([sshString(Buffer.from('ssh-ed25519')), sshString(rawPub)]);

test('computeFingerprint produces OpenSSH-style SHA256 fingerprints', () => {
  const blob = ed25519Blob(Buffer.alloc(32, 7));
  const fp = computeFingerprint(blob);
  const expected = 'SHA256:' + crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
  assert.equal(fp, expected);
  assert.match(fp, /^SHA256:[A-Za-z0-9+/]{43}$/);
  assert.ok(!fp.endsWith('='), 'no base64 padding, like ssh-keygen -lf');
  assert.equal(computeFingerprint(blob), fp, 'deterministic');
  assert.notEqual(computeFingerprint(ed25519Blob(Buffer.alloc(32, 8))), fp, 'different keys differ');
  assert.throws(() => computeFingerprint(Buffer.alloc(0)));
  assert.throws(() => computeFingerprint('not a buffer'));
});

test('decideHostKey implements trust-on-first-use', () => {
  const a = computeFingerprint(ed25519Blob(Buffer.alloc(32, 1)));
  const b = computeFingerprint(ed25519Blob(Buffer.alloc(32, 2)));
  assert.equal(decideHostKey(null, a), 'trust-new');
  assert.equal(decideHostKey(undefined, a), 'trust-new');
  assert.equal(decideHostKey('', a), 'trust-new');
  assert.equal(decideHostKey('   ', a), 'trust-new');
  assert.equal(decideHostKey(a, a), 'match');
  assert.equal(decideHostKey(`  ${a}=\n`, a), 'match', 'tolerates whitespace / padding in stored value');
  assert.equal(decideHostKey(a, b), 'mismatch');
  assert.equal(decideHostKey(a, ''), 'mismatch', 'never accept a stored key without a received fingerprint');
});

test('normalizeFingerprint / isValidFingerprint', () => {
  const fp = computeFingerprint(ed25519Blob(Buffer.alloc(32, 3)));
  assert.equal(normalizeFingerprint(fp.slice('SHA256:'.length)), fp);
  assert.equal(normalizeFingerprint(`${fp}=`), fp);
  assert.equal(normalizeFingerprint(null), null);
  assert.equal(isValidFingerprint(fp), true);
  assert.equal(isValidFingerprint('SHA256:short'), false);
  assert.equal(isValidFingerprint('MD5:aa:bb'), false);
  assert.equal(isValidFingerprint(undefined), false);
});

test('HostKeyMismatchError carries expected and received fingerprints', () => {
  const err = new HostKeyMismatchError({
    connectionId: 5,
    connectionName: 'prod',
    host: 'example.com',
    port: 22,
    expectedFingerprint: 'SHA256:old',
    receivedFingerprint: 'SHA256:new',
  });
  assert.ok(err instanceof Error);
  assert.equal(err.code, 'HOST_KEY_MISMATCH');
  assert.equal(err.info.expectedFingerprint, 'SHA256:old');
  assert.equal(err.info.receivedFingerprint, 'SHA256:new');
  assert.ok(isHostKeyMismatchError(err));
  assert.ok(!isHostKeyMismatchError(new Error('x')));
  assert.match(err.message, /SHA256:old/);
  assert.match(err.message, /SHA256:new/);
});

// End-to-end with a real ssh2 server: the raw key ssh2 hands to hostVerifier
// fingerprints to the same value as the server's public key, and an async
// verifier that rejects aborts the handshake.
const startServer = async hostKeyPem => {
  const server = new Server({ hostKeys: [hostKeyPem] }, client => {
    client.on('authentication', ctx => ctx.accept());
    client.on('ready', () => {});
    client.on('error', () => {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
};

const connectWithVerifier = (port, decide) => new Promise(resolve => {
  const client = new Client();
  let seen = null;
  client.on('ready', () => { client.end(); resolve({ ok: true, seen }); });
  client.on('error', err => resolve({ ok: false, seen, err }));
  client.connect({
    host: '127.0.0.1',
    port,
    username: 'test',
    password: 'test',
    readyTimeout: 10000,
    hostVerifier: (key, verify) => {
      seen = computeFingerprint(key);
      // async decision, like the DB-backed verifier in ssh.service.ts
      setImmediate(() => verify(decide(seen)));
    },
  });
});

test('ssh2 hostVerifier integration: accept on match, reject on mismatch', async t => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const parsed = utils.parseKey(privateKey);
  assert.ok(!(parsed instanceof Error), String(parsed));
  const expectedFp = computeFingerprint(parsed.getPublicSSH());

  const server = await startServer(privateKey);
  t.after(() => server.close());
  const { port } = server.address();

  const first = await connectWithVerifier(port, fp => decideHostKey(null, fp) !== 'mismatch');
  assert.equal(first.seen, expectedFp);
  assert.equal(first.ok, true, first.err && first.err.message);

  const second = await connectWithVerifier(port, fp => decideHostKey(expectedFp, fp) !== 'mismatch');
  assert.equal(second.ok, true, second.err && second.err.message);

  const wrongStored = computeFingerprint(ed25519Blob(Buffer.alloc(32, 9)));
  const third = await connectWithVerifier(port, fp => decideHostKey(wrongStored, fp) !== 'mismatch');
  assert.equal(third.ok, false, 'connection must be rejected on mismatch');
  assert.match(third.err.message, /verification failed/i);
});
