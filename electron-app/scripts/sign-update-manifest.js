#!/usr/bin/env node
'use strict';

// Signs the release SHA-256 manifest with the maintainer's Ed25519 key.
//
//   UPDATE_SIGNING_KEY=<Ed25519 private key PEM> \
//     node electron-app/scripts/sign-update-manifest.js SHA256SUMS.txt [output.sig]
//
// Writes a base64-encoded raw 64-byte Ed25519 signature over the exact bytes
// of the manifest to `<manifest>.sig` (or the given output path), then
// verifies it with the derived public key. If UPDATE_PUBLIC_KEY_PEM is set in
// update-public-key.js, the signature is also checked against that key so a
// mismatched secret fails the release instead of shipping unusable updates.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const fail = message => {
  console.error(`[sign-update-manifest] ${message}`);
  process.exit(1);
};

const manifestPath = process.argv[2];
if (!manifestPath) fail('Usage: node sign-update-manifest.js <manifest> [output.sig]');
const outputPath = process.argv[3] || `${manifestPath}.sig`;

const rawKey = process.env.UPDATE_SIGNING_KEY;
if (!rawKey || !rawKey.trim()) fail('Environment variable UPDATE_SIGNING_KEY (Ed25519 private key PEM) is not set.');

let privateKey;
try {
  // Secrets pasted on one line may carry literal "\n" sequences; accept those too.
  const pem = rawKey.includes('\\n') && !rawKey.includes('\n') ? rawKey.replace(/\\n/g, '\n') : rawKey;
  privateKey = crypto.createPrivateKey(pem);
} catch (error) {
  fail(`UPDATE_SIGNING_KEY is not a valid private key: ${error.message}`);
}
if (privateKey.asymmetricKeyType !== 'ed25519') {
  fail(`UPDATE_SIGNING_KEY must be an Ed25519 key (got ${privateKey.asymmetricKeyType}).`);
}

let manifest;
try {
  manifest = fs.readFileSync(manifestPath);
} catch (error) {
  fail(`Cannot read manifest ${manifestPath}: ${error.message}`);
}
if (manifest.length === 0) fail('Manifest is empty, refusing to sign.');

const signature = crypto.sign(null, manifest, privateKey);
const publicKey = crypto.createPublicKey(privateKey);
if (!crypto.verify(null, manifest, publicKey, signature)) fail('Self-verification of the signature failed.');

let embeddedKey = '';
try {
  ({ UPDATE_PUBLIC_KEY_PEM: embeddedKey } = require(path.join(__dirname, '..', 'update-public-key.js')));
} catch { /* running outside the repo checkout */ }
if (embeddedKey && embeddedKey.trim()) {
  const embedded = crypto.createPublicKey(embeddedKey);
  if (!crypto.verify(null, manifest, embedded, signature)) {
    fail('UPDATE_SIGNING_KEY does not match UPDATE_PUBLIC_KEY_PEM in electron-app/update-public-key.js.');
  }
}

fs.writeFileSync(outputPath, `${signature.toString('base64')}\n`);
console.log(`[sign-update-manifest] Wrote ${outputPath}`);
console.log('[sign-update-manifest] Public key matching this signature:');
console.log(publicKey.export({ type: 'spki', format: 'pem' }).toString().trim());
