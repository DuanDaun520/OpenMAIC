/**
 * Admin-domain cryptography, all on Node's built-in `crypto` — no new deps.
 *
 * - Passwords: scrypt with a per-user random salt, stored as a self-describing
 *   `scrypt$N$r$p$salt$hash` string so parameters can be raised later without
 *   a migration.
 * - Provider API keys at rest: AES-256-GCM. The key is derived (scrypt) from
 *   `OPENMAIC_ADMIN_SECRET`, which is deployment-owned and never stored in the
 *   database — a leaked dump does not leak usable provider keys. When the env
 *   is unset the cipher falls back to a `plain:` marker so local development
 *   still works, loudly documented.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'crypto';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;

export function hashAdminPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyAdminPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  // scrypt $ N $ r $ p $ salt-hex $ hash-hex
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltHex, hashHex] = parts;
  try {
    const expected = Buffer.from(hashHex, 'hex');
    const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function deriveAesKey(): Buffer {
  const secret = process.env.OPENMAIC_ADMIN_SECRET?.trim();
  if (!secret) {
    throw new AdminSecretUnavailableError();
  }
  // Fixed salt is deliberate: the derived key must be stable across processes
  // and restarts so rows written yesterday still decrypt tomorrow.
  return scryptSync(secret, 'openmaic-admin-provider-keys', KEY_LENGTH);
}

/** Thrown when a cipher operation needs OPENMAIC_ADMIN_SECRET and it is unset. */
export class AdminSecretUnavailableError extends Error {
  constructor() {
    super('OPENMAIC_ADMIN_SECRET is not configured — provider API keys cannot be encrypted');
    this.name = 'AdminSecretUnavailableError';
  }
}

const AES_PREFIX = 'v1:';

/**
 * Encrypt a provider API key for the `provider_configs.api_key_cipher` column.
 * Output shape: `v1:<iv-hex>:<auth-tag-hex>:<ciphertext-hex>`.
 */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveAesKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${AES_PREFIX}${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt an `api_key_cipher` value. `plain:<key>` markers (written when
 * OPENMAIC_ADMIN_SECRET was unset) decrypt to the key itself.
 */
export function decryptSecret(cipherText: string | null | undefined): string {
  if (!cipherText) return '';
  if (cipherText.startsWith('plain:')) return cipherText.slice('plain:'.length);
  if (!cipherText.startsWith(AES_PREFIX)) return '';
  const [ivHex, tagHex, payloadHex] = cipherText.slice(AES_PREFIX.length).split(':');
  if (!ivHex || !tagHex || !payloadHex) return '';
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveAesKey(), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([
      decipher.update(Buffer.from(payloadHex, 'hex')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // Wrong OPENMAIC_ADMIN_SECRET (e.g. rotated or missing) — treat as
    // unreadable rather than crashing every provider resolution.
    return '';
  }
}

/**
 * Store a secret without encryption (local-dev path). The marker makes the
 * choice visible in the column and in {@link decryptSecret}.
 */
export function markPlainSecret(plaintext: string): string {
  return `plain:${plaintext}`;
}

export function isAdminSecretConfigured(): boolean {
  return !!process.env.OPENMAIC_ADMIN_SECRET?.trim();
}

/** Display tail for a stored cipher: never the key, at most its last 4 chars. */
export function maskSecretTail(cipherText: string | null | undefined): string | null {
  const plain = decryptSecret(cipherText);
  if (!plain) return null;
  return `••••${plain.slice(-4)}`;
}
