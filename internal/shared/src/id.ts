/**
 * ULID generator — public IDs ของทุก entity (ADR-0005)
 * Crockford base32, 48-bit timestamp + 80-bit randomness, monotonic ภายใน process
 */

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let lastTime = 0;
let lastRandom: Uint8Array = new Uint8Array(10);

function encodeTime(time: number): string {
  let out = "";
  let t = time;
  for (let i = 0; i < 10; i++) {
    out = ENCODING[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  // 10 bytes = 80 bits -> 16 chars (5 bits/char)
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ENCODING[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ENCODING[(value << (5 - bits)) & 31];
  return out;
}

function incrementRandom(bytes: Uint8Array): void {
  for (let i = bytes.length - 1; i >= 0; i--) {
    const current = bytes[i] ?? 0;
    if (current < 0xff) {
      bytes[i] = current + 1;
      return;
    }
    bytes[i] = 0;
  }
  // overflow ภายใน millisecond เดียว — เป็นไปไม่ได้ในทางปฏิบัติ
  throw new Error("ULID randomness overflow");
}

export function ulid(now: number = Date.now()): string {
  if (now === lastTime) {
    incrementRandom(lastRandom);
  } else {
    lastTime = now;
    lastRandom = crypto.getRandomValues(new Uint8Array(10));
  }
  return encodeTime(now) + encodeRandom(lastRandom);
}

export function isUlid(value: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}
