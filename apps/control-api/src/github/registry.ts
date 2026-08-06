/**
 * GitHubAppRegistry — จัดการ GitHub Apps ที่สร้างผ่าน manifest flow
 *
 * - Apps เก็บใน DB (credentials encrypted ด้วย envelope — docs/encryption.md)
 * - GitHubService instance ต่อ app cache ใน memory (decrypt PEM ครั้งเดียว)
 * - Installation token cache อยู่ใน service แต่ละตัว — ไม่เก็บลง DB
 * - Routes depend on interface นี้ — inject mock ในเทสต์ได้
 *
 * Security:
 * - PEM/webhook_secret/client_secret decrypt เฉพาะเมื่อใช้ ไม่ log ทุกกรณี
 * - state token กัน CSRF ใน manifest flow (one-time, TTL 15 นาที)
 */

import type { Database } from "bun:sqlite";
import { AppError, ulid } from "@zixploy/shared";
import { decryptEnvelope, encryptEnvelope } from "../crypto/envelope";
import type { MasterKeys } from "../crypto/master-key";
import { log } from "../logger";
import type { GitHubClient } from "./client";
import { buildManifestForm, exchangeManifestCode, type ManifestForm } from "./manifest";
import { createGitHubService, type GitHubService } from "./service";

/** App summary ที่ routes ส่งออก — ไม่มี secret ใดๆ */
export interface GitHubAppSummary {
  id: string;
  appId: number;
  slug: string;
  name: string;
  htmlUrl: string;
  ownerLogin: string | null;
  createdAt: number;
}

export interface GitHubAppRegistry {
  /** master key configure แล้วหรือยัง — ถ้ายัง สร้าง app ไม่ได้ */
  isReady(): boolean;
  listApps(): GitHubAppSummary[];
  getApp(id: string): GitHubAppSummary | null;
  /** สร้าง manifest form สำหรับ browser POST ไป GitHub */
  createManifest(appName: string, organization?: string): ManifestForm & { state: string };
  /** exchange code + ตรวจ state → เก็บ app encrypted ลง DB */
  completeManifest(code: string, state: string): Promise<GitHubAppSummary>;
  /** ลบ app + mark installations deleted + ปิด auto_deploy ของ projects ที่เกี่ยวข้อง */
  deleteApp(id: string): void;
  /** install URL ของ app นี้ */
  getInstallUrl(id: string): string | null;
  /** GitHubService ของ app นี้ (decrypt PEM + cache) — null ถ้าไม่พบ app */
  getService(appRowId: string): Promise<GitHubService | null>;
  /** GitHubService จาก installation numeric ID (lookup github_app_id) */
  getServiceForInstallation(installationId: number): Promise<GitHubService | null>;
  /** webhook secret ของ app (decrypt) — null ถ้าไม่พบ */
  getWebhookSecret(appRowId: string): Promise<string | null>;
  /** invalidate installation token cache เมื่อ suspend/delete */
  invalidateToken(installationId: number): void;
}

interface AppRow {
  id: string;
  app_id: number;
  slug: string;
  name: string;
  html_url: string;
  owner_login: string | null;
  client_id: string;
  pem_ciphertext: Uint8Array;
  webhook_secret_ciphertext: Uint8Array;
  created_at: number;
  updated_at: number;
}

const APP_COLUMNS =
  "id, app_id, slug, name, html_url, owner_login, client_id, pem_ciphertext, webhook_secret_ciphertext, created_at, updated_at";

function toSummary(row: AppRow): GitHubAppSummary {
  return {
    id: row.id,
    appId: row.app_id,
    slug: row.slug,
    name: row.name,
    htmlUrl: row.html_url,
    ownerLogin: row.owner_login,
    createdAt: row.created_at,
  };
}

/** Pending manifest state — one-time token, TTL 15 นาที */
interface PendingManifest {
  rowId: string;
  createdAt: number;
}

const MANIFEST_STATE_TTL_MS = 15 * 60 * 1000;
const MAX_APP_NAME_LENGTH = 34; // GitHub limit

export interface RegistryOptions {
  /** Public base URL ของระบบ — ใช้ใน webhook/setup URLs */
  baseUrl: string;
  /** null = master key ไม่ได้ configure — จัดการ app ไม่ได้แต่ list ได้ */
  masterKeys: MasterKeys | null;
  /** ฉีด fetch สำหรับเทสต์ manifest exchange */
  manifestFetch?: typeof fetch;
  /** ฉีด GitHubClient factory สำหรับเทสต์ */
  clientFactory?: (appId: string, pem: string) => GitHubClient;
}

export class RealGitHubAppRegistry implements GitHubAppRegistry {
  private readonly serviceCache = new Map<string, Promise<GitHubService>>();
  private readonly pendingManifests = new Map<string, PendingManifest>();

  constructor(
    private readonly db: Database,
    private readonly options: RegistryOptions,
  ) {}

  isReady(): boolean {
    return this.options.masterKeys !== null;
  }

  private requireMasterKeys(): MasterKeys {
    if (!this.options.masterKeys) {
      throw new AppError(
        "GITHUB_UNAVAILABLE",
        "Master key ยังไม่ได้ configure — ตั้งค่า ZIXPLOY_MASTER_KEY_FILE ก่อนสร้าง GitHub App",
      );
    }
    return this.options.masterKeys;
  }

  listApps(): GitHubAppSummary[] {
    const rows = this.db
      .query<AppRow, []>(`SELECT ${APP_COLUMNS} FROM github_apps ORDER BY created_at DESC`)
      .all();
    return rows.map(toSummary);
  }

  getApp(id: string): GitHubAppSummary | null {
    const row = this.db
      .query<AppRow, [string]>(`SELECT ${APP_COLUMNS} FROM github_apps WHERE id = ?`)
      .get(id);
    return row ? toSummary(row) : null;
  }

  createManifest(appName: string, organization?: string): ManifestForm & { state: string } {
    this.requireMasterKeys();

    const trimmed = appName.trim();
    if (!trimmed || trimmed.length > MAX_APP_NAME_LENGTH) {
      throw new AppError(
        "VALIDATION_ERROR",
        `ชื่อ app ต้องยาว 1-${MAX_APP_NAME_LENGTH} ตัวอักษร (GitHub limit)`,
        { field: "name" },
      );
    }

    // ล้าง state ที่หมดอายุ
    const now = Date.now();
    for (const [key, pending] of this.pendingManifests) {
      if (now - pending.createdAt > MANIFEST_STATE_TTL_MS) {
        this.pendingManifests.delete(key);
      }
    }

    // generate row ID ล่วงหน้า — ฝังใน webhook/setup URL ก่อนที่ app จะถูกสร้างจริง
    const rowId = ulid();
    const state = crypto.randomUUID();
    this.pendingManifests.set(state, { rowId, createdAt: now });

    const form = buildManifestForm({
      appName: trimmed,
      baseUrl: this.options.baseUrl,
      rowId,
      state,
      ...(organization ? { organization } : {}),
    });

    return { ...form, state };
  }

  async completeManifest(code: string, state: string): Promise<GitHubAppSummary> {
    const masterKeys = this.requireMasterKeys();

    const pending = this.pendingManifests.get(state);
    if (!pending || Date.now() - pending.createdAt > MANIFEST_STATE_TTL_MS) {
      throw new AppError("VALIDATION_ERROR", "manifest state ไม่ถูกต้องหรือหมดอายุ — เริ่มสร้าง app ใหม่");
    }
    // one-time use
    this.pendingManifests.delete(state);

    const conversion = await exchangeManifestCode(code, this.options.manifestFetch ?? fetch);

    const { rowId } = pending;
    const now = Date.now();

    // encrypt credentials — AAD ผูกกับ row + field
    const pemCiphertext = await encryptEnvelope(
      masterKeys,
      conversion.pem,
      `github_app:${rowId}:pem`,
    );
    const webhookSecretCiphertext = await encryptEnvelope(
      masterKeys,
      conversion.webhookSecret,
      `github_app:${rowId}:webhook_secret`,
    );
    const clientSecretCiphertext = await encryptEnvelope(
      masterKeys,
      conversion.clientSecret,
      `github_app:${rowId}:client_secret`,
    );

    this.db
      .query(
        `INSERT INTO github_apps
          (id, app_id, slug, name, html_url, owner_login, client_id,
           pem_ciphertext, webhook_secret_ciphertext, client_secret_ciphertext,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rowId,
        conversion.appId,
        conversion.slug,
        conversion.name,
        conversion.htmlUrl,
        conversion.ownerLogin,
        conversion.clientId,
        pemCiphertext,
        webhookSecretCiphertext,
        clientSecretCiphertext,
        now,
        now,
      );

    log.info("github app created via manifest", {
      appRowId: rowId,
      appId: conversion.appId,
      slug: conversion.slug,
      // ไม่ log pem/secrets
    });

    return {
      id: rowId,
      appId: conversion.appId,
      slug: conversion.slug,
      name: conversion.name,
      htmlUrl: conversion.htmlUrl,
      ownerLogin: conversion.ownerLogin,
      createdAt: now,
    };
  }

  deleteApp(id: string): void {
    const app = this.getApp(id);
    if (!app) {
      throw new AppError("INSTALLATION_NOT_FOUND", "ไม่พบ GitHub App นี้");
    }

    const now = Date.now();
    // ปิด auto_deploy ของ projects ที่ใช้ installations ของ app นี้
    this.db
      .query(
        `UPDATE projects SET auto_deploy = 0, updated_at = ?
         WHERE installation_id IN (SELECT id FROM github_installations WHERE github_app_id = ?)`,
      )
      .run(now, id);
    // mark installations deleted + ตัด FK ก่อนลบ app row
    this.db
      .query(
        `UPDATE github_installations SET status = 'deleted', github_app_id = NULL, updated_at = ?
         WHERE github_app_id = ?`,
      )
      .run(now, id);
    this.db.query("DELETE FROM github_apps WHERE id = ?").run(id);

    this.serviceCache.delete(id);
    log.info("github app deleted", { appRowId: id, appId: app.appId });
  }

  getInstallUrl(id: string): string | null {
    const app = this.getApp(id);
    if (!app) return null;
    return `https://github.com/apps/${app.slug}/installations/new`;
  }

  async getService(appRowId: string): Promise<GitHubService | null> {
    const cached = this.serviceCache.get(appRowId);
    if (cached) return cached;

    const masterKeys = this.requireMasterKeys();
    const row = this.db
      .query<AppRow, [string]>(`SELECT ${APP_COLUMNS} FROM github_apps WHERE id = ?`)
      .get(appRowId);
    if (!row) return null;

    const servicePromise = (async () => {
      const pem = await decryptEnvelope(masterKeys, row.pem_ciphertext, `github_app:${row.id}:pem`);
      const config = {
        appId: String(row.app_id),
        appSlug: row.slug,
        privateKey: pem,
      };
      if (this.options.clientFactory) {
        return createGitHubService(config, this.options.clientFactory(config.appId, pem));
      }
      return createGitHubService(config);
    })();

    this.serviceCache.set(appRowId, servicePromise);
    try {
      return await servicePromise;
    } catch (err) {
      // decrypt/import ล้มเหลว — ไม่ cache failure
      this.serviceCache.delete(appRowId);
      throw err;
    }
  }

  async getServiceForInstallation(installationId: number): Promise<GitHubService | null> {
    const row = this.db
      .query<{ github_app_id: string | null }, [number]>(
        "SELECT github_app_id FROM github_installations WHERE installation_id = ?",
      )
      .get(installationId);
    if (!row?.github_app_id) return null;
    return this.getService(row.github_app_id);
  }

  async getWebhookSecret(appRowId: string): Promise<string | null> {
    const masterKeys = this.options.masterKeys;
    if (!masterKeys) return null;

    const row = this.db
      .query<{ id: string; webhook_secret_ciphertext: Uint8Array }, [string]>(
        "SELECT id, webhook_secret_ciphertext FROM github_apps WHERE id = ?",
      )
      .get(appRowId);
    if (!row) return null;

    return decryptEnvelope(
      masterKeys,
      row.webhook_secret_ciphertext,
      `github_app:${row.id}:webhook_secret`,
    );
  }

  invalidateToken(installationId: number): void {
    const row = this.db
      .query<{ github_app_id: string | null }, [number]>(
        "SELECT github_app_id FROM github_installations WHERE installation_id = ?",
      )
      .get(installationId);
    if (!row?.github_app_id) return;

    const cached = this.serviceCache.get(row.github_app_id);
    if (cached) {
      void cached.then((service) => service.invalidateToken(installationId)).catch(() => {});
    }
  }
}
