<template>
  <div v-if="settings" class="bg-background border border-border rounded-lg shadow-sm overflow-hidden">
    <h2 class="text-lg font-semibold text-foreground px-6 py-4 border-b border-border bg-header/50">{{ $t('settings.category.system') }}</h2>
    <div class="p-6 space-y-6">
      <!-- Language -->
      <div class="settings-section-content">
         <h3 class="text-base font-semibold text-foreground mb-3">{{ $t('settings.language.title') }}</h3>
         <form @submit.prevent="handleUpdateLanguage" class="space-y-4">
           <div>
             <label for="languageSelect" class="block text-sm font-medium text-text-secondary mb-1">{{ $t('settings.language.selectLabel') }}</label>
             <select id="languageSelect" v-model="selectedLanguage"
                     class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary appearance-none bg-no-repeat bg-right pr-8"
                     style="background-image: url('data:image/svg+xml,%3csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 16 16\'%3e%3cpath fill=\'none\' stroke=\'%236c757d\' stroke-linecap=\'round\' stroke-linejoin=\'round\' stroke-width=\'2\' d=\'M2 5l6 6 6-6\'/%3e%3c/svg%3e'); background-position: right 0.75rem center; background-size: 16px 12px;">
               <option v-for="locale in availableLocales" :key="locale" :value="locale">
                 {{ languageNames[locale] || locale }} <!-- Display mapped name or locale code -->
               </option>
             </select>
           </div>
           <div class="flex items-center justify-between">
              <button type="submit"
                      class="px-4 py-2 bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary transition duration-150 ease-in-out text-sm font-medium">
                {{ $t('settings.language.saveButton') }}
              </button>
              <p v-if="languageMessage" :class="['text-sm', languageSuccess ? 'text-success' : 'text-error']">{{ languageMessage }}</p>
           </div>
         </form>
      </div>
      <hr class="border-border/50"> <!-- Separator -->
      <div v-if="isElectronRuntime" class="settings-section-content">
        <h3 class="text-base font-semibold text-foreground mb-3">{{ $t('settings.floatingNotificationBell.title') }}</h3>
        <label class="flex items-start gap-3">
          <input
            type="checkbox"
            class="mt-0.5 h-4 w-4 accent-primary"
            :checked="floatingNotificationBellEnabled"
            :disabled="floatingNotificationBellLoading"
            @change="handleFloatingNotificationBellChange"
          >
          <span>
            <span class="block text-sm font-medium text-foreground">{{ $t('settings.floatingNotificationBell.enableLabel') }}</span>
            <span class="mt-1 block text-xs text-text-secondary">{{ $t('settings.floatingNotificationBell.description') }}</span>
          </span>
        </label>
        <p v-if="floatingNotificationBellError" class="mt-2 text-sm text-error">{{ floatingNotificationBellError }}</p>
      </div>
      <hr v-if="isElectronRuntime" class="border-border/50">
      <div v-if="isElectronRuntime && gpuStatus" class="settings-section-content">
        <h3 class="text-base font-semibold text-foreground mb-3">{{ $t('settings.hardwareAcceleration.title') }}</h3>
        <label for="hardwareAccelerationSelect" class="block text-sm font-medium text-text-secondary mb-1">{{ $t('settings.hardwareAcceleration.selectLabel') }}</label>
        <select id="hardwareAccelerationSelect" :value="gpuStatus.mode" :disabled="gpuSaving" @change="handleGpuModeChange"
                class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary appearance-none bg-no-repeat bg-right pr-8"
                style="background-image: url('data:image/svg+xml,%3csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 16 16\'%3e%3cpath fill=\'none\' stroke=\'%236c757d\' stroke-linecap=\'round\' stroke-linejoin=\'round\' stroke-width=\'2\' d=\'M2 5l6 6 6-6\'/%3e%3c/svg%3e'); background-position: right 0.75rem center; background-size: 16px 12px;">
          <option value="auto">{{ $t('settings.hardwareAcceleration.modeAuto') }}</option>
          <option value="on">{{ $t('settings.hardwareAcceleration.modeOn') }}</option>
          <option value="off">{{ $t('settings.hardwareAcceleration.modeOff') }}</option>
        </select>
        <small class="block mt-1 text-xs text-text-secondary">{{ $t('settings.hardwareAcceleration.description') }}</small>
        <p class="mt-2 text-sm" :class="gpuStatus.gpuCompositing ? 'text-success' : 'text-text-secondary'">{{ gpuStatusText }}</p>
        <div v-if="gpuStatus.restartRequired" class="mt-2 flex flex-wrap items-center gap-3">
          <span class="text-sm text-warning">{{ $t('settings.hardwareAcceleration.restartHint') }}</span>
          <button type="button" @click="handleGpuRelaunch"
                  class="px-4 py-2 bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary transition duration-150 ease-in-out text-sm font-medium">
            {{ $t('settings.hardwareAcceleration.restartButton') }}
          </button>
        </div>
        <p v-if="gpuError" class="mt-2 text-sm text-error">{{ gpuError }}</p>
      </div>
      <hr v-if="isElectronRuntime && gpuStatus" class="border-border/50">
      <!-- Timezone Setting -->
      <div class="settings-section-content">
         <h3 class="text-base font-semibold text-foreground mb-3">{{ $t('settings.timezone.title') }}</h3>
         <form @submit.prevent="handleUpdateTimezone" class="space-y-4">
           <div>
             <label for="timezoneSelect" class="block text-sm font-medium text-text-secondary mb-1">{{ $t('settings.timezone.selectLabel') }}</label>
             <select id="timezoneSelect" v-model="selectedTimezone"
                     class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary appearance-none bg-no-repeat bg-right pr-8"
                     style="background-image: url('data:image/svg+xml,%3csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 16 16\'%3e%3cpath fill=\'none\' stroke=\'%236c757d\' stroke-linecap=\'round\' stroke-linejoin=\'round\' stroke-width=\'2\' d=\'M2 5l6 6 6-6\'/%3e%3c/svg%3e'); background-position: right 0.75rem center; background-size: 16px 12px;">
               <option v-for="tz in commonTimezones" :key="tz" :value="tz">
                 {{ tz }}
               </option>
             </select>
              <small class="block mt-1 text-xs text-text-secondary">{{ $t('settings.timezone.description') }}</small>
           </div>
           <div class="flex items-center justify-between">
              <button type="submit"
                      class="px-4 py-2 bg-button text-button-text rounded-md shadow-sm hover:bg-button-hover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary transition duration-150 ease-in-out text-sm font-medium">
                {{ $t('common.save') }}
              </button>
              <p v-if="timezoneMessage" :class="['text-sm', timezoneSuccess ? 'text-success' : 'text-error']">{{ timezoneMessage }}</p>
           </div>
         </form>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useSettingsStore } from '../../stores/settings.store';
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { useSystemSettings } from '../../composables/settings/useSystemSettings';
import { computed, onMounted, ref } from 'vue';

const settingsStore = useSettingsStore();
const { settings } = storeToRefs(settingsStore); 
const { t } = useI18n();
const electronApi = (window as any).electronAPI;
const isElectronRuntime = Boolean(electronApi);
const floatingNotificationBellEnabled = ref(true);
const floatingNotificationBellLoading = ref(false);
const floatingNotificationBellError = ref('');

type GpuStatus = {
  mode: 'auto' | 'on' | 'off';
  useGpu: boolean;
  reason: string;
  gpuCompositing: boolean;
  restartRequired: boolean;
};
const gpuStatus = ref<GpuStatus | null>(null);
const gpuSaving = ref(false);
const gpuError = ref('');
const GPU_REASON_KEYS: Record<string, string> = {
  'setting-off': 'settingOff',
  'cli-flag': 'cliFlag',
  env: 'env',
  'fallback:gpu-crash': 'fallbackGpuCrash',
  'fallback:startup-unconfirmed': 'fallbackStartup',
  'fallback:blank-window': 'fallbackBlank',
  'unconfirmed-launch': 'unconfirmedLaunch',
};
const gpuStatusText = computed(() => {
  const status = gpuStatus.value;
  if (!status) return '';
  if (status.gpuCompositing) return t('settings.hardwareAcceleration.statusEnabled');
  // GPU 已请求开启但 Chromium 未启用合成：多为驱动黑名单或运行中崩溃后的自动回退
  const key = status.useGpu ? 'driver' : (GPU_REASON_KEYS[status.reason] || 'unknown');
  return t('settings.hardwareAcceleration.statusDisabled', { reason: t(`settings.hardwareAcceleration.reasons.${key}`) });
});

const loadGpuStatus = async () => {
  try {
    gpuStatus.value = (await electronApi.getGpuSettings?.()) ?? null;
  } catch {
    gpuError.value = t('settings.hardwareAcceleration.loadFailed');
  }
};

const handleGpuModeChange = async (event: Event) => {
  const mode = (event.target as HTMLSelectElement).value;
  gpuSaving.value = true;
  gpuError.value = '';
  try {
    gpuStatus.value = await electronApi.setGpuSettings(mode);
  } catch {
    gpuError.value = t('settings.hardwareAcceleration.saveFailed');
    await loadGpuStatus();
  } finally {
    gpuSaving.value = false;
  }
};

const handleGpuRelaunch = () => {
  void electronApi.relaunchApp?.();
};

onMounted(async () => {
  if (!isElectronRuntime) return;
  void loadGpuStatus();
  try {
    const result = await electronApi.getFloatingNotificationBellSettings?.();
    floatingNotificationBellEnabled.value = result?.enabled !== false;
  } catch {
    floatingNotificationBellError.value = t('settings.floatingNotificationBell.loadFailed');
  }
});

const handleFloatingNotificationBellChange = async (event: Event) => {
  const enabled = (event.target as HTMLInputElement).checked;
  floatingNotificationBellLoading.value = true;
  floatingNotificationBellError.value = '';
  try {
    const result = await electronApi.setFloatingNotificationBellEnabled?.(enabled);
    if (!result?.ok) throw new Error('Failed to update floating notification bell');
    floatingNotificationBellEnabled.value = result.enabled !== false;
  } catch {
    floatingNotificationBellEnabled.value = !enabled;
    floatingNotificationBellError.value = t('settings.floatingNotificationBell.saveFailed');
  } finally {
    floatingNotificationBellLoading.value = false;
  }
};

const {
  selectedLanguage,
  languageMessage,
  languageSuccess,
  languageNames,
  availableLocales,
  handleUpdateLanguage,
  selectedTimezone,
  timezoneMessage,
  timezoneSuccess,
  commonTimezones,
  handleUpdateTimezone,

} = useSystemSettings();
</script>

