<script setup lang="ts">
/**
 * An image that gives up.
 *
 * This exists instead of `<v-img>` because of one fact about blocked hosts:
 * they do not refuse the connection, they drop the packets. No error ever
 * reaches the page, so a component that waits for `error` before showing its
 * fallback waits forever — which on a filtered network turns a wall of
 * unreachable thumbnails into a wall of spinners that never stop. That reads
 * as a broken dashboard rather than as an image the network cannot fetch.
 *
 * A deadline turns "still waiting" into a fact. When it passes the element is
 * dropped, which also cancels the request: browsers allow only a handful of
 * connections per host, and a dozen hanging ones starve everything queued
 * behind them, including images from hosts that would have worked.
 *
 * Retrying is offered rather than automatic. The usual reason one of these
 * fails is that a VPN is off, and that is fixed by the person, not by a timer
 * hammering a host that is not answering.
 *
 * Deliberately not `loading="lazy"`: the deadline starts when the element is
 * created, and a lazily-loaded image below the fold is never requested at all,
 * so it would be declared failed without a single attempt having been made.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';

const props = withDefaults(
  defineProps<{
    src: string | null;
    alt?: string;
    /**
     * How long to wait before calling it failed.
     *
     * Long enough for a slow CDN on a bad connection, short enough that the
     * page settles into a state rather than looking stuck.
     */
    timeoutMs?: number;
  }>(),
  { alt: '', timeoutMs: 8000 },
);

/**
 * Reported so a page showing many of these can say once what went wrong,
 * instead of repeating the same failure on every tile and leaving the reader
 * to work out that they all share a host.
 */
const emit = defineEmits<{ loaded: []; failed: [] }>();

type State = 'loading' | 'ok' | 'failed';
const state = ref<State>('loading');
/** Bumped to force a fresh element, which is what makes a retry retry. */
const attempt = ref(0);
let timer: ReturnType<typeof setTimeout> | null = null;

const failed = computed(() => state.value === 'failed' || props.src === null);

function stopTimer(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

function start(): void {
  stopTimer();
  if (props.src === null) {
    state.value = 'failed';
    return;
  }
  state.value = 'loading';
  timer = setTimeout(() => {
    if (state.value !== 'loading') return;
    state.value = 'failed';
    emit('failed');
  }, props.timeoutMs);
}

function loaded(): void {
  stopTimer();
  state.value = 'ok';
  emit('loaded');
}

function errored(): void {
  stopTimer();
  state.value = 'failed';
  emit('failed');
}

function retry(): void {
  attempt.value++;
  start();
}

watch(() => props.src, start, { immediate: true });
onBeforeUnmount(stopTimer);

defineExpose({ retry });
</script>

<template>
  <div class="thumb">
    <img
      v-if="src !== null && !failed"
      :key="attempt"
      :src="src"
      :alt="alt"
      class="thumb-img"
      :class="{ pending: state === 'loading' }"
      referrerpolicy="no-referrer"
      decoding="async"
      @load="loaded"
      @error="errored"
    >

    <div v-if="state !== 'ok'" class="thumb-state">
      <v-progress-circular v-if="state === 'loading'" indeterminate size="18" width="2" />
      <slot v-else name="fallback" :retry="retry" />
    </div>
  </div>
</template>

<style scoped>
.thumb {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: rgb(var(--v-theme-surface-light));
}

.thumb-img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

/* Held invisible rather than unrendered: the element has to be in the document
   for the browser to fetch it at all. */
.thumb-img.pending {
  opacity: 0;
}

.thumb-state {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  gap: 4px;
  padding: 4px;
  text-align: center;
  color: rgb(var(--v-theme-on-surface-variant));
  font-size: 0.68rem;
  line-height: 1.3;
}
</style>
