let didWarnWeakClientIdEntropy = false;

function toBase64Url(data: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(data)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }
  let bin = "";
  for (const b of data) bin += String.fromCharCode(b);
  // eslint-disable-next-line no-restricted-globals
  const b64 = btoa(bin);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * Generate a stable clientId for PatchId creation.
 * Uses 96 bits of randomness encoded as base64url (no padding).
 * Falls back to weak randomness when WebCrypto/crypto are unavailable, with a warning.
 */
export function makeClientId(): string {
  const bytes = new Uint8Array(12); // 96-bit
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    // Fallback for environments where WebCrypto is unavailable (e.g., non-secure http origins).
    // This is weaker than CSPRNG. It is still fine for practical collision avoidance in dev,
    // but should not be considered cryptographically strong.
    if (!didWarnWeakClientIdEntropy) {
      didWarnWeakClientIdEntropy = true;
      // eslint-disable-next-line no-console
      console.warn(
        "patchflow: globalThis.crypto.getRandomValues unavailable; using weak randomness for clientId (dev/edge-case only)",
      );
    }
    const seed =
      Date.now() ^
      (typeof performance !== "undefined" ? Math.floor(performance.now() * 1000) : 0);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = ((Math.random() * 256) ^ (seed >>> (i % 24))) & 0xff;
    }
  }
  return toBase64Url(bytes);
}

