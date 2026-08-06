# Phase 7 — Volumes และ Persistent Data Safety

## เป้าหมาย

ให้ Admin สร้างและ mount Docker named volumes ได้อย่างปลอดภัย โดย deployment และ cleanup ไม่ทำข้อมูลถาวรสูญหาย

## MVP Scope

- Docker named volumes ที่ระบบสร้างและจัดการ
- หนึ่ง volume mount ได้หนึ่ง path ต่อ project service
- Read/write หรือ read-only
- Attach/detach ผ่าน configuration แล้ว redeploy
- แสดง usage และสถานะการใช้งาน
- ลบเฉพาะ volume ที่ detached และผ่าน confirmation

ไม่รวม:

- Arbitrary host bind mounts
- NFS/cluster storage
- Volume sharing ข้าม project
- File browser/editor
- Automatic application-consistent database backup

## Data Model

- Public volume ID
- Docker volume name ที่สร้างจาก immutable project/volume IDs
- Display name
- Container mount path
- Read-only flag
- Docker driver/options (จำกัด allowlist)
- Lifecycle state: `active`, `detached`, `deletion_pending`, `deleted`, `error`
- Created/last attached timestamps

## Safety Rules

- Validate container path เป็น absolute Linux path
- ห้าม mount ทับ sensitive paths เช่น Docker socket, `/proc`, `/sys`, `/dev`
- ไม่รับ host path จาก API
- Docker volume name สร้างโดยระบบ ไม่ใช้ user input โดยตรง
- ลบไม่ได้หากมี container อ้างอิง
- ก่อนลบตรวจ DB references และ Docker references ซ้ำ
- การลบต้องพิมพ์ชื่อ volume/project ยืนยัน
- Project archive/delete ไม่ลบ volumes โดยอัตโนมัติ

## Deploy Integration

- Snapshot volume configuration ใน deployment record หรือ config revision
- Candidate และ old containerสามารถ mount named volume เดียวกันได้เฉพาะ workload ที่ปลอดภัย
- สำหรับ single-writer volume ต้อง stop-before-start หรือแสดง downtime warning
- เพิ่ม `access_mode` เพื่อเลือก `shared-safe` หรือ `single-writer`
- Rollback ต้อง mount volume ปัจจุบันโดยค่าเริ่มต้นและเตือนเรื่อง schema compatibility

## API Surface

```text
GET    /api/v1/projects/:id/volumes
POST   /api/v1/projects/:id/volumes
PATCH  /api/v1/projects/:id/volumes/:volumeId
POST   /api/v1/projects/:id/volumes/:volumeId/detach
DELETE /api/v1/projects/:id/volumes/:volumeId
POST   /api/v1/projects/:id/volumes/:volumeId/inspect
```

## Backup Hooks

MVP ควรเตรียม extension point แม้ยังไม่ทำ backup engine เต็มรูปแบบ:

- Pre-backup command (optional ในอนาคต)
- Tar stream/export โดย helper container
- Backup metadata: volume ID, checksum, size, timestamp
- Restore ไป volume ใหม่ก่อนสลับ ห้าม overwrite active volume โดยตรง
- Runbook สำหรับ manual backup/restore

## Dashboard

- Volume list และ mount path
- Create/edit form
- Attach status และ redeploy-required badge
- Usage estimate เมื่อ Docker/storage driverรองรับ
- Detach และ delete flows แยกกันชัดเจน
- Destructive confirmation พร้อมคำเตือนว่า rollback application image ไม่ rollback data

## งานดำเนินการ

- [x] สร้าง volume schema และ naming policy (migrations/0010_volumes.sql, shared/naming.ts)
- [x] สร้าง Docker volume adapter (cli-client.ts: createVolume, inspectVolume, removeVolume, listVolumesByLabel)
- [x] สร้าง mount-path/driver allowlist validation (shared/volumes.ts: validateMountPath, safety.ts: defense-in-depth)
- [x] ผูก volume configuration กับ container creation (pipeline/build.ts: createVolume → createContainer)
- [x] รองรับ single-writer activation strategy (warning log — start-before-stop ยังเหมือนเดิม, phase doc: MVP)
- [ ] สร้าง volume UI และ confirmation flow (Phase 8)
- [x] สร้าง orphan detection แบบ report-only ก่อน (volumes/reconciler.ts: volumeReconcileLoop)
- [x] เขียน backup/restore runbook และ extension interface (docs/runbooks/volume-backup-restore.md)

## การทดสอบ

- Deploy/redeploy/restart แล้วยังเห็นข้อมูลใน volume
- Read-only mount เขียนไม่ได้
- Path traversal และ sensitive mount paths ถูกปฏิเสธ
- ลบ volume ที่ใช้งานอยู่ไม่ได้
- Project archive ไม่ลบ volume
- Worker crash ระหว่าง attach/detach แล้ว reconcile กลับสู่สถานะจริงได้
- Rollback แสดง data compatibility warning

## Exit Criteria

- Named volume lifecycle ทำงานครบและข้อมูลอยู่รอดหลัง redeploy
- ไม่มี endpoint ที่ mount arbitrary host path
- Delete guards ผ่าน integration tests
- มี manual backup/restore procedure ที่ทดลองแล้ว

