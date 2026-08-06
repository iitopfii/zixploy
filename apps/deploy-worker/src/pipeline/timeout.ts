/**
 * Deploy timeout wrapper — project.deploy_timeout_sec ครอบทั้ง pipeline (clone→...→activate)
 * แยกจาก lease/cancel signal ที่ withLeaseRenewal (queue.ts) ส่งมาให้ — signal นั้นสะท้อนแค่
 * worker liveness/cancel request ไม่ใช่ "deploy ใช้เวลานานเกินไป" สอง concern นี้ต้องรวมกันเป็น
 * signal เดียวที่ทุก step (clone/build/docker create/health check) เห็นและ abort ตามได้
 *
 * build.ts ใช้ deployTimeout.signal แทน signal ดิบที่รับมาทุกจุด แล้วเช็ค timedOut() ใน catch
 * block เพื่อ override failure_code เป็น DEPLOY_TIMEOUT_EXCEEDED เสมอเมื่อ timer นี้เป็นสาเหตุจริง
 * — ไม่ปล่อยให้ error code ที่ downstream โยนมา (เช่น CLONE_FAILED จาก abort) บดบังสาเหตุที่แท้จริง
 */

export interface DeployTimeout {
  /** ส่งต่อให้ cloneCommit/buildImage/docker calls/waitForHealthy แทน signal ดิบทุกจุด */
  signal: AbortSignal;
  /** true เฉพาะเมื่อ timer นี้เองเป็นคนสั่ง abort — ไม่ใช่ parent signal (lease loss/cancel) */
  timedOut: () => boolean;
  /** เรียกใน finally เสมอ — เคลียร์ timer และ listener กัน leak/ค้างทดสอบ */
  cleanup: () => void;
}

/** parentSignal = signal จาก withLeaseRenewal (lease loss/cancel) — timeout อีกชั้นแยกจากมัน */
export function createDeployTimeout(parentSignal: AbortSignal, timeoutMs: number): DeployTimeout {
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  function onParentAbort(): void {
    controller.abort();
  }

  if (parentSignal.aborted) {
    controller.abort();
  } else {
    parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      parentSignal.removeEventListener("abort", onParentAbort);
    },
  };
}
