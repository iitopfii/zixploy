/**
 * Webhook signature verification (HMAC-SHA256) — ใช้ WebCrypto ไม่มี external dependency
 *
 * security requirements (docs/threat-model.md section 2):
 * 1. อ่าน raw body ก่อน parse JSON เสมอ — ไม่อนุญาตให้ middleware ใดแปลง body ก่อน
 * 2. HMAC-SHA256 กับ raw body
 * 3. เปรียบเทียบแบบ constant-time เพื่อกัน timing attack
 * 4. Delivery ID unique constraint — duplicate = ปฏิเสธ (idempotency)
 */

/**
 * ตรวจ GitHub webhook signature
 * @param rawBody raw request body เป็น string (ต้องอ่านก่อน parse)
 * @param signature X-Hub-Signature-256 header value (format: "sha256=<hex>")
 * @param secret webhook secret จาก config
 * @returns true ถ้า signature ถูกต้อง
 */
export async function verifyWebhookSignature(
  rawBody: string,
  signature: string | null,
  secret: string,
): Promise<boolean> {
  if (!signature) return false;

  // GitHub ส่ง "sha256=<hex>" เสมอ
  if (!signature.startsWith("sha256=")) return false;
  const hexSig = signature.slice(7);

  // 64 hex chars = 32 bytes = SHA-256 output
  if (hexSig.length !== 64) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const rawSig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));

  const expectedHex = Array.from(new Uint8Array(rawSig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // constant-time comparison — ห้ามใช้ === เพราะ short-circuit อาจ leak timing
  return constantTimeEqual(expectedHex, hexSig);
}

/**
 * เปรียบเทียบ string สองตัวแบบ constant-time
 * ถ้าความยาวต่างกัน return false ทันทีโดยไม่ leak ข้อมูล
 * (ความยาว signature คาดการณ์ได้อยู่แล้ว = 64 chars สำหรับ SHA-256 hex)
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Parse push event ref → branch name */
export function parsePushBranch(ref: string): string | null {
  // ref format: "refs/heads/<branch>"
  if (!ref.startsWith("refs/heads/")) return null;
  return ref.slice("refs/heads/".length);
}

export interface PushEventPayload {
  ref: string;
  after: string; // commit SHA หลัง push
  deleted: boolean; // true = branch ถูกลบ
  installation?: { id: number };
  repository: {
    id: number;
    full_name: string;
  };
  head_commit?: {
    message: string;
    author?: { name: string };
  } | null;
}

export interface InstallationEventPayload {
  action: "created" | "deleted" | "suspend" | "unsuspend" | "new_permissions_accepted";
  installation: {
    id: number;
    account: { login: string; type: string };
  };
}

export interface InstallationRepositoriesEventPayload {
  action: "added" | "removed";
  installation: { id: number };
  repositories_added?: Array<{ id: number; full_name: string }>;
  repositories_removed?: Array<{ id: number; full_name: string }>;
}
