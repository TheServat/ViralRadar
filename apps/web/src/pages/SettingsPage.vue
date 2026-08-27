<script setup lang="ts">
/**
 * Settings, written straight to `.env`.
 *
 * Two things this screen is careful about:
 *   - a secret already stored is never sent back to the browser, so the field
 *     shows "configured" and an empty box means "leave it alone"
 *   - configuration is read once at startup, so saving says a restart is
 *     needed rather than pretending the change is already live
 */
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { api } from '@/api/client';
import type { SettingValue, SettingsData } from '@/api/types';
import { health, notify, refreshHealth, useAsync } from '@/composables/useRadar';
import { useCountryOptions, useLanguageOptions } from '@/composables/useCodes';
import { facets } from '@/composables/useRadar';
import SectionHeader from '@/components/SectionHeader.vue';

const { data, loading, error, reload } = useAsync<SettingsData>(() => api.settings());
const { t } = useI18n();
const route = useRoute();
const router = useRouter();

const draft = ref<Record<string, string>>({});
const saving = ref(false);
const savedMessage = ref<string | null>(null);
const saveError = ref<string | null>(null);
const openGroups = ref<string[]>(['audience', 'credentials']);

/** The wizard is shown on a fresh install, or on demand via ?wizard=1. */
const wizard = ref(false);
const step = ref(1);

watch(
  () => data.value,
  (settings) => {
    if (!settings) return;
    const next: Record<string, string> = {};
    for (const field of settings.fields) {
      // Secrets start empty: an empty box means "keep whatever is stored".
      next[field.key] = field.kind === 'secret' ? '' : (field.value ?? '');
    }
    draft.value = next;
  },
  { immediate: true },
);

watch(
  [() => health.value, () => route.query['wizard']],
  ([h, param]) => {
    if (param === '1') wizard.value = true;
    else if (h?.firstRun === true && savedMessage.value === null) wizard.value = true;
  },
  { immediate: true },
);

const GROUP_ORDER = ['audience', 'credentials', 'sources', 'timing', 'scoring', 'network', 'ai'];

const groups = computed(() => {
  const fields = data.value?.fields ?? [];
  return GROUP_ORDER.map((group) => ({
    group,
    fields: fields.filter((f) => f.group === group),
  })).filter((g) => g.fields.length > 0);
});

const byKey = computed(() => new Map((data.value?.fields ?? []).map((f) => [f.key, f])));

const presentLanguages = computed(() => facets.value.languages);
const presentCountries = computed(() => facets.value.countries);
const languageOptions = useLanguageOptions(presentLanguages);
const countryOptions = useCountryOptions(presentCountries);

/** REGIONS and LANGUAGES are code lists; everything else is a plain field. */
function isCodeList(key: string): 'region' | 'language' | null {
  if (key === 'REGIONS') return 'region';
  if (key === 'LANGUAGES') return 'language';
  return null;
}

function listValue(key: string): string[] {
  const raw = draft.value[key] ?? '';
  return raw === '' ? [] : raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

function setListValue(key: string, values: string[]): void {
  draft.value[key] = values.join(',');
}

/** Only what actually changed is sent; blank secrets are simply omitted. */
function changedValues(): Record<string, string> {
  const updates: Record<string, string> = {};
  for (const [key, value] of Object.entries(draft.value)) {
    const field = byKey.value.get(key);
    if (field === undefined) continue;
    if (field.kind === 'secret') {
      if (value !== '') updates[key] = value;
      continue;
    }
    if (value !== (field.value ?? '')) updates[key] = value;
  }
  return updates;
}

async function save(): Promise<void> {
  saving.value = true;
  saveError.value = null;
  savedMessage.value = null;
  try {
    const updates = changedValues();
    if (Object.keys(updates).length === 0) {
      savedMessage.value = t('settings.saved');
      return;
    }
    await api.saveSettings(updates);
    savedMessage.value = t('settings.saved');
    notify(t('settings.saved'));
    await Promise.all([reload(), refreshHealth()]);
  } catch (e) {
    saveError.value = e instanceof Error ? e.message : String(e);
  } finally {
    saving.value = false;
  }
}

async function finishWizard(): Promise<void> {
  await save();
  wizard.value = false;
  if (route.query['wizard'] === '1') await router.replace({ query: {} });
}

function fieldOf(key: string): SettingValue | undefined {
  return byKey.value.get(key);
}
</script>

<template>
  <div>
    <SectionHeader :title="$t('settings.title')" :hint="$t('settings.hint')" icon="mdi-cog-outline">
      <template #actions>
        <v-btn size="small" variant="text" prepend-icon="mdi-wizard-hat" @click="wizard = true">
          {{ $t('settings.welcome') }}
        </v-btn>
      </template>
    </SectionHeader>

    <v-progress-linear v-if="loading" indeterminate color="primary" class="mb-3" />
    <v-alert v-if="error" type="error" variant="tonal">{{ $t('app.error', { message: error }) }}</v-alert>

    <v-alert v-if="savedMessage" type="success" variant="tonal" class="mb-4" closable>
      {{ savedMessage }}
      <div class="text-caption mt-1 mono">{{ $t('settings.restartHint') }}</div>
    </v-alert>
    <v-alert v-if="saveError" type="error" variant="tonal" class="mb-4" closable>
      {{ $t('settings.saveFailed', { message: saveError }) }}
    </v-alert>

    <template v-if="data">
      <v-expansion-panels v-model="openGroups" multiple variant="accordion" class="mb-4">
        <v-expansion-panel v-for="g in groups" :key="g.group" :value="g.group">
          <v-expansion-panel-title class="group-title">
            {{ $t(`settings.groups.${g.group}`) }}
            <span class="ms-2 faint text-caption">{{ g.fields.length }}</span>
          </v-expansion-panel-title>
          <v-expansion-panel-text>
            <v-row dense>
              <v-col v-for="field in g.fields" :key="field.key" cols="12" md="6">
                <!-- Country and language pickers get real names and search. -->
                <v-autocomplete
                  v-if="isCodeList(field.key) === 'region'"
                  :model-value="listValue(field.key)"
                  :items="countryOptions"
                  :label="$t(field.label)"
                  :hint="$t(field.help)"
                  persistent-hint
                  multiple
                  chips
                  closable-chips
                  clearable
                  @update:model-value="setListValue(field.key, $event)"
                />
                <v-autocomplete
                  v-else-if="isCodeList(field.key) === 'language'"
                  :model-value="listValue(field.key)"
                  :items="languageOptions"
                  :label="$t(field.label)"
                  :hint="$t(field.help)"
                  persistent-hint
                  multiple
                  chips
                  closable-chips
                  clearable
                  @update:model-value="setListValue(field.key, $event)"
                />
                <v-select
                  v-else-if="field.kind === 'select'"
                  v-model="draft[field.key]"
                  :items="(field.options ?? []).map((o) => ({ value: o, title: o === '' ? $t('app.none') : o }))"
                  :label="$t(field.label)"
                  :hint="$t(field.help)"
                  persistent-hint
                />
                <v-text-field
                  v-else-if="field.kind === 'secret'"
                  v-model="draft[field.key]"
                  type="password"
                  autocomplete="off"
                  :label="$t(field.label)"
                  :hint="$t(field.help)"
                  :placeholder="field.isSet ? $t('settings.secretPlaceholder') : ''"
                  persistent-hint
                >
                  <template #append-inner>
                    <v-chip size="x-small" :color="field.isSet ? 'success' : 'on-surface-variant'" variant="tonal">
                      {{ field.isSet ? $t('settings.secretSet') : $t('settings.secretUnset') }}
                    </v-chip>
                  </template>
                  <template v-if="field.helpUrl" #append>
                    <v-btn
                      icon="mdi-open-in-new"
                      variant="text"
                      size="small"
                      :href="field.helpUrl"
                      target="_blank"
                      rel="noreferrer noopener"
                    />
                  </template>
                </v-text-field>
                <v-text-field
                  v-else
                  v-model="draft[field.key]"
                  :type="field.kind === 'number' ? 'number' : 'text'"
                  :min="field.min ?? undefined"
                  :max="field.max ?? undefined"
                  :label="$t(field.label)"
                  :hint="$t(field.help)"
                  :placeholder="field.placeholder ?? ''"
                  persistent-hint
                >
                  <template v-if="field.helpUrl" #append>
                    <v-btn
                      icon="mdi-open-in-new"
                      variant="text"
                      size="small"
                      :href="field.helpUrl"
                      target="_blank"
                      rel="noreferrer noopener"
                    />
                  </template>
                </v-text-field>
              </v-col>
            </v-row>
          </v-expansion-panel-text>
        </v-expansion-panel>
      </v-expansion-panels>

      <div class="d-flex ga-2">
        <v-btn color="primary" :loading="saving" prepend-icon="mdi-content-save" @click="save">
          {{ $t('app.save') }}
        </v-btn>
      </div>
    </template>

    <!-- First-run wizard -->
    <v-dialog v-model="wizard" max-width="720" persistent scrollable>
      <v-card>
        <v-card-title class="wizard-title">{{ $t('settings.welcome') }}</v-card-title>
        <v-card-text>
          <p class="text-body-2 mb-4">{{ $t('settings.welcomeBody') }}</p>

          <v-stepper v-model="step" flat :items="[
            $t('settings.step1'),
            $t('settings.step2'),
            $t('settings.step3'),
            $t('settings.stepDone'),
          ]" hide-actions>
            <template #item.1>
              <v-autocomplete
                :model-value="listValue('REGIONS')"
                :items="countryOptions"
                :label="$t('settings.regions')"
                :hint="$t('settings.regionsHelp')"
                persistent-hint
                multiple
                chips
                closable-chips
                class="mb-4"
                @update:model-value="setListValue('REGIONS', $event)"
              />
              <v-autocomplete
                :model-value="listValue('LANGUAGES')"
                :items="languageOptions"
                :label="$t('settings.languages')"
                :hint="$t('settings.languagesHelp')"
                persistent-hint
                multiple
                chips
                closable-chips
                @update:model-value="setListValue('LANGUAGES', $event)"
              />
            </template>

            <template #item.2>
              <p class="text-body-2 mb-2">{{ $t('settings.youtubeKeyHelp') }}</p>
              <v-alert type="info" variant="tonal" density="compact" class="mb-3">
                <div class="text-caption">{{ $t('settings.youtubeSteps') }}</div>
                <div class="text-caption faint mt-1">{{ $t('settings.freeNote') }}</div>
              </v-alert>
              <v-btn
                v-if="fieldOf('YOUTUBE_API_KEY')?.helpUrl"
                :href="fieldOf('YOUTUBE_API_KEY')?.helpUrl ?? ''"
                target="_blank"
                rel="noreferrer noopener"
                append-icon="mdi-open-in-new"
                color="primary"
                variant="tonal"
                class="mb-4"
              >
                {{ $t('settings.getIt') }}
              </v-btn>
              <v-text-field
                v-model="draft['YOUTUBE_API_KEY']"
                type="password"
                autocomplete="off"
                :label="$t('settings.youtubeKey')"
                :placeholder="fieldOf('YOUTUBE_API_KEY')?.isSet ? $t('settings.secretPlaceholder') : ''"
              />
            </template>

            <template #item.3>
              <p class="text-body-2 mb-2">{{ $t('settings.redditIdHelp') }}</p>
              <v-alert type="info" variant="tonal" density="compact" class="mb-3">
                <div class="text-caption">{{ $t('settings.redditSteps') }}</div>
              </v-alert>
              <v-btn
                href="https://www.reddit.com/prefs/apps"
                target="_blank"
                rel="noreferrer noopener"
                append-icon="mdi-open-in-new"
                color="primary"
                variant="tonal"
                class="mb-4"
              >
                {{ $t('settings.getIt') }}
              </v-btn>
              <v-text-field v-model="draft['REDDIT_CLIENT_ID']" :label="$t('settings.redditId')" class="mb-3" />
              <v-text-field
                v-model="draft['REDDIT_CLIENT_SECRET']"
                type="password"
                autocomplete="off"
                :label="$t('settings.redditSecret')"
                :placeholder="fieldOf('REDDIT_CLIENT_SECRET')?.isSet ? $t('settings.secretPlaceholder') : ''"
              />
            </template>

            <template #item.4>
              <v-alert type="success" variant="tonal">
                {{ $t('settings.stepDoneBody') }}
              </v-alert>
            </template>
          </v-stepper>
        </v-card-text>

        <v-card-actions class="px-6 pb-4">
          <v-btn variant="text" @click="wizard = false">{{ $t('settings.skip') }}</v-btn>
          <v-spacer />
          <v-btn v-if="step > 1" variant="text" @click="step--">{{ $t('settings.back') }}</v-btn>
          <v-btn v-if="step < 4" color="primary" @click="step++">{{ $t('settings.next') }}</v-btn>
          <v-btn v-else color="primary" :loading="saving" @click="finishWizard">
            {{ $t('settings.finish') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.group-title {
  font-size: 0.9rem;
  font-weight: 650;
}
.wizard-title {
  font-size: 1.1rem;
  font-weight: 650;
  padding-top: 20px;
}
.mono {
  font-family: ui-monospace, monospace;
}
.faint {
  opacity: 0.7;
}
</style>
