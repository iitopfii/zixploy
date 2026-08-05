<template>
  <main class="centered">
    <slot />
  </main>
</template>

<style scoped>
.centered {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 1.5rem;
}
</style>
