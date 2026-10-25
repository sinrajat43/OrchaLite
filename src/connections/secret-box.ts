import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

/** What is stored for an encrypted value */
export interface Sealed {
  /** Identifies the key, so a wrong key gives a clear error instead of garbage */
  keyId: string;
  iv: string;
  tag: string;
  data: string;
}

export const SECRET_KEY_ENV = 'ORCHALITE_SECRET_KEY';

/**
 * Authenticated encryption (AES-256-GCM) for secrets at rest. Each value is
 * bound to a context string such as "connection:github": a ciphertext copied
 * onto another record fails to open, as does any tampering.
 */
export class SecretBox {
  private readonly key: Buffer;
  readonly keyId: string;

  constructor(secret: string) {
    this.key = Buffer.from(secret, 'base64');
    if (this.key.length !== 32) {
      throw new Error(`${SECRET_KEY_ENV} must be 32 random bytes, base64 encoded (openssl rand -base64 32)`);
    }
    this.keyId = createHash('sha256').update(this.key).digest('hex').slice(0, 8);
  }

  /** Returns undefined when the key is not configured */
  static fromEnv(): SecretBox | undefined {
    const secret = process.env[SECRET_KEY_ENV];
    return secret ? new SecretBox(secret.trim()) : undefined;
  }

  seal(value: unknown, context: string): Sealed {
    // A fresh 96-bit nonce per value; reusing one with the same key breaks GCM
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return { keyId: this.keyId, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  }

  open<T = unknown>(sealed: Sealed, context: string): T {
    if (sealed.keyId !== this.keyId) {
      throw new Error(`Secret was encrypted with key ${sealed.keyId}, but ${SECRET_KEY_ENV} is key ${this.keyId}`);
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(sealed.iv, 'base64'));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    try {
      const plain = Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]);
      return JSON.parse(plain.toString('utf8'));
    } catch {
      throw new Error('Secret failed authentication: it was altered or belongs to another record');
    }
  }
}
