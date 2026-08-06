# Phase 4 — Environment Settings และ Secret Management

## เป้าหมาย

ให้ Admin จัดการ environment variables ได้สะดวก ขณะที่ secret ถูกเข้ารหัส ปิดบัง และไม่รั่วไปยัง log หรือ API response

## Variable Model

| Field | รายละเอียด |
|---|---|
| Key | `[A-Za-z_][A-Za-z0-9_]*` |
| Value | plaintext เฉพาะก่อน encryption/ตอน inject |
| Sensitivity | plain หรือ secret |
| Scope | runtime, build หรือ both |
| Enabled | เปิด/ปิดโดยไม่ต้องลบ |
| Version | ใช้ตรวจ concurrent edit และ audit |

## UI Requirements

- Table editor สำหรับ key/value
- Secret แสดงเพียง `••••••` และไม่คืนค่าเดิมจาก API
- เปลี่ยน secret ด้วย replace action; ไม่มี reveal ใน MVP
- Multiline editor
- Import `.env` พร้อม preview/conflict resolution
- Duplicate key validation
- Search/filter ตาม scope
- แสดงว่า config เปลี่ยนแล้วต้อง redeploy
- Save อย่างเดียว หรือ Save & Redeploy

## Encryption Design

- ใช้ authenticated encryption เช่น AES-256-GCM หรือ XChaCha20-Poly1305
- Master key มาจาก file/secret นอกฐานข้อมูล
- แต่ละ value มี nonce แบบสุ่มและ key version
- Additional authenticated data ผูกกับ project ID + variable key
- รองรับ key rotation ผ่าน versioned keys
- ห้ามมี API สำหรับ export secret plaintext ใน MVP
- Backup ต้องรวม encrypted DB แต่เก็บ master key แยกที่ปลอดภัย

## Injection Rules

### Runtime

- Decrypt ใน worker ก่อน container creation
- ส่งผ่าน Docker container environment โดยไม่สร้าง `.env` ถาวร
- ห้ามบันทึก full Docker create request

### Build-time

- แนะนำ BuildKit secrets สำหรับข้อมูลลับ
- Build args ใช้เฉพาะค่าที่ผู้ใช้รับรู้ว่าอาจค้างใน image metadata/layers
- UI ต้องเตือนเมื่อ mark secret เป็น build arg

## Redaction

- สร้าง redaction set จาก secret ที่มีความยาวขั้นต่ำเหมาะสม
- ปิดบังค่า exact match และ credential URL patterns
- ใช้ redaction ก่อน persist/stream logs
- ไม่ log environment map แม้อยู่ใน debug mode
- Error จาก Docker/GitHub ต้องผ่าน sanitizer

## API Surface

```text
GET    /api/v1/projects/:id/environment
PUT    /api/v1/projects/:id/environment
POST   /api/v1/projects/:id/environment/import
POST   /api/v1/projects/:id/environment/validate
```

API response สำหรับ secret ต้องคืน metadata เช่น `hasValue: true` แทนค่าจริง

## งานดำเนินการ

- [x] สร้าง environment schema และ encryption envelope
- [x] สร้าง key loader และ startup validation
- [x] สร้าง CRUD/import parser
- [x] สร้าง UI editor พร้อม dirty state
- [x] ผูก runtime injection กับ deploy engine
- [x] เพิ่ม BuildKit secret integration
- [x] สร้าง centralized redaction middleware
- [x] สร้าง key rotation command และ runbook

## การทดสอบ

- DB dump ไม่มี plaintext secret
- API/UI หลัง save ไม่สามารถอ่าน secret เดิมกลับได้
- Secret ไม่ปรากฏใน build log, runtime log และ error trace
- Import รองรับ quote, newline, comment และ duplicate key อย่างคาดเดาได้
- เปลี่ยน environment แล้ว deployment ใหม่ได้รับค่าใหม่
- Wrong master key ทำให้ service fail closed พร้อมข้อความสำหรับ operator

## Exit Criteria

- Environment editor ใช้งานครบทั้ง plain/secret และ runtime/build scope
- Encryption, redaction และ injection tests ผ่าน
- มี backup/key-loss warning และ rotation runbook
- Save & Redeploy เชื่อมกับ queue ได้อย่างถูกต้อง

