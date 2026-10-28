const test = require('node:test');
const assert = require('node:assert');
const { withLegacyCompatAlgorithms, getLegacyCompatAlgorithms, detectLegacyCryptoSupport, SSH_LEGACY_COMPAT_ALGORITHMS, isNonRetryableSshError } = require('../dist/utils/ssh-algorithms.js');
const { Client } = require('ssh2');

test('legacy compat algorithms are appended (modern defaults keep priority)', () => {
    const cfg = withLegacyCompatAlgorithms({ host: 'h' });
    const support = detectLegacyCryptoSupport();
    assert.deepStrictEqual(cfg.algorithms.kex, getLegacyCompatAlgorithms(support).kex);
    assert.strictEqual(cfg.algorithms.serverHostKey.append.includes('ssh-dss'), support.dsa);
    assert.ok(cfg.algorithms.serverHostKey.append.includes('ssh-ed25519-cert-v01@openssh.com'));
    for (const list of Object.values(cfg.algorithms)) assert.ok(list.append && !list.prepend);
    const custom = { algorithms: { cipher: ['aes128-ctr'] } };
    assert.strictEqual(withLegacyCompatAlgorithms(custom), custom);
});

test('ssh2 accepts every compat algorithm name', () => {
    const c = new Client();
    c.on('error', () => {});
    // ssh2 throws synchronously on unsupported algorithm names
    assert.doesNotThrow(() => c.connect({ host: '127.0.0.1', port: 1, username: 'u', algorithms: SSH_LEGACY_COMPAT_ALGORITHMS }));
    c.end();
});

test('algorithms the crypto library lacks are dropped (Electron/BoringSSL: no DSA, no modp2)', () => {
    const none = getLegacyCompatAlgorithms({ dsa: false, dhGroup1: false });
    assert.ok(!none.serverHostKey.append.includes('ssh-dss'));
    assert.ok(!none.kex.append.includes('diffie-hellman-group1-sha1'));
    assert.ok(none.kex.append.includes('diffie-hellman-group14-sha1'));
    assert.ok(none.serverHostKey.append.includes('ssh-ed25519-cert-v01@openssh.com'));
    assert.deepStrictEqual(none.cipher, SSH_LEGACY_COMPAT_ALGORITHMS.cipher);
    const all = getLegacyCompatAlgorithms({ dsa: true, dhGroup1: true });
    assert.ok(all.serverHostKey.append.includes('ssh-dss'));
    assert.ok(all.kex.append.includes('diffie-hellman-group1-sha1'));
});

test('crypto support probe matches the runtime', () => {
    const support = detectLegacyCryptoSupport();
    const boring = process.versions.openssl === '0.0.0' || Boolean(process.versions.electron);
    assert.strictEqual(support.dsa, !boring);
    assert.strictEqual(support.dhGroup1, !boring);
});

test('non-retryable ssh errors are recognised', () => {
    assert.ok(isNonRetryableSshError('Handshake failed: no matching host key format'));
    assert.ok(isNonRetryableSshError('All configured authentication methods failed'));
    assert.ok(!isNonRetryableSshError('Timed out while waiting for handshake'));
    assert.ok(!isNonRetryableSshError('connect ECONNREFUSED 1.2.3.4:22'));
});
