const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const crypto = require('node:crypto');
const cert = require('../dist/utils/ssh2-host-cert.js');
const { withLegacyCompatAlgorithms } = require('../dist/utils/ssh-algorithms.js');
const { Client, Server, utils } = require('ssh2');

const str = (b) => { const buf = Buffer.isBuffer(b) ? b : Buffer.from(b); const l = Buffer.alloc(4); l.writeUInt32BE(buf.length); return Buffer.concat([l, buf]); };

test('ssh2 kex.js is patched for host certificates', () => {
    assert.strictEqual(cert.isSsh2HostCertPatched(), true);
    const kexPath = require.resolve('ssh2/lib/protocol/kex.js');
    assert.ok(cert.patchSsh2KexSource(fs.readFileSync(kexPath, 'utf8'), '/x.js'));
    assert.strictEqual(cert.patchSsh2KexSource('nothing here', '/x.js'), null);
});

test('plainHostKey extracts the embedded key from certificates', () => {
    const pk = crypto.randomBytes(32);
    const blob = Buffer.concat([str('ssh-ed25519-cert-v01@openssh.com'), str(crypto.randomBytes(32)), str(pk), Buffer.alloc(8), str('rest')]);
    assert.deepStrictEqual(cert.plainHostKey(blob), Buffer.concat([str('ssh-ed25519'), str(pk)]));
    const rsa = Buffer.concat([str('ssh-rsa-cert-v01@openssh.com'), str('n0'), str('E'), str('NNNN'), str('rest')]);
    assert.deepStrictEqual(cert.plainHostKey(rsa), Buffer.concat([str('ssh-rsa'), str('E'), str('NNNN')]));
    const plain = Buffer.concat([str('ssh-ed25519'), str(pk)]);
    assert.strictEqual(cert.plainHostKey(plain), plain);
    assert.throws(() => cert.plainHostKey(Buffer.concat([str('ssh-ed25519-cert-v01@openssh.com')])));
});

test('cert algorithm name mapping', () => {
    assert.strictEqual(cert.hostKeySigType('ssh-ed25519-cert-v01@openssh.com'), 'ssh-ed25519');
    assert.strictEqual(cert.hostKeySigType('rsa-sha2-512-cert-v01@openssh.com'), 'rsa-sha2-512');
    assert.strictEqual(cert.hostKeySigType('ssh-ed25519'), 'ssh-ed25519');
    assert.ok(cert.hostKeyTypeMatches('ssh-rsa-cert-v01@openssh.com', 'rsa-sha2-256-cert-v01@openssh.com'));
    assert.ok(cert.hostKeyTypeMatches('ecdsa-sha2-nistp256-cert-v01@openssh.com', 'ecdsa-sha2-nistp256-cert-v01@openssh.com'));
    assert.ok(!cert.hostKeyTypeMatches('ssh-ed25519', 'ssh-ed25519'));
});

test('plain host keys still work with cert algorithms advertised', async () => {
    const key = utils.generateKeyPairSync('ed25519').private;
    const srv = new Server({ hostKeys: [key] }, (c) => { c.on('authentication', (ctx) => ctx.accept()).on('ready', () => {}).on('error', () => {}); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
        await new Promise((resolve, reject) => {
            const c = new Client();
            c.on('ready', () => { c.end(); resolve(); }).on('error', reject)
                .connect(withLegacyCompatAlgorithms({ host: '127.0.0.1', port: srv.address().port, username: 'u', password: '' }));
        });
    } finally { srv.close(); }
});
