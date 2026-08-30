<template>
  <div class="bg-background border border-border rounded-lg shadow-sm overflow-hidden">
    <h2 class="text-lg font-semibold text-foreground px-6 py-4 border-b border-border bg-header/50">{{ $t('settings.category.about') }}</h2>
    <div class="p-6 space-y-4"> <!-- Reduced space-y for tighter layout -->
       <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-text-secondary"> <!-- Flex container for info items, allow wrap -->
          <span class="font-medium">{{ $t('settings.about.version') }}: {{ appVersion }}</span>
          <span class="text-xs rounded-full border border-border px-2 py-0.5">
            {{ $t(`settings.about.runtime.${runtimeKind}`) }}
          </span>
          <button
            type="button"
            class="inline-flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-50"
            :disabled="isCheckingVersion"
            :title="$t('settings.about.checkNow')"
            @click="checkLatestVersion"
          >
            <i :class="['fas', isCheckingVersion ? 'fa-spinner fa-spin' : 'fa-rotate', 'w-3']" aria-hidden="true"></i>
            {{ $t('settings.about.checkNow') }}
          </button>
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
          <span v-else-if="isUpdateAvailable && latestVersion && runtimeKind !== 'electron'" class="inline-block text-xs ml-2 px-2 py-0.5 rounded-full bg-warning text-white">
            {{ $t('settings.about.updateAvailable', { version: latestVersion }) }}
          </span>
          <button v-else-if="isUpdateAvailable && latestVersion && runtimeKind === 'electron' && updateDownloadUrl"
             type="button"
             :disabled="updateDownloadStatus === 'downloading' || updateDownloadStatus === 'verifying'"
             :title="$t('settings.about.downloadUpdate')"
             @click="downloadUpdate"
             class="inline-flex items-center text-xs ml-2 px-2 py-0.5 rounded-full bg-warning text-white hover:bg-warning/80">
            <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mr-1 h-3 w-3"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>
            {{ $t('settings.about.updateAvailable', { version: latestVersion }) }}
          </button>
          <button v-else-if="isUpdateAvailable && latestVersion && runtimeKind === 'electron'" type="button" @click="openExternal(latestReleaseUrl || 'https://github.com/caichengle666/nexus-terminal/releases')"
             :href="latestReleaseUrl || `https://github.com/caichengle666/nexus-terminal/releases/tag/${latestVersion}`"
             target="_blank" rel="noopener noreferrer"
             class="inline-flex items-center text-xs ml-2 px-2 py-0.5 rounded-full bg-warning text-white hover:bg-warning/80">
            {{ $t('settings.about.updateAvailable', { version: latestVersion }) }}
          </button>
          <span v-if="runtimeKind === 'electron' && updateDownloadStatus === 'downloading'" class="text-xs text-text-secondary">
            {{ $t('settings.about.downloadingUpdate', { progress: updateDownloadProgress ?? 0 }) }}
            <button type="button" class="ml-1 text-error hover:underline" @click="cancelUpdate">{{ $t('settings.about.cancelUpdate') }}</button>
          </span>
          <span v-else-if="runtimeKind === 'electron' && updateDownloadStatus === 'verifying'" class="text-xs text-text-secondary">{{ $t('settings.about.verifyingUpdate') }}</span>
          <span v-else-if="runtimeKind === 'electron' && updateDownloadStatus === 'ready'" class="text-xs text-success">
            {{ $t('settings.about.updateReady') }}
            <button type="button" class="ml-1 text-primary hover:underline" @click="installUpdate">{{ $t('settings.about.installUpdate') }}</button>
          </span>
          <span v-else-if="runtimeKind === 'electron' && updateDownloadStatus === 'failed'" class="text-xs text-error" :title="updateDownloadError || undefined">{{ $t('settings.about.downloadFailed') }}</span>
          <span class="opacity-50">|</span>
          <button type="button" @click="openExternal('https://github.com/caichengle666/nexus-terminal')" class="text-primary hover:underline inline-flex items-center">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" class="mr-1" viewBox="0 0 16 16"> <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8"/> </svg>
            caichengle666/nexus-terminal
          </button>
          <span class="opacity-50">|</span>
          <button type="button" @click="openExternal('https://github.com/Heavrnl/nexus-terminal')" class="text-text-secondary hover:text-primary hover:underline inline-flex items-center" title="Original author">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" class="mr-1" viewBox="0 0 16 16"> <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8"/> </svg>
            原作者：Heavrnl
          </button>
       </div>
       <div v-if="runtimeKind === 'docker'" class="rounded-md border border-border bg-header/40 p-3 text-sm">
         <p class="font-medium text-foreground">{{ $t('settings.about.dockerTitle') }}</p>
         <p class="mt-1 text-text-secondary">{{ $t('settings.about.dockerDescription') }}</p>
         <div class="mt-2 flex flex-wrap items-center gap-2">
           <code class="rounded bg-background px-2 py-1 text-xs text-foreground">{{ dockerUpgradeCommand }}</code>
           <button
             type="button"
             class="inline-flex items-center gap-1 text-xs text-primary hover:underline"
             :title="$t('settings.about.copyDockerCommand')"
             @click="copyDockerUpgradeCommand"
           >
             <i class="fas fa-copy" aria-hidden="true"></i>
             {{ copyStatus === 'copied' ? $t('settings.about.copied') : $t('settings.about.copyDockerCommand') }}
           </button>
         </div>
       </div>
       <div v-else-if="runtimeKind === 'web' || runtimeKind === 'pwa'" class="flex flex-wrap items-center gap-2 text-sm text-text-secondary">
         <span>{{ $t(`settings.about.refreshHint.${runtimeKind}`) }}</span>
         <button type="button" class="text-primary hover:underline" @click="reloadPage">
           <i class="fas fa-rotate mr-1" aria-hidden="true"></i>{{ $t('settings.about.refreshNow') }}
         </button>
       </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useVersionCheck } from '../../composables/settings/useVersionCheck';

const { t } = useI18n(); // $t is available in template, but t can be used in script if needed

const {
  appVersion,
  latestVersion,
  latestReleaseUrl,
  updateDownloadUrl,
  updateDownloadStatus,
  updateDownloadProgress,
  updateDownloadError,
  isCheckingVersion,
  versionCheckError,
  isUpdateAvailable,
  runtimeKind,
  dockerUpgradeCommand,
  checkLatestVersion,
  downloadUpdate,
  cancelUpdate,
  installUpdate,
} = useVersionCheck();

const copyStatus = ref<'idle' | 'copied' | 'error'>('idle');

const openExternal = (url: string) => {
  const electronApi = (window as any).electronAPI;
  if (electronApi?.openExternal) {
    void electronApi.openExternal(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
};

const copyDockerUpgradeCommand = async () => {
  try {
    await navigator.clipboard.writeText(dockerUpgradeCommand);
    copyStatus.value = 'copied';
    window.setTimeout(() => { copyStatus.value = 'idle'; }, 2000);
  } catch {
    copyStatus.value = 'error';
  }
};

const reloadPage = () => window.location.reload();

onMounted(async () => {
  if (!latestVersion.value && !isCheckingVersion.value) {
    await checkLatestVersion();
  }
});
</script>

<style scoped>
/* Styles specific to AboutSection if any */
</style>
