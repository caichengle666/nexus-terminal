<script setup lang="ts">
import { storeToRefs } from 'pinia';
import { useI18n } from 'vue-i18n';
import { useUiNotificationsStore } from '../stores/uiNotifications.store';

/** 任务通知铃铛按钮：放在顶栏 / 收起顶栏后的标签栏里，点击打开任务通知面板。 */
const { t } = useI18n();
const { unreadTaskCount } = storeToRefs(useUiNotificationsStore());
const open = () => window.dispatchEvent(new Event('open-task-notification-center'));
</script>

<template>
  <button
    type="button"
    class="relative flex items-center justify-center"
    :title="t('taskNotifications.title')"
    :aria-label="t('taskNotifications.title')"
    @click="open"
  >
    <i class="fas fa-bell" aria-hidden="true"></i>
    <span v-if="unreadTaskCount > 0" class="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] leading-none text-white">
      {{ unreadTaskCount > 99 ? '99+' : unreadTaskCount }}
    </span>
  </button>
</template>
