import { randomBytes } from 'crypto';
import { SecretBox } from './secret-box';

describe('SecretBox', () => {
  const box = new SecretBox(randomBytes(32).toString('base64'));
  const secret = { headers: { Authorization: 'token abc' } };

  it('round-trips a value, and never stores it in the clear', () => {
    const sealed = box.seal(secret, 'connection:github');

    expect(box.open(sealed, 'connection:github')).toEqual(secret);
    expect(JSON.stringify(sealed)).not.toContain('abc');
  });

  it('uses a fresh nonce each time', () => {
    expect(box.seal(secret, 'c').iv).not.toBe(box.seal(secret, 'c').iv);
  });

  it('refuses a value moved to another record', () => {
    const sealed = box.seal(secret, 'connection:github');
    expect(() => box.open(sealed, 'connection:slack')).toThrow('failed authentication');
  });

  it('refuses a tampered value', () => {
    const sealed = box.seal(secret, 'c');
    const data = Buffer.from(sealed.data, 'base64');
    data[0] ^= 1;
    expect(() => box.open({ ...sealed, data: data.toString('base64') }, 'c')).toThrow('failed authentication');
  });

  it('names the key mismatch when opened with another key', () => {
    const other = new SecretBox(randomBytes(32).toString('base64'));
    expect(() => other.open(box.seal(secret, 'c'), 'c')).toThrow(`encrypted with key ${box.keyId}`);
  });

  it('rejects a key that is not 32 bytes', () => {
    expect(() => new SecretBox('short')).toThrow('must be 32 random bytes');
  });
});
