// @simplewebauthn/server 14: option shapes, the ML-DSA (PQC) default algorithm list, string[] transports,
// and a full software-authenticator registration + authentication round trip through PasskeyService.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-passkey-'));
process.env.APP_BACKEND_DATA_PATH = dataDir;
process.env.RP_ID = 'localhost';
process.env.RP_ORIGIN = 'http://localhost:5173';

const { isoCBOR, isoBase64URL } = require('@simplewebauthn/server/helpers');
const { PasskeyService } = require('../dist/passkey/passkey.service.js');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:5173';
const b64u = buf => Buffer.from(buf).toString('base64url');
const sha256 = data => crypto.createHash('sha256').update(data).digest();

const makeService = () => {
  const store = new Map();
  const user = { id: 1, username: 'admin' };
  const passkeyRepo = {
    getPasskeysByUserId: async userId => [...store.values()].filter(p => p.user_id === userId),
    getPasskeyByCredentialId: async id => store.get(id) || null,
    updatePasskeyCounter: async (id, counter) => { store.get(id).counter = counter; },
    updatePasskeyLastUsedAt: async id => { store.get(id).last_used_at = Date.now(); },
  };
  const userRepo = {
    findUserById: async id => (id === user.id ? user : null),
    findUserByUsername: async name => (name === user.username ? user : null),
  };
  return { service: new PasskeyService(passkeyRepo, userRepo), store };
};

// Minimal "none"-attestation ES256 software authenticator.
const createAuthenticator = () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credentialId = crypto.randomBytes(32);
  const cosePublicKey = isoCBOR.encode(new Map([
    [1, 2], // kty: EC2
    [3, -7], // alg: ES256
    [-1, 1], // crv: P-256
    [-2, Buffer.from(jwk.x, 'base64url')],
    [-3, Buffer.from(jwk.y, 'base64url')],
  ]));
  return {
    id: b64u(credentialId),
    register(options) {
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: ORIGIN, crossOrigin: false }));
      const counter = Buffer.alloc(4);
      const credIdLen = Buffer.alloc(2);
      credIdLen.writeUInt16BE(credentialId.length);
      const authData = Buffer.concat([sha256(RP_ID), Buffer.from([0x45]), counter, Buffer.alloc(16), credIdLen, credentialId, Buffer.from(cosePublicKey)]);
      const attestationObject = isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
      return {
        id: b64u(credentialId),
        rawId: b64u(credentialId),
        type: 'public-key',
        clientExtensionResults: {},
        response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ['internal', 'hybrid'] },
      };
    },
    authenticate(options, signCount) {
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: ORIGIN, crossOrigin: false }));
      const counter = Buffer.alloc(4);
      counter.writeUInt32BE(signCount);
      const authenticatorData = Buffer.concat([sha256(RP_ID), Buffer.from([0x05]), counter]);
      const signature = crypto.sign('sha256', Buffer.concat([authenticatorData, sha256(clientDataJSON)]), privateKey);
      return {
        id: b64u(credentialId),
        rawId: b64u(credentialId),
        type: 'public-key',
        clientExtensionResults: {},
        response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authenticatorData), signature: b64u(signature), userHandle: b64u(Buffer.from('1')) },
      };
    },
  };
};

test('registration options keep the v13 shape and only offer ES256/RS256', async () => {
  const { service, store } = makeService();
  store.set('existing-cred', { user_id: 1, credential_id: 'existing-cred', transports: JSON.stringify(['usb']) });
  const options = await service.generateRegistrationOptions('admin', 1);

  assert.equal(typeof options.challenge, 'string');
  assert.ok(isoBase64URL.isBase64URL(options.challenge));
  assert.deepEqual(options.rp, { name: 'Nexus Terminal', id: RP_ID });
  assert.deepEqual(options.user, { id: isoBase64URL.fromUTF8String('1'), name: 'admin', displayName: 'admin' });
  // Explicit supportedAlgorithmIDs: v14's ML-DSA-44 default preference must not leak in.
  assert.deepEqual(options.pubKeyCredParams, [{ alg: -7, type: 'public-key' }, { alg: -257, type: 'public-key' }]);
  assert.equal(options.timeout, 60000);
  assert.equal(options.attestation, 'none');
  assert.deepEqual(options.excludeCredentials, [{ id: 'existing-cred', type: 'public-key', transports: ['usb'] }]);
  assert.equal(options.authenticatorSelection.residentKey, 'preferred');
  assert.equal(options.authenticatorSelection.userVerification, 'preferred');
});

test('authentication options: real credentials for a known user, stable decoy for unknown users', async () => {
  const { service, store } = makeService();
  store.set('cred-a', { user_id: 1, credential_id: 'cred-a', transports: JSON.stringify(['internal']) });
  const known = await service.generateAuthenticationOptions('admin');
  assert.equal(known.rpId, RP_ID);
  assert.equal(known.userVerification, 'preferred');
  assert.deepEqual(known.allowCredentials, [{ id: 'cred-a', type: 'public-key', transports: ['internal'] }]);

  const unknown1 = await service.generateAuthenticationOptions('nobody');
  const unknown2 = await service.generateAuthenticationOptions('nobody');
  assert.equal(unknown1.allowCredentials.length, 1);
  assert.deepEqual(unknown1.allowCredentials, unknown2.allowCredentials);
  assert.deepEqual(unknown1.allowCredentials[0].transports, ['internal', 'hybrid']);

  const usernameless = await service.generateAuthenticationOptions();
  assert.equal(usernameless.allowCredentials, undefined);
});

test('software authenticator can register and then authenticate (counter is updated)', async () => {
  const { service, store } = makeService();
  const authenticator = createAuthenticator();

  const regOptions = await service.generateRegistrationOptions('admin', 1);
  const registration = authenticator.register(regOptions);
  const reg = await service.verifyRegistration({ registrationResponse: registration }, regOptions.challenge, '1');
  assert.equal(reg.verified, true);
  assert.ok(reg.newPasskeyToSave);
  assert.equal(reg.newPasskeyToSave.credential_id, authenticator.id);
  assert.equal(reg.newPasskeyToSave.user_id, 1);
  assert.deepEqual(JSON.parse(reg.newPasskeyToSave.transports), ['internal', 'hybrid']);
  store.set(authenticator.id, { ...reg.newPasskeyToSave, backed_up: 0 });

  const authOptions = await service.generateAuthenticationOptions('admin');
  assert.deepEqual(authOptions.allowCredentials.map(c => c.id), [authenticator.id]);
  const auth = await service.verifyAuthentication(authenticator.authenticate(authOptions, 1), authOptions.challenge);
  assert.equal(auth.verified, true);
  assert.equal(auth.userId, 1);
  assert.equal(store.get(authenticator.id).counter, 1);

  // A wrong challenge must be rejected.
  const otherOptions = await service.generateAuthenticationOptions('admin');
  await assert.rejects(service.verifyAuthentication(authenticator.authenticate(otherOptions, 2), authOptions.challenge));
});
