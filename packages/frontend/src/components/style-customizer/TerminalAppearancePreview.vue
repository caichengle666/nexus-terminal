<script setup lang="ts">
import { computed } from 'vue';
import type { CSSProperties } from 'vue';
import type { ITheme } from '@xterm/xterm';
import { defaultXtermTheme } from '../../features/appearance/config/default-themes';

const props = withDefaults(defineProps<{
  theme?: ITheme;
  fontFamily?: string;
  fontSize?: number;
  textStrokeEnabled?: boolean;
  textStrokeWidth?: number;
  textStrokeColor?: string;
  textShadowEnabled?: boolean;
  textShadowOffsetX?: number;
  textShadowOffsetY?: number;
  textShadowBlur?: number;
  textShadowColor?: string;
  backgroundEnabled?: boolean;
  backgroundImage?: string | null;
  overlayOpacity?: number;
  customHtml?: string | null;
}>(), {
  fontFamily: 'Consolas, "Courier New", monospace',
  fontSize: 14,
  textStrokeEnabled: false,
  textStrokeWidth: 1,
  textStrokeColor: '#000000',
  textShadowEnabled: false,
  textShadowOffsetX: 0,
  textShadowOffsetY: 0,
  textShadowBlur: 0,
  textShadowColor: 'rgba(0,0,0,0.5)',
  backgroundEnabled: false,
  backgroundImage: null,
  overlayOpacity: 0.5,
  customHtml: null,
});

const resolvedTheme = computed<ITheme>(() => ({ ...defaultXtermTheme, ...(props.theme || {}) }));

const resolvedBackgroundImage = computed(() => {
  if (!props.backgroundEnabled || !props.backgroundImage) return 'none';
  const imagePath = props.backgroundImage;
  const baseUrl = import.meta.env.VITE_API_BASE_URL || window.location.origin;
  const fullUrl = /^(blob:|data:|https?:)/i.test(imagePath) ? imagePath : `${baseUrl}${imagePath}`;
  return `url("${fullUrl.replace(/"/g, '\\"')}")`;
});

const terminalStyle = computed<CSSProperties>(() => ({
  backgroundColor: props.backgroundEnabled ? 'transparent' : resolvedTheme.value.background,
  color: resolvedTheme.value.foreground,
  fontFamily: props.fontFamily,
  fontSize: `${Math.min(Math.max(props.fontSize, 10), 20)}px`,
  WebkitTextStroke: props.textStrokeEnabled
    ? `${props.textStrokeWidth}px ${props.textStrokeColor}`
    : undefined,
  textShadow: props.textShadowEnabled
    ? `${props.textShadowOffsetX}px ${props.textShadowOffsetY}px ${props.textShadowBlur}px ${props.textShadowColor}`
    : undefined,
}));
</script>

<template>
  <div class="overflow-hidden rounded border border-border bg-black shadow-sm" aria-label="终端预览">
    <div class="flex h-8 items-center gap-1.5 border-b border-white/10 bg-black/75 px-3">
      <span class="h-2.5 w-2.5 rounded-full bg-[#ff5f57]"></span>
      <span class="h-2.5 w-2.5 rounded-full bg-[#febc2e]"></span>
      <span class="h-2.5 w-2.5 rounded-full bg-[#28c840]"></span>
      <span class="ml-2 text-xs text-white/65">root@nexus-terminal</span>
    </div>
    <div
      class="relative h-[150px] overflow-hidden bg-cover bg-center bg-no-repeat md:h-[180px]"
      :style="{ backgroundColor: resolvedTheme.background, backgroundImage: resolvedBackgroundImage }"
    >
      <div
        v-if="backgroundEnabled"
        class="absolute inset-0 z-[1]"
        :style="{ backgroundColor: `rgba(0, 0, 0, ${overlayOpacity})` }"
      ></div>
      <div
        v-if="backgroundEnabled && customHtml"
        class="pointer-events-none absolute inset-0 z-[2] overflow-hidden"
        v-html="customHtml"
      ></div>
      <div class="absolute inset-0 z-[3] select-none overflow-hidden p-4 leading-relaxed" :style="terminalStyle">
        <div><span :style="{ color: resolvedTheme.green }">root@nexus-terminal</span>:<span :style="{ color: resolvedTheme.blue }">~</span># systemctl status ssh</div>
        <div><span :style="{ color: resolvedTheme.green }">●</span> ssh.service - OpenBSD Secure Shell server</div>
        <div>&nbsp;&nbsp;&nbsp;Active: <span :style="{ color: resolvedTheme.brightGreen || resolvedTheme.green }">active (running)</span></div>
        <div>&nbsp;&nbsp;&nbsp;Memory: <span :style="{ color: resolvedTheme.cyan }">8.4M</span></div>
        <div><span :style="{ color: resolvedTheme.green }">root@nexus-terminal</span>:<span :style="{ color: resolvedTheme.blue }">~</span># <span class="inline-block h-[1.05em] w-[0.55em] translate-y-[0.18em]" :style="{ backgroundColor: resolvedTheme.cursor || resolvedTheme.foreground }"></span></div>
      </div>
    </div>
  </div>
</template>
