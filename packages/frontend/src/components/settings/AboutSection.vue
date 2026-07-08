<template>
  <div class="bg-background border border-border rounded-lg shadow-sm overflow-hidden">
    <h2 class="text-lg font-semibold text-foreground px-6 py-4 border-b border-border bg-header/50">{{ $t('settings.category.about') }}</h2>
    <div class="p-6 space-y-4"> <!-- Reduced space-y for tighter layout -->
       <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-text-secondary"> <!-- Flex container for info items, allow wrap -->
          <span class="font-medium">{{ $t('settings.about.version') }}: {{ appVersion }}</span>
          <!-- Version Check Status -->
          <span v-if="isCheckingVersion" class="inline-block text-xs ml-2 px-2 py-0.5 rounded-full bg-blue-500 text-white italic">
            {{ $t('settings.about.checkingUpdate') }}
          </span>
          <span v-else-if="versionCheckError" class="inline-block text-xs ml-2 px-2 py-0.5 rounded-full bg-error text-white" :title="versionCheckError">
            {{ $t('settings.about.error.checkFailedShort') }}
          </span>
          <span v-else-if="!isUpdateAvailable && latestVersion" class="inline-block text-xs ml-2 px-2 py-0.5 rounded-full bg-success text-white">
            {{ $t('settings.about.latestVersion') }}
          </span>
          <a v-else-if="isUpdateAvailable && latestVersion"
             :href="`https://github.com/caichengle666/nexus-terminal/releases/tag/${latestVersion}`"
             target="_blank" rel="noopener noreferrer"
             class="inline-flex items-center text-xs ml-2 px-2 py-0.5 rounded-full bg-warning text-white hover:bg-warning/80">
            <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mr-1 h-3 w-3"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>
            {{ $t('settings.about.updateAvailable', { version: latestVersion }) }}
          </a>
          <span class="opacity-50">|</span>
          <a href="https://github.com/caichengle666/nexus-terminal" target="_blank" rel="noopener noreferrer" class="text-primary hover:underline inline-flex items-center">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" class="mr-1" viewBox="0 0 16 16"> <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8"/> </svg>
            caichengle666/nexus-terminal
          </a>
       </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useVersionCheck } from '../../composables/settings/useVersionCheck';

const { t } = useI18n(); // $t is available in template, but t can be used in script if needed

const {
  appVersion,
  latestVersion,
  isCheckingVersion,
  versionCheckError,
  isUpdateAvailable,
  checkLatestVersion,
} = useVersionCheck();

onMounted(async () => {
  await checkLatestVersion();
});
</script>

<style scoped>
/* Styles specific to AboutSection if any */
</style>
