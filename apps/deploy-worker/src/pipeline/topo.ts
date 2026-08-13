/**
 * Topological ordering ของ component ตาม depends_on (Phase 18)
 *
 * คืนลำดับ start ที่ dependency มาก่อน dependent เสมอ — orchestrate.ts start ตามลำดับนี้แล้ว
 * health-gate ตัวที่มี condition='healthy' ก่อนไปตัวถัดไป
 *
 * control-api กัน cycle ไว้แล้วตอนบันทึก (components-store.ts) — ที่นี่ throw เป็น defense-in-depth
 * เผื่อข้อมูลใน DB เพี้ยน จะได้ fail deploy ชัด ๆ แทน start วนไม่จบ
 */

export interface TopoNode {
  id: string;
  dependsOn: Array<{ id: string }>;
}

/** คืน id เรียงแบบ dependency-first — throw ถ้าเจอ cycle หรืออ้าง id ที่ไม่มีในชุด */
export function topoOrder<T extends TopoNode>(nodes: T[]): T[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const order: T[] = [];

  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (inStack.has(id)) {
      throw new Error(`component dependency cycle ที่ ${id}`);
    }
    const node = byId.get(id);
    if (!node) {
      throw new Error(`depends_on อ้าง component ที่ไม่มีในชุด: ${id}`);
    }
    inStack.add(id);
    for (const dep of node.dependsOn) visit(dep.id);
    inStack.delete(id);
    visited.add(id);
    order.push(node);
  };

  for (const n of nodes) visit(n.id);
  return order;
}
