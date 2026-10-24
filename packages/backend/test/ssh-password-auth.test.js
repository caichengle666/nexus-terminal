const test = require('node:test');
const assert = require('node:assert');
const { createPasswordAuthHandler } = require('../dist/services/ssh.service.js');
const { Client, Server, utils } = require('ssh2');
const { withLegacyCompatAlgorithms } = require('../dist/utils/ssh-algorithms.js');

const key = utils.generateKeyPairSync('ed25519').private;
const startServer = (methods, check) => new Promise((resolve) => {
    const attempts = [];
    const srv = new Server({ hostKeys: [key] }, (c) => {
        c.on('authentication', (ctx) => {
            attempts.push(ctx.method);
            if (ctx.method === 'password' && methods.includes('password')) return check(ctx.password) ? ctx.accept() : ctx.reject(methods);
            if (ctx.method === 'keyboard-interactive' && methods.includes('keyboard-interactive')) {
                return ctx.prompt([{ prompt: 'Password: ', echo: false }], (a) => (check(a[0]) ? ctx.accept() : ctx.reject(methods)));
            }
            ctx.reject(methods);
        }).on('ready', () => {}).on('error', () => {});
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, attempts }));
});
const connect = (port, password) => new Promise((resolve) => {
    const c = new Client();
    c.on('ready', () => { c.end(); resolve(true); }).on('error', () => resolve(false))
        .connect(withLegacyCompatAlgorithms({ host: '127.0.0.1', port, username: 'u', authHandler: createPasswordAuthHandler('u', password) }));
});

for (const [name, methods] of [['password', ['password']], ['keyboard-interactive', ['keyboard-interactive']], ['both', ['password', 'keyboard-interactive']]]) {
    test(`empty password works via ${name}`, async () => {
        const { srv, attempts } = await startServer(methods, (p) => p === '');
        try { assert.strictEqual(await connect(srv.address().port, ''), true); } finally { srv.close(); }
        assert.strictEqual(attempts.filter((m) => m !== 'none').length, 1);
    });
}

test('wrong password is tried only once when server offers password and keyboard-interactive', async () => {
    const { srv, attempts } = await startServer(['password', 'keyboard-interactive'], (p) => p === 'right');
    try { assert.strictEqual(await connect(srv.address().port, 'wrong'), false); } finally { srv.close(); }
    assert.deepStrictEqual(attempts.filter((m) => m !== 'none'), ['password']);
});
