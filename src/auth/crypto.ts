// Small crypto helpers: secret-at-rest encryption, signing, random tokens and hashing.
// Every key is derived from the single MCP_SECRET so operators only manage one value.

import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

export interface SecretBox {
  seal(plaintext: string): string;
  open(sealed: string): string;
}

export interface Signer {
  sign(payload: string): string;
  verify(payload: string, signature: string): boolean;
}

/** Decodes MCP_SECRET (32 bytes, base64 or base64url). Throws with a helpful message otherwise. */
export function parseMasterSecret(value: string | undefined): Buffer {
  const secret = Buffer.from(value ?? "", "base64");
  if (secret.length !== 32) {
    throw new Error("MCP_SECRET must be 32 random bytes, base64-encoded. Generate one with: openssl rand -base64 32");
  }
  return secret;
}

export function deriveKey(master: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), `mess-mcp-iiith/${purpose}`, 32));
}

/** AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext>, base64url parts. */
export class AesGcmBox implements SecretBox {
  constructor(private readonly key: Buffer) {}

  seal(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return ["v1", iv, cipher.getAuthTag(), ciphertext].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
  }

  open(sealed: string): string {
    const [version, iv, tag, ciphertext] = sealed.split(".");
    if (version !== "v1" || !iv || !tag || ciphertext === undefined) throw new Error("Unrecognised sealed value");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
  }
}

export class HmacSigner implements Signer {
  constructor(private readonly key: Buffer) {}

  sign(payload: string): string {
    return createHmac("sha256", this.key).update(payload).digest("base64url");
  }

  verify(payload: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(payload));
    const given = Buffer.from(signature);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }
}

export function randomToken(prefix = ""): string {
  return prefix + randomBytes(32).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** PKCE S256: BASE64URL(SHA256(verifier)) compared in constant time. */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  const computed = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}
