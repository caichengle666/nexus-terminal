const test = require('node:test');
const assert = require('node:assert');
const { withLegacyCompatAlgorithms, SSH_LEGACY_COMPAT_ALGORITHMS, isNonRetryableSshError } = require('../dist/utils/ssh-algorithms.js');
const { Client } = require('ssh2');

test('legacy compat algorithms are appended (modern defaults keep priority)', () => {
    const cfg = withLegacyCompatAlgorithms({ host: 'h' });
    assert.deepStrictEqual(cfg.algorithms, SSH_LEGACY_COMPAT_ALGORITHMS);
    assert.deepStrictEqual(cfg.algorithms.serverHostKey, { append: ['ssh-dss'] });
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

test('non-retryable ssh errors are recognised', () => {
    assert.ok(isNonRetryableSshError('Handshake failed: no matching host key format'));
    assert.ok(isNonRetryableSshError('All configured authentication methods failed'));
    assert.ok(!isNonRetryableSshError('Timed out while waiting for handshake'));
    assert.ok(!isNonRetryableSshError('connect ECONNREFUSED 1.2.3.4:22'));
});
