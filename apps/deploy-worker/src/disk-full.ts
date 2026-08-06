/**
 * ตรวจ stderr ของ subprocess (git/docker) ว่าสาเหตุคือดิสก์เต็ม (ENOSPC) — ใช้ร่วมกันระหว่าง
 * git/clone.ts และ docker/buildkit.ts แยก error code นี้ออกจาก CLONE_FAILED/BUILD_FAILED ทั่วไป
 * เพราะ operator ต้องรู้ทันทีว่าเป็นปัญหาพื้นที่ดิสก์บนเครื่อง worker ไม่ใช่ปัญหา repo/Dockerfile/build
 */
const DISK_FULL_RE = /ENOSPC|no space left on device/i;

export function isDiskFullError(stderr: string): boolean {
  return DISK_FULL_RE.test(stderr);
}
