// Unlock tokens: 32 random bytes sent to the browser in an HttpOnly cookie.
// Only their SHA-256 is stored, so a copy of the database unlocks nothing.

export const newToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")

export const sha256 = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")

// An unlock unused for this long ends, so a browser left signed in on a shared
// computer does not keep a Profile or the Curator open for good.
export const UnlockIdleMs = 12 * 60 * 60 * 1000

// How often use of an unlock is written down, at most.
export const LastUsedResolutionMs = 5 * 60 * 1000
