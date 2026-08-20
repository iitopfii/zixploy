/**
 * นำเข้า container ที่มีอยู่บนเครื่องแล้ว ให้กลายเป็น project ที่ Zixploy จัดการได้ (migration 0028)
 *
 * ทำไมต้องผ่าน worker: control-api แตะ Docker ไม่ได้ (ADR-0002) จึงบันทึกคำขอลง DB แล้วให้ worker
 * เป็นคนอ่าน `docker inspect` และสร้างข้อมูลให้
 *
 * สองจังหวะ:
 *   pending   → inspect container แล้วเก็บ **metadata อย่างเดียว** (image/port/mount/ชื่อ env)
 *               ให้ผู้ใช้ตรวจก่อนตัดสินใจ
 *   confirmed → inspect อีกครั้งเพื่ออ่าน "ค่า" ของ env แล้วสร้าง project + component + env จริง
 *
 * **ค่าของ env ไม่เคยถูกเขียนลง DB แบบ plaintext** — อ่านจาก container แล้วเข้ารหัสทันทีก่อนแตะ DB
 * (ระหว่างรอผู้ใช้กดยืนยัน ตารางมีแต่ชื่อ key)
 *
 * ไม่แตะ container เดิมเลยไม่ว่ากรณีใด — ของเดิมยังรันต่อจนกว่าผู้ใช้จะจัดการเอง
 */

import type { Database } from "bun:sqlite";
import { AppError, ENV_VAR_KEY_RE, ulid } from "@zixploy/shared";
import type { DockerCliClient } from "../docker/cli-client";
import type { ContainerInspect } from "../docker/types";
import { encryptEnvelope } from "../github/envelope";
import type { MasterKeys } from "../github/master-key";

export const IMPORT_POLL_MS = 3_000;

interface ImportRow {
  id: string;
  container_id: string;
  container_name: string;
  status: string;
  project_name: string | null;
}

export interface ImportPort {
  hostPort: number;
  containerPort: number;
}

export interface ImportMount {
  source: string;
  target: string;
  type: string;
  readOnly: boolean;
}

export interface InspectSummary {
  image: string;
  command: string | null;
  restartPolicy: string;
  envKeys: string[];
  ports: ImportPort[];
  mounts: ImportMount[];
}

/** แปลงผล inspect เป็นรูปแบบที่เก็บ/แสดงได้ — ไม่รวมค่า env (เก็บแค่ชื่อ key) */
export function summarizeInspect(info: ContainerInspect): InspectSummary {
  const envKeys = (info.Config?.Env ?? [])
    .map((e) => e.slice(0, e.indexOf("=")))
    // PATH และพวกที่ base image ตั้งเองไม่ใช่ config ของผู้ใช้ · key ผิดรูปแบบก็ใช้กับระบบเราไม่ได้
    .filter((k) => k && k !== "PATH" && ENV_VAR_KEY_RE.test(k));

  const ports: ImportPort[] = [];
  for (const [spec, bindings] of Object.entries(info.HostConfig?.PortBindings ?? {})) {
    const containerPort = Number.parseInt(spec.split("/")[0] ?? "", 10);
    const hostPort = Number.parseInt(bindings?.[0]?.HostPort ?? "", 10);
    if (Number.isInteger(containerPort) && Number.isInteger(hostPort)) {
      ports.push({ hostPort, containerPort });
    }
  }

  const mounts: ImportMount[] = (info.Mounts ?? [])
    .filter((m) => m.Destination)
    .map((m) => ({
      source: m.Name ?? m.Source ?? "",
      target: m.Destination ?? "",
      type: m.Type ?? "volume",
      readOnly: m.RW === false,
    }));

  return {
    image: info.Config?.Image ?? "",
    command: info.Config?.Cmd?.length ? info.Config.Cmd.join(" ") : null,
    restartPolicy: info.HostConfig?.RestartPolicy?.Name || "unless-stopped",
    envKeys,
    ports,
    mounts,
  };
}

/** จังหวะที่ 1: อ่าน config มาให้ผู้ใช้ตรวจ (ไม่มีค่า env) */
async function runInspect(db: Database, docker: DockerCliClient, row: ImportRow): Promise<void> {
  const info = await docker.inspectContainer(row.container_id);
  if (!info) throw new AppError("VALIDATION_ERROR", "ไม่พบ container นี้บนเครื่องแล้ว");

  const s = summarizeInspect(info);
  if (!s.image) throw new AppError("VALIDATION_ERROR", "อ่าน image ของ container ไม่ได้");

  db.query(
    `UPDATE container_imports
        SET status = 'inspected', image = ?, command = ?, restart_policy = ?,
            env_keys = ?, ports = ?, mounts = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    s.image,
    s.command,
    s.restartPolicy,
    JSON.stringify(s.envKeys),
    JSON.stringify(s.ports),
    JSON.stringify(s.mounts),
    Date.now(),
    row.id,
  );
}

/** restart policy ของ Docker → ค่าที่ schema ของเรารับ */
function normalizeRestart(name: string): string {
  const allowed = new Set(["no", "on-failure", "always", "unless-stopped"]);
  return allowed.has(name) ? name : "unless-stopped";
}

/**
 * จังหวะที่ 2: สร้าง project จริง
 *
 * สร้างเป็นโหมด compose ที่มี component เดียวแบบ image — ตรงกับสิ่งที่ container เดิมเป็นอยู่
 * (image สำเร็จรูป ไม่มี source ให้ build) และต่อยอดเป็นหลาย component ได้ภายหลัง
 *
 * **ไม่ deploy อัตโนมัติ** — ผู้ใช้กด Deploy เองเมื่อพร้อม container เดิมจึงไม่ถูกแทนที่โดยไม่ตั้งใจ
 */
async function runImport(
  db: Database,
  docker: DockerCliClient,
  masterKeys: MasterKeys | null,
  row: ImportRow,
): Promise<void> {
  const info = await docker.inspectContainer(row.container_id);
  if (!info) throw new AppError("VALIDATION_ERROR", "container หายไปก่อนนำเข้าเสร็จ");

  const s = summarizeInspect(info);
  const name = row.project_name?.trim() || row.container_name.replace(/^\//, "");
  const now = Date.now();
  const projectId = ulid();
  const componentId = ulid();

  // ค่าของ env: อ่านจาก container แล้วเข้ารหัสก่อนแตะ DB (ไม่เคยเก็บ plaintext)
  const envRows: Array<{ id: string; key: string; ciphertext: Uint8Array }> = [];
  if (masterKeys) {
    for (const raw of info.Config?.Env ?? []) {
      const eq = raw.indexOf("=");
      const key = raw.slice(0, eq);
      if (!s.envKeys.includes(key)) continue;
      const aad = `env:${projectId}:${key}`;
      envRows.push({
        id: ulid(),
        key,
        ciphertext: await encryptEnvelope(masterKeys, raw.slice(eq + 1), aad),
      });
    }
  }

  const webPort = s.ports[0]?.containerPort ?? null;
  const hostPort = s.ports[0]?.hostPort ?? null;
  const restart = normalizeRestart(s.restartPolicy);

  db.transaction(() => {
    db.query(
      `INSERT INTO projects
         (id, name, status, mode, source_type, dockerfile_path, build_context,
          internal_port, exposed_port, restart_policy, created_at, updated_at)
       VALUES (?, ?, 'new', 'compose', 'dockerfile', 'Dockerfile', '.', ?, ?, ?, ?, ?)`,
    ).run(projectId, name, webPort, hostPort, restart, now, now);

    db.query(
      `INSERT INTO project_components
         (id, project_id, name, role, source_kind, image_ref, command, internal_port,
          is_web, web_port, restart_policy, position, created_at, updated_at)
       VALUES (?, ?, 'app', ?, 'image', ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(
      componentId,
      projectId,
      webPort ? "web" : "app",
      s.image,
      s.command,
      webPort,
      webPort ? 1 : 0,
      webPort,
      restart,
      now,
      now,
    );

    for (const e of envRows) {
      db.query(
        `INSERT INTO environment_variables
           (id, project_id, key, value_ciphertext, is_secret, scope, enabled, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, 'runtime', 1, 1, ?, ?)`,
      ).run(e.id, projectId, e.key, e.ciphertext, now, now);
    }

    db.query(
      "UPDATE container_imports SET status = 'done', project_id = ?, updated_at = ? WHERE id = ?",
    ).run(projectId, now, row.id);
  })();
}

/** ทำงานค้างหนึ่งรอบ — export เพื่อเทสต์ได้โดยไม่ต้องรัน loop */
export async function processPendingImports(
  db: Database,
  docker: DockerCliClient,
  masterKeys: MasterKeys | null,
  onLog: (line: string) => void = () => {},
): Promise<number> {
  const rows = db
    .query<ImportRow, []>(
      `SELECT id, container_id, container_name, status, project_name
         FROM container_imports
        WHERE status IN ('pending', 'confirmed')
        ORDER BY created_at
        LIMIT 5`,
    )
    .all();

  for (const row of rows) {
    try {
      if (row.status === "pending") await runInspect(db, docker, row);
      else await runImport(db, docker, masterKeys, row);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onLog(`นำเข้า container ล้มเหลว (${row.container_name}): ${message}`);
      db.query(
        "UPDATE container_imports SET status = 'failed', failure_message = ?, updated_at = ? WHERE id = ?",
      ).run(message, Date.now(), row.id);
    }
  }
  return rows.length;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

export async function containerImportLoop(
  db: Database,
  docker: DockerCliClient,
  masterKeys: MasterKeys | null,
  signal: AbortSignal,
  onLog: (line: string) => void = () => {},
): Promise<void> {
  while (!signal.aborted) {
    try {
      await processPendingImports(db, docker, masterKeys, onLog);
    } catch (err) {
      onLog(`import loop error: ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(IMPORT_POLL_MS, signal);
  }
}
