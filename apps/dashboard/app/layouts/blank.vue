<template>
  <main class="centered">
    <!-- grid + glow เป็น decoration ล้วน ไม่รับ pointer event -->
    <div class="ambience" aria-hidden="true">
      <div class="grid-lines" />
      <div class="glow" />
    </div>
    <div class="slot-wrap">
      <slot />
    </div>
  </main>
</template>

<style scoped>
.centered {
  position: relative;
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: var(--s-5);
  overflow: hidden;
}

.ambience {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.grid-lines {
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(var(--border-subtle) 1px, transparent 1px),
    linear-gradient(90deg, var(--border-subtle) 1px, transparent 1px);
  background-size: 56px 56px;
  /* จางลงจากกลางออกขอบ ไม่ให้เส้นตัดขอบจอแข็ง ๆ */
  mask-image: radial-gradient(ellipse 80% 60% at 50% 40%, #000 20%, transparent 78%);
  opacity: 0.65;
}

.glow {
  position: absolute;
  top: -18%;
  left: 50%;
  transform: translateX(-50%);
  width: min(760px, 120vw);
  height: 460px;
  background: radial-gradient(
    ellipse at center,
    rgb(91 140 255 / 13%) 0%,
    rgb(139 92 246 / 7%) 42%,
    transparent 70%
  );
  filter: blur(28px);
}

.slot-wrap {
  position: relative;
  width: 100%;
  display: grid;
  place-items: center;
}
</style>
