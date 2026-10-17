# Update manifest signing (Ed25519)

The in-app updater downloads the installer / portable ZIP / DMG / AppImage from
the GitHub release and compares its SHA-256 with `SHA256SUMS.txt` from the same
release. On its own that only detects corruption: anyone who can modify the
release can also modify `SHA256SUMS.txt`.

To make updates **authentic**, the release workflow signs `SHA256SUMS.txt` with
an Ed25519 private key that only the maintainer holds, and the app verifies the
detached signature `SHA256SUMS.txt.sig` against a public key compiled into the
app (`electron-app/update-public-key.js`).

| `UPDATE_PUBLIC_KEY_PEM` | Behaviour |
| --- | --- |
| empty (default) | Checksum-only verification, as before. A warning is logged. |
| set | `SHA256SUMS.txt.sig` must exist and be a valid signature, otherwise the update is refused (Windows, macOS and Linux alike). |

## 1. Generate a key pair (once)

```sh
openssl genpkey -algorithm ed25519 -out update-signing-key.pem
openssl pkey -in update-signing-key.pem -pubout -out update-public-key.pem
cat update-public-key.pem
```

Keep `update-signing-key.pem` **offline / in a password manager**. Never commit
it. If it leaks, generate a new pair and ship a release with the new public key
(apps that embed the old key will refuse releases signed with the new one, so
rotate deliberately).

## 2. Add the private key as a GitHub Actions secret

Repository → Settings → Secrets and variables → Actions → *New repository
secret*:

- Name: `UPDATE_SIGNING_KEY`
- Value: the full contents of `update-signing-key.pem`, including the
  `-----BEGIN PRIVATE KEY-----` / `-----END PRIVATE KEY-----` lines.

With the GitHub CLI: `gh secret set UPDATE_SIGNING_KEY < update-signing-key.pem`

The `release` job of `.github/workflows/build-electron.yml` runs
`electron-app/scripts/sign-update-manifest.js` when the secret is present and
uploads `SHA256SUMS.txt.sig` next to `SHA256SUMS.txt`. Without the secret the
step is skipped with a warning.

## 3. Embed the public key in the app

Paste the public key into `electron-app/update-public-key.js`:

```js
const UPDATE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA...
-----END PUBLIC KEY-----`;
```

**Order matters:** add the secret first and make sure releases contain
`SHA256SUMS.txt.sig`, *then* ship the app version that embeds the public key.
An app with the key configured refuses every release without a valid signature,
so from then on every release must be signed. Once the public key is embedded,
the signing script also checks that the secret matches it and fails the release
otherwise.

## Signing manually

```sh
UPDATE_SIGNING_KEY="$(cat update-signing-key.pem)" \
  node electron-app/scripts/sign-update-manifest.js SHA256SUMS.txt
# -> SHA256SUMS.txt.sig (base64 of the raw 64-byte Ed25519 signature)
```

Equivalent with OpenSSL 3:

```sh
openssl pkeyutl -sign -inkey update-signing-key.pem -rawin -in SHA256SUMS.txt | base64 -w0 > SHA256SUMS.txt.sig
```

Verify:

```sh
base64 -d SHA256SUMS.txt.sig > /tmp/sig.bin
openssl pkeyutl -verify -pubin -inkey update-public-key.pem -rawin -in SHA256SUMS.txt -sigfile /tmp/sig.bin
```

## Notes

- The signature covers the exact bytes of `SHA256SUMS.txt`; do not edit the
  manifest after signing.
- The app always fetches `SHA256SUMS.txt` and `SHA256SUMS.txt.sig` from the
  official GitHub release (mirrors are only used for the large installer, whose
  SHA-256 comes from the signed manifest).
- The release workflow currently builds Windows and macOS only. If Linux
  AppImages are added, include them in `SHA256SUMS.txt` before the signing step;
  the app requires the signed checksum for AppImages too once the key is
  configured.
