'use strict';

// Ed25519 public key (SPKI PEM) used to verify the signature of the release
// SHA-256 manifest (SHA256SUMS.txt.sig). See UPDATE_SIGNING.md.
//
// While this is an empty string, updates keep working with checksum-only
// verification (integrity against corruption, NOT against a tampered release)
// and a warning is logged. Once a key is configured here, every update
// requires a valid signature and is refused otherwise.
const UPDATE_PUBLIC_KEY_PEM = '';

module.exports = { UPDATE_PUBLIC_KEY_PEM };
