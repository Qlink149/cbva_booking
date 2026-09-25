import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 64;
const VERSION = "scrypt";

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
}

/** Hash a password with a unique cryptographically-random salt. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("base64url");
  const digest = await derive(password, salt);
  return `${VERSION}$${salt}$${digest.toString("base64url")}`;
}

/** Compare a password against a stored scrypt hash without timing leaks. */
export async function verifyPassword(
  password: string,
  storedHash: string | null | undefined,
): Promise<boolean> {
  if (!storedHash) return false;
  const [version, salt, encodedDigest] = storedHash.split("$");
  if (version !== VERSION || !salt || !encodedDigest) return false;

  try {
    const expected = Buffer.from(encodedDigest, "base64url");
    const actual = await derive(password, salt);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
