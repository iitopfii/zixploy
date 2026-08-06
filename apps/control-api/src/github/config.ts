/**
 * GitHub App configuration — สร้างจาก DB (github_apps table) ผ่าน registry
 *
 * env-var mode เดิม (ZIXPLOY_GITHUB_APP_ID ฯลฯ) ถูกแทนที่ด้วย manifest flow:
 * GitHub Apps สร้างจาก UI → credentials encrypted ลง DB → decrypt เมื่อใช้
 * ดู github/registry.ts
 */
export interface GitHubAppConfig {
  appId: string;
  appSlug: string;
  privateKey: string; // PEM raw content — decrypt จาก DB, ห้าม log
}
