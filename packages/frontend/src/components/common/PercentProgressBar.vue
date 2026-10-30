<script setup lang="ts">
import { computed } from 'vue';
import { ElProgress } from 'element-plus';

/**
 * 带百分比文字的进度条。
 * Element Plus 的 text-inside 把文字放在填充条里并固定为白色，进度很低时填充盖不住文字，
 * 浅色主题下白字落在浅色底槽上就看不见了。这里把文字画两层：底层用主题前景色，
 * 上层白字按填充宽度裁剪 (clip-path)，所以文字落在底槽上的部分是前景色、落在填充上的部分是白色，
 * 深色 / 浅色 / 毛玻璃主题在任意进度下都可读。
 */
const props = withDefaults(defineProps<{
  percentage: number;
  color?: string;
  strokeWidth?: number;
  noTransition?: boolean;
}>(), {
  color: '#3b82f6',
  strokeWidth: 16,
  noTransition: false,
});

const clamped = computed(() => {
  const value = Number(props.percentage);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
});
const label = computed(() => `${Math.round(clamped.value)}%`);
const fillClip = computed(() => `inset(0 ${100 - clamped.value}% 0 0)`);
</script>

<template>
  <div class="percent-progress-bar" :class="{ 'no-transition': noTransition }" :style="{ height: `${strokeWidth}px` }">
    <el-progress
      :percentage="clamped"
      :stroke-width="strokeWidth"
      :color="color"
      :show-text="false"
      class="percent-progress-bar__bar"
    />
    <span class="percent-progress-bar__label percent-progress-bar__label--track" aria-hidden="true">{{ label }}</span>
    <span class="percent-progress-bar__label percent-progress-bar__label--fill" :style="{ clipPath: fillClip }" aria-hidden="true">{{ label }}</span>
  </div>
</template>

<style scoped>
.percent-progress-bar {
  position: relative;
  /* 文字是绝对定位的，不撑宽度；和右侧的内存/磁盘明细并排时给个基准宽度，避免进度条被挤成 0 */
  flex: 1 1 3rem;
  min-width: 2.5rem;
}
.percent-progress-bar__bar {
  width: 100%;
}
.percent-progress-bar :deep(.el-progress-bar__outer) {
  background-color: var(--header-bg-color) !important;
}
.percent-progress-bar :deep(.el-progress-bar__inner) {
  transition: width 0.3s ease-in-out;
}
.percent-progress-bar__label {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  pointer-events: none;
  user-select: none;
}
.percent-progress-bar__label--track {
  color: var(--text-color);
}
.percent-progress-bar__label--fill {
  color: #fff;
  /* 黄色 / 绿色填充上白字偏淡，加一圈很淡的暗描边提高对比 */
  text-shadow: 0 0 2px rgba(0, 0, 0, 0.45);
  transition: clip-path 0.3s ease-in-out;
}
.percent-progress-bar.no-transition :deep(.el-progress-bar__inner),
.percent-progress-bar.no-transition .percent-progress-bar__label--fill {
  transition: none !important;
}
</style>
