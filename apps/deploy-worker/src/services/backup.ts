/**
 * Service backup/restore execution — Phase 16
 *
 * worker เท่านั้นที่แตะ Docker (ADR-0002) — เรียกได้จากสองทาง:
 * 1. Manual: control-api enqueue service_jobs type='backup'/'restore' → serviceJobLoop เรียก
 *    runBackup()/runRestore() เหมือน operation อื่น ๆ (provision/start/stop/...)
 * 2. Scheduled: backup-schedule-loop.ts เรียก runBackup() ตรง ๆ โดยไม่ผ่าน queue เลย —
 *    รูปแบบเดียวกับ runtimeLogLoop/metricsLoop ที่ poll DB แล้วทำงานเองได้ ไม่ขัด ADR-0002
 *    (ADR-0002 ห้าม worker INSERT ลง service_jobs เท่านั้น ไม่ได้ห้าม background loop อื่น)
 *
 * ไฟล์เก็บที่ <backupsDir>/services/<serviceId>/<backupId>.<ext> — backupsDir คือ mount point
 * ของ zixploy-backups volume เดียวกับที่ control-api ใช้ backup ตัวเอง (docker-compose.yml)
 *
 * สองวิธี backup ตาม BackupStrategy ของแต่ละ engine (@zixploy/shared/services.ts):
 * - "exec": pg_dump/mysqldump/mongodump ผ่าน `docker exec -i` ขณะ container ยังรันอยู่ ไม่มี downtime
 * - "file-copy": หยุด container สั้น ๆ แล้ว tar ทั้ง data volume ผ่าน helper container (redis/libsql
 *   ที่ไม่มี dump tool ปลอดภัยพอ หรือไม่มี shell ให้ exec เข้าไปเลย)
 *
 * ไม่ต้องใช้ master key เลย — credential ทุกตัวมาจาก shell expansion ของ env ที่อยู่ใน container
 * เอง ไม่เคยผ่าน argv ของ worker (ดู comment บนสุดของ services.ts) ต่างจากที่อื่นในระบบที่ operate
 * กับ ciphertext blob เล็ก ๆ ในหน่วยความจำ (env var, TLS key) ไฟล์ backup ที่นี่เป็น stream ขนาด
 * หลาย GB ได้ — เข้ารหัสแบบ streaming ต้องใช้ crypto implementation ที่ซับซ้อนกว่ามาก จึง**ไม่เข้ารหัส
 * ที่ตัวไฟล์** ใน v1 นี้ (เก็บเป็น plaintext บน zixploy-backups volume) — ผู้ดูแลต้องป้องกันที่ระดับ
 * disk/volume permission เอง ไม่ใช่ระดับแอปเหมือนความลับอื่นในระบบ
 */

import type { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  AppError,
  getTemplate,
  SERVICE_BACKUP_SETTINGS,
  type ServiceType,
  serviceContainerName,
  serviceVolumeName,
  ulid,
} from "@zixploy/shared";
import type { DockerCliClient } from "../docker/cli-client";
import { assertDockerArgsSafe } from "../docker/safety";
import { loadService } from "./provision";

/** image เล็กสุดที่มี tar ในตัว — ใช้เฉพาะตอน file-copy mode (redis/libsql) */
const HELPER_IMAGE = "alpine:3.20";

export interface BackupDeps {
  db: Database;
  docker: DockerCliClient;
  /** ตำแหน่ง mount ของ zixploy-backups volume ใน container นี้ (ปกติ "/backups") */
  backupsDir: string;
  onLog?: (line: string) => void;
}

/** จำกัดสิทธิ์ไฟล์ backup ให้เฉพาะเจ้าของ — เนื้อหาเป็น plaintext เต็มฐานข้อมูล (no-op บน Windows) */
function restrictPermissions(path: string): void {
  if (process.platform === "win32") return;
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort — ไม่ให้ backup ที่สำเร็จแล้วกลายเป็น fail เพราะ chmod พลาด
  }
}

function truncateMsg(text: string, max = 400): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function serviceBackupDir(backupsDir: string, serviceId: string): string {
  return join(backupsDir, "services", serviceId);
}

interface BackupRow {
  id: string;
  service_id: string;
  status: string;
  file_name: string | null;
}

function loadBackup(db: Database, backupId: string): BackupRow | null {
  return (
    db
      .query<BackupRow, [string]>(
        "SELECT id, service_id, status, file_name FROM service_backups WHERE id = ?",
      )
      .get(backupId) ?? null
  );
}

function startBackupRecord(
  db: Database,
  serviceId: string,
  trigger: "manual" | "scheduled",
): string {
  const id = ulid();
  const now = Date.now();
  db.query(
    `INSERT INTO service_backups (id, service_id, trigger, status, started_at, created_at)
     VALUES (?, ?, ?, 'running', ?, ?)`,
  ).run(id, serviceId, trigger, now, now);
  return id;
}

function finishBackupRecord(
  db: Database,
  backupId: string,
  result: { ok: true; fileName: string; sizeBytes: number } | { ok: false; message: string },
): void {
  const now = Date.now();
  if (result.ok) {
    db.query(
      `UPDATE service_backups SET status = 'succeeded', file_name = ?, size_bytes = ?, finished_at = ?
       WHERE id = ?`,
    ).run(result.fileName, result.sizeBytes, now, backupId);
  } else {
    db.query(
      `UPDATE service_backups SET status = 'failed', failure_message = ?, finished_at = ? WHERE id = ?`,
    ).run(truncateMsg(result.message, 500), now, backupId);
  }
}

/** ลบ backup ที่เกิน retention — เก็บเฉพาะ N ชุดล่าสุดที่ succeeded ทั้งแถวใน DB และไฟล์จริง */
function pruneOldBackups(db: Database, backupsDir: string, serviceId: string, keep: number): void {
  const dir = serviceBackupDir(backupsDir, serviceId);
  const old = db
    .query<{ id: string; file_name: string | null }, [string, number]>(
      `SELECT id, file_name FROM service_backups
       WHERE service_id = ? AND status = 'succeeded'
       ORDER BY created_at DESC LIMIT -1 OFFSET ?`,
    )
    .all(serviceId, keep);

  for (const row of old) {
    if (row.file_name) {
      try {
        rmSync(join(dir, row.file_name), { force: true });
      } catch {
        // ไฟล์อาจถูกลบไปแล้ว/สิทธิ์ไม่พอ — ไม่ให้กระทบผลของ backup รอบนี้ที่เพิ่งสำเร็จ
      }
    }
    db.query("DELETE FROM service_backups WHERE id = ?").run(row.id);
  }
}

/**
 * dump ข้อมูลของ service หนึ่งตัวลงไฟล์ใหม่ แล้วบันทึกผลลง service_backups
 * throw เมื่อล้มเหลว (ผู้เรียกที่เป็น job-based path จะบันทึก failure_message ของ job ต่อเอง)
 */
export async function runBackup(
  deps: BackupDeps,
  serviceId: string,
  trigger: "manual" | "scheduled",
): Promise<void> {
  const { db, docker, backupsDir, onLog = () => {} } = deps;
  const row = loadService(db, serviceId);
  if (!row) throw new AppError("SERVICE_NOT_FOUND", "ไม่พบ service");

  const template = getTemplate(row.type as ServiceType);
  const strategy = template.backupStrategy();
  const dir = serviceBackupDir(backupsDir, serviceId);
  mkdirSync(dir, { recursive: true });

  const backupId = startBackupRecord(db, serviceId, trigger);
  const fileName = `${backupId}.${strategy.fileExtension}`;
  const destPath = join(dir, fileName);
  const containerName = serviceContainerName(serviceId);

  onLog(`เริ่ม backup "${row.name}" (${trigger})`);

  try {
    if (strategy.mode === "exec") {
      const info = await docker.inspectContainer(containerName);
      if (!info?.State.Running) {
        throw new AppError("SERVICE_BACKUP_FAILED", "container ไม่ได้รันอยู่ — backup ไม่ได้");
      }
      const args = ["exec", "-i", containerName, ...strategy.dumpCmd];
      const { code, stderr } = await docker.spawnCaptureToFile(
        args,
        destPath,
        SERVICE_BACKUP_SETTINGS.dumpTimeoutMs,
      );
      if (code !== 0) {
        throw new AppError("SERVICE_BACKUP_FAILED", `dump ล้มเหลว: ${truncateMsg(stderr)}`);
      }
    } else {
      await runFileCopyBackup(docker, containerName, serviceVolumeName(serviceId), destPath, onLog);
    }

    restrictPermissions(destPath);
    const sizeBytes = statSync(destPath).size;
    finishBackupRecord(db, backupId, { ok: true, fileName, sizeBytes });
    db.query("UPDATE services SET last_backup_at = ? WHERE id = ?").run(Date.now(), serviceId);
    pruneOldBackups(db, backupsDir, serviceId, row.backup_retention_count);
    onLog(`backup "${row.name}" สำเร็จ (${sizeBytes.toLocaleString()} bytes)`);
  } catch (err) {
    try {
      rmSync(destPath, { force: true });
    } catch {
      // เผื่อเขียนไปครึ่ง ๆ กลาง ๆ — ลบทิ้งกันไฟล์ค้าง ไม่ critical ถ้าลบไม่สำเร็จ
    }
    const message = err instanceof Error ? err.message : String(err);
    finishBackupRecord(db, backupId, { ok: false, message });
    onLog(`backup "${row.name}" ล้มเหลว: ${message}`);
    throw err;
  }
}

async function runFileCopyBackup(
  docker: DockerCliClient,
  containerName: string,
  volumeName: string,
  destPath: string,
  onLog: (line: string) => void,
): Promise<void> {
  const info = await docker.inspectContainer(containerName);
  const wasRunning = info?.State.Running ?? false;

  if (wasRunning) {
    onLog("หยุด container ชั่วคราวเพื่อความสอดคล้องของข้อมูล...");
    await docker.stopContainer(containerName, { timeoutSec: 30 });
  }
  try {
    await docker.pullImage(HELPER_IMAGE);
    const args = [
      "run",
      "--rm",
      "-v",
      `${volumeName}:/vol:ro`,
      HELPER_IMAGE,
      "tar",
      "-czf",
      "-",
      "-C",
      "/vol",
      ".",
    ];
    assertDockerArgsSafe(args);
    const { code, stderr } = await docker.spawnCaptureToFile(
      args,
      destPath,
      SERVICE_BACKUP_SETTINGS.dumpTimeoutMs,
    );
    if (code !== 0) {
      throw new AppError("SERVICE_BACKUP_FAILED", `backup ล้มเหลว: ${truncateMsg(stderr)}`);
    }
  } finally {
    if (wasRunning) {
      onLog("เริ่ม container ใหม่...");
      await docker.startContainer(containerName);
    }
  }
}

/**
 * กู้คืนข้อมูลของ service จาก backup ที่เลือก — เขียนทับข้อมูลปัจจุบันทั้งหมด (ไม่ backup ก่อนอัตโนมัติ
 * ผู้ใช้ต้องตัดสินใจเองว่าจะ backup ปัจจุบันก่อนไหม — UI เตือนไว้ก่อนกด confirm)
 */
export async function runRestore(
  deps: BackupDeps,
  serviceId: string,
  backupId: string,
): Promise<void> {
  const { db, docker, backupsDir, onLog = () => {} } = deps;
  const row = loadService(db, serviceId);
  if (!row) throw new AppError("SERVICE_NOT_FOUND", "ไม่พบ service");

  const backup = loadBackup(db, backupId);
  if (!backup || backup.service_id !== serviceId) {
    throw new AppError("SERVICE_BACKUP_NOT_FOUND", "ไม่พบ backup นี้");
  }
  if (backup.status !== "succeeded" || !backup.file_name) {
    throw new AppError("SERVICE_BACKUP_NOT_READY", "backup นี้ยังไม่พร้อมสำหรับ restore");
  }

  const srcPath = join(serviceBackupDir(backupsDir, serviceId), backup.file_name);
  if (!existsSync(srcPath)) {
    throw new AppError("SERVICE_BACKUP_NOT_FOUND", "ไฟล์ backup หายไปจากดิสก์แล้ว");
  }

  const template = getTemplate(row.type as ServiceType);
  const strategy = template.backupStrategy();
  const containerName = serviceContainerName(serviceId);

  onLog(`เริ่ม restore "${row.name}" จาก backup ${backupId}`);

  if (strategy.mode === "exec") {
    const info = await docker.inspectContainer(containerName);
    if (!info?.State.Running) {
      throw new AppError("SERVICE_RESTORE_FAILED", "container ไม่ได้รันอยู่ — restore ไม่ได้");
    }
    const args = ["exec", "-i", containerName, ...strategy.restoreCmd];
    const { code, stderr } = await docker.spawnFromFile(
      args,
      srcPath,
      SERVICE_BACKUP_SETTINGS.dumpTimeoutMs,
    );
    if (code !== 0) {
      throw new AppError("SERVICE_RESTORE_FAILED", `restore ล้มเหลว: ${truncateMsg(stderr)}`);
    }
  } else {
    await runFileCopyRestore(docker, containerName, serviceVolumeName(serviceId), srcPath, onLog);
  }

  onLog(`restore "${row.name}" สำเร็จ`);
}

async function runFileCopyRestore(
  docker: DockerCliClient,
  containerName: string,
  volumeName: string,
  srcPath: string,
  onLog: (line: string) => void,
): Promise<void> {
  const info = await docker.inspectContainer(containerName);
  const wasRunning = info?.State.Running ?? false;

  if (wasRunning) {
    onLog("หยุด container ชั่วคราวเพื่อ restore...");
    await docker.stopContainer(containerName, { timeoutSec: 30 });
  }
  try {
    await docker.pullImage(HELPER_IMAGE);
    // ล้างของเดิมทั้งหมด (รวม dotfile) ก่อน extract ทับ — กันเศษไฟล์เก่าที่ backup ใหม่ไม่มีค้างอยู่
    const args = [
      "run",
      "--rm",
      "-i",
      "-v",
      `${volumeName}:/vol`,
      HELPER_IMAGE,
      "sh",
      "-c",
      "rm -rf /vol/* /vol/.[!.]* /vol/..?* 2>/dev/null; tar -xzf - -C /vol",
    ];
    assertDockerArgsSafe(args);
    const { code, stderr } = await docker.spawnFromFile(
      args,
      srcPath,
      SERVICE_BACKUP_SETTINGS.dumpTimeoutMs,
    );
    if (code !== 0) {
      throw new AppError("SERVICE_RESTORE_FAILED", `restore ล้มเหลว: ${truncateMsg(stderr)}`);
    }
  } finally {
    if (wasRunning) {
      onLog("เริ่ม container ใหม่...");
      await docker.startContainer(containerName);
    }
  }
}
