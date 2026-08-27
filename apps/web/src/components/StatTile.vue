<script setup lang="ts">
/**
 * One number, and everything needed to read it.
 *
 * A tile that shows a bare figure is a riddle. Every tile carries a label
 * saying what is being counted, an optional line of context underneath, and a
 * tooltip explaining what the number means and where it comes from.
 */
defineProps<{
  label: string;
  value: string | number;
  /** Short context under the value: a comparison, a previous figure, a unit. */
  hint?: string | null;
  /** Full sentence explaining what this number is. Shown on hover. */
  tooltip?: string | null;
  icon?: string;
  color?: string;
}>();
</script>

<template>
  <v-tooltip :disabled="!tooltip" :text="tooltip ?? ''" max-width="280">
    <template #activator="{ props: tip }">
      <v-card v-bind="tip" class="stat-tile" :class="{ explained: tooltip }">
        <div class="pa-3">
          <div class="d-flex align-center ga-1 label">
            <v-icon v-if="icon" :icon="icon" size="13" />
            <span class="label-text">{{ label }}</span>
            <v-icon v-if="tooltip" icon="mdi-help-circle-outline" size="11" class="help" />
          </div>
          <div class="value" :class="color ? `text-${color}` : ''">{{ value }}</div>
          <div v-if="hint" class="hint">{{ hint }}</div>
        </div>
      </v-card>
    </template>
  </v-tooltip>
</template>

<style scoped>
.stat-tile {
  height: 100%;
}
.explained {
  cursor: help;
}
.label {
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: rgb(var(--v-theme-on-surface-variant));
}
.label-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.help {
  opacity: 0.5;
  flex: none;
}
.value {
  font-size: 1.35rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
  margin-top: 2px;
}
.hint {
  font-size: 0.7rem;
  color: rgb(var(--v-theme-on-surface-variant));
  opacity: 0.9;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
