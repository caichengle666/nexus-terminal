<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';

/**
 * 自绘窗口按钮（最小化 / 最大化 / 置顶 / 关闭）。
 * 只在 Electron 客户端里渲染：网页版没有 electronAPI，这些按钮点了也没用。
 * 顶栏显示时放在顶栏右侧；顶栏收起时由工作区标签栏放在同一行最右侧（不再悬浮覆盖标签栏按钮）。
 */
withDefaults(defineProps<{ compact?: boolean }>(), { compact: false });

const { t } = useI18n();
// 注: preload 目前没有提供读取当前置顶状态的接口，初始状态依赖主进程推送的 always-on-top-changed 事件。
const electronApi = (window as any).electronAPI;
const isElectron = Boolean(electronApi?.minimizeWindow);
const isAlwaysOnTop = ref(false);
let removeListener: (() => void) | undefined;

onMounted(() => {
  removeListener = electronApi?.receiveMessage?.('always-on-top-changed', (value: boolean) => {
    isAlwaysOnTop.value = Boolean(value);
  });
});
onUnmounted(() => removeListener?.());

const minimizeWindow = () => electronApi?.minimizeWindow?.();
const toggleMaximizeWindow = () => electronApi?.toggleMaximizeWindow?.();
const toggleAlwaysOnTop = () => electronApi?.toggleAlwaysOnTop?.();
const closeWindow = () => electronApi?.closeWindow?.();
</script>

<template>
  <div v-if="isElectron" class="window-control-group" :class="{ compact }">
    <button class="window-control-button" type="button" :title="t('windowControls.minimize')" :aria-label="t('windowControls.minimize')" @click="minimizeWindow">
      <span class="window-control-icon minimize-icon"></span>
    </button>
    <button class="window-control-button" type="button" :title="t('windowControls.maximizeRestore')" :aria-label="t('windowControls.maximizeRestore')" @click="toggleMaximizeWindow">
      <span class="window-control-icon maximize-icon"></span>
    </button>
    <button
      class="window-control-button"
      type="button"
      :class="{ 'always-on-top-active': isAlwaysOnTop }"
      :title="isAlwaysOnTop ? t('windowControls.unpin') : t('windowControls.pin')"
      :aria-label="isAlwaysOnTop ? t('windowControls.unpin') : t('windowControls.pin')"
      :aria-pressed="isAlwaysOnTop"
      @click="toggleAlwaysOnTop"
    >
      <i class="fas fa-thumbtack text-xs" aria-hidden="true"></i>
    </button>
    <button class="window-control-button close-window-button" type="button" :title="t('windowControls.close')" :aria-label="t('windowControls.close')" @click="closeWindow">
      <span class="window-control-icon close-icon"></span>
    </button>
  </div>
</template>

<style scoped>
.window-control-group {
  display: flex;
  align-items: stretch;
  height: 100%;
  flex-shrink: 0;
  -webkit-app-region: no-drag;
}

.window-control-button {
  width: 46px;
  height: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  background: transparent;
  color: var(--text-color, var(--foreground, #f3f4f6));
  cursor: default;
  -webkit-app-region: no-drag;
}

.window-control-button:hover {
  background: rgba(255, 255, 255, 0.12);
}

.window-control-button.always-on-top-active {
  background: var(--link-active-bg-color, rgba(59, 130, 246, 0.2));
  color: var(--link-active-color, #60a5fa);
}

.close-window-button:hover {
  background: #c42b1c;
  color: #fff;
}

.window-control-icon {
  position: relative;
  width: 14px;
  height: 14px;
  display: inline-block;
}

.minimize-icon::before {
  content: '';
  position: absolute;
  left: 1px;
  right: 1px;
  bottom: 3px;
  height: 1.5px;
  background: currentColor;
}

.maximize-icon::before {
  content: '';
  position: absolute;
  inset: 1px;
  border: 1.5px solid currentColor;
  border-radius: 2px;
}

.close-icon::before,
.close-icon::after {
  content: '';
  position: absolute;
  top: 6px;
  left: 0;
  width: 14px;
  height: 1.5px;
  background: currentColor;
}

.close-icon::before {
  transform: rotate(45deg);
}

.close-icon::after {
  transform: rotate(-45deg);
}

.window-control-group.compact .window-control-button {
  width: 40px;
}
</style>
