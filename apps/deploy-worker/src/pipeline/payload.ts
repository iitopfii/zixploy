/**
 * deploy_jobs.payload shape — duplicated จาก apps/control-api/src/deploys/queue.ts โดยตั้งใจ
 * (ADR-0002: worker ไม่ import จาก control-api เลย — สื่อสารผ่าน SQLite เท่านั้น)
 * แก้ shape ที่นี่ต้องแก้ควบคู่กับต้นทางเสมอ
 */

export type DeployJobPayload =
  | {
      kind: "build";
      trigger: "push" | "manual" | "redeploy";
      commitSha: string;
      commitMessage: string | null;
      commitAuthor: string | null;
      installationId: number;
      repoFullName: string;
    }
  | { kind: "rollback"; targetDeploymentId: string; imageTag: string; imageDigest: string }
  | { kind: "restart" }
  | { kind: "stop" };

export function parseDeployPayload(raw: unknown): DeployJobPayload {
  if (!raw || typeof raw !== "object" || !("kind" in raw)) {
    throw new Error("deploy_jobs.payload ผิดรูปแบบ — ขาด field 'kind'");
  }
  const kind = (raw as Record<string, unknown>).kind;
  if (kind !== "build" && kind !== "rollback" && kind !== "restart" && kind !== "stop") {
    throw new Error(`deploy_jobs.payload.kind ไม่รู้จัก: ${String(kind)}`);
  }
  return raw as DeployJobPayload;
}
