# Encryption และ Key Rotation Approach

สถานะ: **ตรึงแล้ว (Phase 0)** — implement จริงใน Phase 4

## Algorithm

- **AES-256-GCM** (มีใน Bun/WebCrypto โดยตรง ไม่ต้องพึ่ง native dependency เพิ่ม)
- Nonce 96-bit สุ่มใหม่ต่อการเข้ารหัสทุกครั้ง — ห้าม reuse
- Additional Authenticated Data (AAD): `"<project_id>:<variable_key>"` — ciphertext ย้ายข้าม project/แก้ key ไม่ได้โดยไม่ทำให้ decrypt fail

## Envelope Format

เก็บใน `environment_variables.value_ciphertext` เป็น binary envelope:

```text
[1 byte  version]    envelope format version = 0x01
[1 byte  key_id]     master key version ที่ใช้เข้ารหัส
[12 byte nonce]
[N byte  ciphertext + 16 byte GCM tag]
```

## Master Key

- อ่านจาก **ไฟล์นอกฐานข้อมูล**: `ZIXPLOY_MASTER_KEY_FILE` ชี้ไฟล์ 32-byte (base64) permission `0600` เจ้าของเป็น service account
- รองรับหลาย key พร้อมกันเพื่อ rotation: ไฟล์เป็น JSON `{ "active": 2, "keys": { "1": "<base64>", "2": "<base64>" } }`
- Startup validation: ไม่มี key / permission ผิด / decode ไม่ได้ → **fail closed** พร้อมข้อความบอก operator ชัดเจน (ไม่เปิด service แบบไม่มี encryption)
- ห้าม log ค่า key ทุกกรณี รวม debug mode

## Key Rotation

1. เพิ่ม key ใหม่ในไฟล์ + ตั้ง `active` เป็นเวอร์ชันใหม่
2. Restart service — ค่าใหม่เข้ารหัสด้วย key ใหม่, ค่าเก่ายัง decrypt ได้ด้วย key เก่า (เลือกจาก `key_id` ใน envelope)
3. รันคำสั่ง `rotate-encryption` (CLI ใน control plane): re-encrypt ทุก row ด้วย key ใหม่ในtransaction เป็น batch
4. เมื่อไม่มี row อ้าง key เก่า (ตรวจด้วยคำสั่งเดียวกัน) จึงลบ key เก่าออกจากไฟล์
5. บันทึกเป็น audit event

Runbook ฉบับเต็มเขียนใน Phase 4 (`docs/runbooks/rotate-encryption-key.md`)

## ขอบเขต

- **ไม่มี API export plaintext secret** ใน MVP — เปลี่ยนค่าด้วย replace เท่านั้น
- Backup ฐานข้อมูลรวม ciphertext ได้ แต่ master key file ต้อง backup **แยกช่องทาง** — เก็บรวมกันทำให้ encryption ไร้ความหมาย

## GitHub App credentials (Phase 2 — implemented)

GitHub Apps สร้างผ่าน **manifest flow** จาก UI ของระบบเอง (ไม่ใช่ env var) — GitHub ส่ง
private key, webhook secret และ client secret กลับมาครั้งเดียวตอน conversion จึงต้องเก็บลง DB

- ตาราง `github_apps`: `pem_ciphertext`, `webhook_secret_ciphertext`, `client_secret_ciphertext`
- ใช้ envelope format เดียวกับด้านบน (AES-256-GCM, key rotation ผ่าน `key_id`)
- AAD: `"github_app:<row_id>:<field>"` — ciphertext ย้ายข้าม app หรือข้าม field ไม่ได้
- Decrypt เฉพาะเมื่อใช้งาน (sign JWT, verify webhook signature) ไม่ cache plaintext ลง disk
- ไม่มี API endpoint ใดคืนค่าเหล่านี้ — response มีแค่ app ID, slug, name, html_url, owner
- **Installation token และ App JWT ยังคงไม่เก็บลง DB** — cache ใน memory เท่านั้น

Master key ไม่ configure → สร้าง GitHub App ไม่ได้ (fail closed) แต่ Phase 1 functionality
ยังทำงานได้ปกติ
