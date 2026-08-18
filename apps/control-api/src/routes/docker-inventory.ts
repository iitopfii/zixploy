/**
 * Docker inventory — รายชื่อ container/image ทั้งเครื่องสำหรับหน้า "Docker" ใน dashboard
 *
 *   GET /api/v1/system/docker — snapshot ล่าสุดที่ worker กวาดไว้ (containers + images)
 *
 * control-api ไม่แตะ Docker (ADR-0002) — อ่านตาราง docker_containers/docker_images ที่
 * worker เขียนเท่านั้น · ต้อง authenticate (เปิดเผยข้อมูล infrastructure ทั้งเครื่อง)
 * capturedAt = null → worker ยังไม่เคยกวาดเลย (เพิ่งติดตั้ง/worker ไม่ทำงาน) — UI แจ้งรอ
 */

import type { Database } from "bun:sqlite";
import { API_PREFIX } from "@zixploy/shared";
import { Elysia, t } from "elysia";
import { authPlugin, requireAuthenticated } from "../plugins/auth";

interface ContainerRow {
  container_id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string | null;
  networks: string | null;
  is_managed: number;
  created_text: string | null;
  captured_at: number;
}

interface ImageRow {
  image_id: string;
  repository: string;
  tag: string;
  size: string | null;
  created_since: string | null;
  is_managed: number;
}

const containerSchema = t.Object({
  containerId: t.String(),
  name: t.String(),
  image: t.String(),
  state: t.String(),
  status: t.String(),
  ports: t.Nullable(t.String()),
  networks: t.Nullable(t.String()),
  managed: t.Boolean(),
  createdText: t.Nullable(t.String()),
});

const imageSchema = t.Object({
  imageId: t.String(),
  repository: t.String(),
  tag: t.String(),
  size: t.Nullable(t.String()),
  createdSince: t.Nullable(t.String()),
  managed: t.Boolean(),
});

export function dockerInventoryRoutes(db: Database) {
  return new Elysia({ prefix: API_PREFIX })
    .use(authPlugin(db))
    .guard({ beforeHandle: requireAuthenticated })

    .get(
      "/system/docker",
      () => {
        // เรียง: running ก่อน (สิ่งที่คนสนใจสุด) แล้วตามชื่อ — คงที่ทุกครั้งที่ refresh
        const containers = db
          .query<ContainerRow, []>(
            `SELECT container_id, name, image, state, status, ports, networks, is_managed, created_text, captured_at
               FROM docker_containers
              ORDER BY (state = 'running') DESC, name`,
          )
          .all();
        const images = db
          .query<ImageRow, []>(
            `SELECT image_id, repository, tag, size, created_since, is_managed
               FROM docker_images
              ORDER BY repository, tag`,
          )
          .all();

        return {
          capturedAt: containers[0]?.captured_at ?? null,
          containers: containers.map((c) => ({
            containerId: c.container_id,
            name: c.name,
            image: c.image,
            state: c.state,
            status: c.status,
            ports: c.ports,
            networks: c.networks,
            managed: c.is_managed === 1,
            createdText: c.created_text,
          })),
          images: images.map((i) => ({
            imageId: i.image_id,
            repository: i.repository,
            tag: i.tag,
            size: i.size,
            createdSince: i.created_since,
            managed: i.is_managed === 1,
          })),
        };
      },
      {
        response: t.Object({
          capturedAt: t.Nullable(t.Number()),
          containers: t.Array(containerSchema),
          images: t.Array(imageSchema),
        }),
      },
    );
}
