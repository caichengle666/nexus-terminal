<script setup lang="ts">
import { computed } from 'vue';
import { buildSandboxedHtmlDocument, TERMINAL_HTML_SANDBOX } from '../../features/appearance/sandboxed-html';

/**
 * 在沙箱 iframe 中渲染不受信任的背景 HTML (终端自定义背景 / 预设预览)。
 * 脚本可运行但处于不透明源，无法访问应用；iframe 不接收指针事件，透明背景铺满父容器。
 */
const props = defineProps<{ html: string | null | undefined }>();

const srcdoc = computed(() => buildSandboxedHtmlDocument(props.html));
</script>

<template>
  <iframe
    class="sandboxed-html-frame"
    :sandbox="TERMINAL_HTML_SANDBOX"
    :srcdoc="srcdoc"
    title=""
    aria-hidden="true"
    tabindex="-1"
    referrerpolicy="no-referrer"
    loading="eager"
  ></iframe>
</template>

<style scoped>
.sandboxed-html-frame {
  display: block;
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: 0;
  margin: 0;
  padding: 0;
  background: transparent;
  color-scheme: normal;
  pointer-events: none;
}
</style>
