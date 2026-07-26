// At-rest encryption for secrets the BROKER has to hold (PLAN N3/N4): the
// Telegram bot token, the Discord bot token.
//
// WHY THE BROKER HOLDS THEM AT ALL. Telegram allows exactly one `getUpdates`
// consumer per token, so the gateway must be a singleton — that is the broker,
// not the N Decks. And the operator enrols from the app: asking them to SSH
// into the broker host to drop a token in a config file is not an experience
// we are willing to ship. So the token travels once, over an operator-signed
// route, and lands here encrypted.
//
// THREAT MODEL, STATED PLAINLY. The key lives in a chmod-600 file beside the
// database. This protects a leaked/copied DB file — a backup, a stray scp, a
// snapshot — which is the realistic accident. It does NOT protect against an
// attacker who already reads arbitrary files as the broker user: they get the
// key too. That is inherent to a headless daemon with no OS keychain, and it
// is why the operator documentation says to revoke the bot token (BotFather
// `/revoke`, Discord "Reset Token") if the broker host is ever compromised.
//
// AES-256-GCM: authenticated, so a tampered ciphertext fails loudly instead of
// decrypting to garbage that would then be sent to a bot API.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const ALGO = "aes-256-gcm";
const PREFIX = "v1:";

/** Load the key file, creating it on first use. Returns a 32-byte key. */
export function loadOrCreateSecretKey(path: string): Buffer {
  if (existsSync(path)) {
    const raw = readFileSync(path, "utf-8").trim();
    const key = Buffer.from(raw, "base64");
    if (key.length === 32) return key;
    throw new Error(`secret key at ${path} is malformed (expected 32 bytes base64)`);
  }
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const key = randomBytes(32);
  writeFileSync(path, key.toString("base64"), { mode: 0o600 });
  try {
    // writeFileSync's mode is a no-op when the file pre-exists with other
    // permissions; make the intent explicit either way.
    chmodSync(path, 0o600);
  } catch {
    // Windows has no POSIX mode; the ACL of the data dir governs there.
  }
  return key;
}

/** `v1:<iv>.<tag>.<ciphertext>`, all base64. */
export function sealSecret(key: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}.${tag.toString("base64")}.${enc.toString("base64")}`;
}

/**
 * Reverse of sealSecret. Returns null on ANY problem (wrong key, tampering,
 * malformed payload) rather than throwing: the caller's job is to treat the
 * channel as unconfigured and tell the operator to reconnect it.
 */
export function openSecret(key: Buffer, sealed: string): string | null {
  if (!sealed.startsWith(PREFIX)) return null;
  const parts = sealed.slice(PREFIX.length).split(".");
  if (parts.length !== 3) return null;
  try {
    const [ivB64, tagB64, dataB64] = parts as [string, string, string];
    const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const out = Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final(),
    ]);
    return out.toString("utf-8");
  } catch {
    return null;
  }
}

/** Last 4 characters, for showing "which token is configured" without leaking it. */
export function secretHint(plain: string): string {
  const t = plain.trim();
  return t.length <= 4 ? "****" : `****${t.slice(-4)}`;
}
