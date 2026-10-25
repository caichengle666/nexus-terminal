<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  parseScriptText,
  type ParsedScriptConnection,
  type ParsedScriptRow,
} from '../../utils/scriptConnectionParser';

/**
 * 脚本批量导入面板（移植自上游 93fc9d79 的 ScriptImportPanel，桌面 / 移动共用）。
 *
 * 只负责「输入 + 实时预检 + 语法说明」，真正的提交在 useAddConnectionForm 里。
 * 粘贴即解析：能导多少台、哪一行有错当场可见；语法说明默认折叠。
 */
const props = withDefaults(
  defineProps<{
    modelValue: string;
    compact?: boolean;
  }>(),
  { compact: false }
);

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
}>();

const { t } = useI18n();

const showSyntax = ref(false);

const text = computed({
  get: () => props.modelValue,
  set: (v: string) => emit('update:modelValue', v),
});

const parsed = computed(() => parseScriptText(props.modelValue || ''));
const errorRows = computed(() => parsed.value.errorRows);
const errorLimit = computed(() => (props.compact ? 3 : 5));
const previewLimit = computed(() => (props.compact ? 3 : 5));

const previewItems = computed(() => {
  const out: Array<{ key: string; item: ParsedScriptConnection }> = [];
  for (const row of parsed.value.rows) {
    row.items.forEach((item, idx) => out.push({ key: `${row.lineIndex}-${idx}`, item }));
  }
  return out;
});
const shownPreview = computed(() => previewItems.value.slice(0, previewLimit.value));
const hiddenPreviewCount = computed(() => Math.max(0, previewItems.value.length - previewLimit.value));

const errorText = (row: ParsedScriptRow) => (row.error ? t(row.error.key, row.error.params ?? {}) : '');

const authLabel = (item: ParsedScriptConnection) => {
  if (item.type === 'SSH' && item.keyName) return `${t('connections.script.authKeyShort', '密钥')} · ${item.keyName}`;
  if (item.type === 'SSH' && !item.password) return t('connections.script.authEmptyPassword', '空密码');
  return t('connections.script.authPasswordShort', '密码');
};

// 示例与写法是代码，不进 i18n（vue-i18n 会把 @ 当链接语法）
const SAMPLE = [
  '# 一行一个连接 / one connection per line',
  'root@10.0.0.5:22 -p "YourPassword" -name gateway -folder prod',
  'ssh -p 2222 deploy@10.0.0.6',
  'admin@10.0.0.10~12 -p pass -note "batch import"',
  'ops@10.0.1.8 -k my-key -jump gateway',
  'Administrator@10.0.0.50 -type RDP -p pass',
].join('\n');

const FORMAT_EXAMPLES = [
  'user@host:port -p PASSWORD',
  'ssh -p 2222 user@host',
  'ssh -l user -i ~/.ssh/id host -name NAME',
  'ssh://user@host:22',
];

const insertSample = () => {
  text.value = text.value.trim() ? `${text.value.replace(/\s+$/, '')}\n${SAMPLE}` : SAMPLE;
};
const clearText = () => {
  text.value = '';
};

const syntaxFlags = computed(() => [
  { flag: '-p / -k', desc: t('connections.script.flagCredential', '密码 / SSH 密钥名（SSH 都不写时按空密码）') },
  { flag: '-name', desc: t('connections.script.flagName', '显示名称') },
  { flag: '-folder', desc: t('connections.script.flagFolder', '所属文件夹，可多个（不存在会自动建；-tags 同义）') },
  { flag: '-note', desc: t('connections.script.flagNote', '备注，吃掉本行剩余内容') },
  { flag: '-type', desc: t('connections.script.flagType', 'SSH / RDP / VNC，默认 SSH') },
  { flag: '-proxy', desc: t('connections.script.flagProxy', '网络代理，按代理名') },
  { flag: '-jump', desc: t('connections.script.flagJump', '跳板机链，按连接名，逗号分隔（仅 SSH）') },
]);
</script>

<template>
  <div class="space-y-2.5" data-testid="script-import-panel">
    <!-- 工具栏：实时统计 + 示例 / 清空 -->
    <div class="flex items-center justify-between gap-2 flex-wrap">
      <div class="flex items-center gap-1.5 flex-wrap text-[11px]">
        <span
          class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border"
          :class="parsed.validConnections.length > 0
            ? 'text-success border-success/40 bg-success/10'
            : 'text-text-secondary border-border/60 bg-border/10'"
          data-testid="script-stat-ok"
        >
          <i class="fas fa-plug text-[10px]"></i>
          {{ t('connections.script.statConnections', { count: parsed.validConnections.length }) }}
        </span>
        <span v-if="errorRows.length" class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border border-error/40 bg-error/10 text-error" data-testid="script-stat-errors">
          <i class="fas fa-triangle-exclamation text-[10px]"></i>
          {{ t('connections.script.statErrors', { count: errorRows.length }) }}
        </span>
        <span v-if="parsed.skippedLines" class="text-text-secondary">
          {{ t('connections.script.statSkipped', { count: parsed.skippedLines }) }}
        </span>
      </div>

      <div class="flex items-center gap-1">
        <button
          type="button"
          class="text-[11px] font-medium text-primary px-1.5 py-0.5 rounded-md hover:bg-primary/10 transition-colors cursor-pointer"
          @click="insertSample"
        >
          <i class="fas fa-wand-magic-sparkles text-[10px] mr-1"></i>{{ t('connections.script.insertSample', '插入示例') }}
        </button>
        <button
          v-if="modelValue"
          type="button"
          class="text-[11px] text-text-secondary hover:text-foreground px-1.5 py-0.5 rounded-md hover:bg-border/40 transition-colors cursor-pointer"
          @click="clearText"
        >
          {{ t('connections.script.clear', '清空') }}
        </button>
      </div>
    </div>

    <textarea
      id="conn-script-input"
      v-model="text"
      :rows="compact ? 6 : 8"
      wrap="off"
      spellcheck="false"
      autocapitalize="off"
      autocomplete="off"
      class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground font-mono text-xs leading-relaxed focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary resize-y"
      :placeholder="t('connections.script.placeholder', '一行一个连接，例如：root@10.0.0.5 -p 密码 -folder 生产')"
    ></textarea>

    <!-- 错误行：当场指出第几行、错在哪 -->
    <div v-if="errorRows.length" class="rounded-md border border-error/30 bg-error/5 p-2 space-y-1" data-testid="script-error-list">
      <div
        v-for="row in errorRows.slice(0, errorLimit)"
        :key="row.lineIndex"
        class="flex items-start gap-1.5 text-[11px] leading-relaxed"
      >
        <span class="shrink-0 font-mono text-error">{{ t('connections.script.lineLabel', { line: row.lineIndex }) }}</span>
        <span class="text-error min-w-0 break-words">{{ errorText(row) }}</span>
      </div>
      <div v-if="errorRows.length > errorLimit" class="text-[11px] text-error">
        {{ t('connections.script.moreErrors', { count: errorRows.length - errorLimit }) }}
      </div>
    </div>

    <!-- 预览：确认无误再提交 -->
    <div v-if="shownPreview.length" class="rounded-md border border-border/60 overflow-hidden" data-testid="script-preview">
      <div
        v-for="row in shownPreview"
        :key="row.key"
        class="flex items-center gap-2 px-2.5 py-1.5 text-[11px] border-b border-border/40 last:border-b-0"
      >
        <i
          :class="[
            'fas shrink-0 text-[10px]',
            row.item.type === 'SSH' ? 'fa-terminal text-emerald-500'
              : row.item.type === 'RDP' ? 'fa-desktop text-blue-500'
              : 'fa-eye text-purple-500',
          ]"
        ></i>
        <span class="font-medium text-foreground truncate min-w-0">{{ row.item.name }}</span>
        <span class="font-mono text-text-secondary shrink-0" :class="compact ? 'hidden' : ''">{{ row.item.host }}:{{ row.item.port }}</span>
        <span class="ml-auto flex items-center gap-1 shrink-0">
          <span v-if="row.item.tags.length" class="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-500 max-w-[7rem] truncate">
            <i class="fas fa-folder text-[9px] mr-0.5"></i>{{ row.item.tags[0] }}
          </span>
          <span v-if="row.item.jumpNames.length" class="px-1.5 py-0.5 rounded bg-border/30 text-text-secondary">
            <i class="fas fa-route text-[9px] mr-0.5"></i>{{ row.item.jumpNames.length }}
          </span>
          <span class="px-1.5 py-0.5 rounded bg-primary/10 text-primary">{{ authLabel(row.item) }}</span>
        </span>
      </div>
      <div v-if="hiddenPreviewCount" class="px-2.5 py-1.5 text-[11px] text-text-secondary bg-border/10">
        {{ t('connections.script.morePreview', { count: hiddenPreviewCount }) }}
      </div>
    </div>

    <!-- 语法说明：默认折叠 -->
    <div>
      <button
        type="button"
        class="flex items-center gap-1 text-[11px] text-text-secondary hover:text-foreground transition-colors cursor-pointer"
        :aria-expanded="showSyntax"
        @click="showSyntax = !showSyntax"
      >
        <i :class="['fas text-[9px] transition-transform', showSyntax ? 'fa-chevron-down' : 'fa-chevron-right']"></i>
        <span>{{ t('connections.script.syntaxTitle', '支持的写法与参数') }}</span>
      </button>
      <div v-if="showSyntax" class="mt-1.5 rounded-md border border-border/60 bg-border/10 p-2.5 space-y-2" data-testid="script-syntax">
        <div class="space-y-1">
          <div class="text-[11px] font-medium text-foreground">{{ t('connections.script.syntaxFormats', '常见写法') }}</div>
          <div class="text-[11px] font-mono text-text-secondary leading-relaxed break-all">
            <div v-for="line in FORMAT_EXAMPLES" :key="line">{{ line }}</div>
            <div><span class="text-amber-500">user@10.0.0.10~12</span> {{ t('connections.script.syntaxRangeHint', '（IP 范围会展开成多台）') }}</div>
          </div>
        </div>
        <div class="space-y-1">
          <div class="text-[11px] font-medium text-foreground">{{ t('connections.script.syntaxFlags', '可用参数') }}</div>
          <div class="grid gap-1" :class="compact ? 'grid-cols-1' : 'grid-cols-2'">
            <div v-for="f in syntaxFlags" :key="f.flag" class="flex items-baseline gap-1.5 text-[11px]">
              <code class="font-mono text-primary shrink-0">{{ f.flag }}</code>
              <span class="text-text-secondary min-w-0">{{ f.desc }}</span>
            </div>
          </div>
        </div>
        <div class="text-[11px] text-text-secondary">
          {{ t('connections.script.syntaxCommentHint', '# 或 // 开头的行会被跳过；密码里有空格时用双引号包起来') }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* style.css 里 i/.fas 有全局 color: var(--icon-color)，这里让图标继承所在文字的颜色 */
i {
  color: inherit;
}
</style>
