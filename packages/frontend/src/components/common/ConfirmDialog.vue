<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ConfirmDialogDiff } from '../../stores/dialog.store';

interface Props {
  visible: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  isLoading?: boolean;
  /** Optional line diff (AI file writes): widens the dialog and renders the changes. */
  diff?: ConfirmDialogDiff;
}

const props = defineProps<Props>();
const emit = defineEmits(['confirm', 'cancel', 'update:visible']);

const { t } = useI18n();

const dialogVisible = ref(props.visible);

watch(() => props.visible, (newValue) => {
  dialogVisible.value = newValue;
});

watch(dialogVisible, (newValue) => {
  if (newValue !== props.visible) {
    emit('update:visible', newValue);
  }
});

const handleConfirm = () => {
  if (props.isLoading) return;
  emit('confirm');
};

const handleCancel = () => {
  if (props.isLoading) return;
  emit('cancel');
  // 通常取消也应关闭对话框，如果store管理visible，则由store处理
  // emit('update:visible', false); 
};

const handleKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape' && dialogVisible.value && !props.isLoading) {
    handleCancel();
  }
};

watch(dialogVisible, (isVisible) => {
  if (isVisible) {
    document.addEventListener('keydown', handleKeydown);
  } else {
    document.removeEventListener('keydown', handleKeydown);
  }
});

onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleKeydown);
});

</script>

<template>
  <teleport to="body">
    <div
      v-if="dialogVisible"
      class="fixed inset-0 z-[9999] flex items-center justify-center bg-overlay p-4"
      @mousedown.self="handleCancel"
    >
      <div
        class="bg-background text-foreground p-5 rounded-lg shadow-xl border border-border w-full flex flex-col"
        :class="props.diff ? 'confirm-dialog-diff max-w-3xl max-h-[92vh]' : 'max-w-md'"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="props.title"
      >
        <h3 class="text-xl font-semibold mb-4 text-center flex-shrink-0" :id="props.title">
          {{ props.title }}
        </h3>
        <div class="flex-grow mb-6 text-sm" :class="props.diff ? 'flex min-h-0 flex-col' : ''">
          <p class="text-text-secondary whitespace-pre-wrap break-words" :class="props.diff ? 'text-left text-xs leading-relaxed' : 'text-center'">
            {{ props.message }}
          </p>
          <div v-if="props.diff" class="mt-3 flex min-h-0 flex-col rounded border border-border">
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-2.5 py-1.5 text-xs">
              <span class="min-w-0 flex-1 truncate font-mono text-foreground" :title="props.diff.path">{{ props.diff.path }}</span>
              <span v-if="props.diff.isNewFile" class="rounded border border-success/50 px-1.5 py-0.5 text-[10px] text-success">{{ t('aiAssistant.writeFile.newBadge') }}</span>
              <span class="font-mono text-success">+{{ props.diff.added }}</span>
              <span class="font-mono text-error">-{{ props.diff.removed }}</span>
            </div>
            <div class="confirm-diff-body min-h-0 overflow-auto font-mono text-[11px] leading-[1.45]" role="table" :aria-label="t('aiAssistant.writeFile.diffAria')">
              <div v-if="props.diff.lines.length === 0" class="px-3 py-2 text-text-secondary">{{ t('aiAssistant.writeFile.emptyDiff') }}</div>
              <template v-for="(line, index) in props.diff.lines" :key="index">
                <div v-if="line.type === 'skip'" class="confirm-diff-skip px-3 py-0.5 text-text-secondary" role="row">{{ t('aiAssistant.writeFile.skipped', { count: line.count }) }}</div>
                <div v-else class="confirm-diff-line" :class="`is-${line.type}`" role="row">
                  <span class="confirm-diff-no">{{ line.oldNo ?? '' }}</span>
                  <span class="confirm-diff-no">{{ line.newNo ?? '' }}</span>
                  <span class="confirm-diff-sign">{{ line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ' }}</span>
                  <span class="confirm-diff-text">{{ line.text }}</span>
                </div>
              </template>
            </div>
            <div v-if="props.diff.truncated || props.diff.approximate" class="border-t border-border px-2.5 py-1 text-[11px] text-warning">
              {{ props.diff.truncated ? t('aiAssistant.writeFile.truncated') : t('aiAssistant.writeFile.approximate') }}
            </div>
          </div>
        </div>
        <div class="flex justify-end gap-3 flex-shrink-0">
          <button
            @click="handleCancel"
            :disabled="props.isLoading"
            type="button"
            class="px-4 py-2 rounded-md focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-500 dark:focus:ring-offset-background-dark text-sm font-medium transition-colors duration-150 bg-background border border-border/50 text-text-secondary hover:bg-border hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {{ props.cancelText || t('common.cancel', '取消') }}
          </button>
          <button
            @click="handleConfirm"
            :disabled="props.isLoading"
            type="button"
            class="px-4 py-2 text-sm font-medium text-white rounded-md focus:outline-none focus:ring-2 focus:ring-offset-2 dark:focus:ring-offset-background-dark transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center bg-primary hover:bg-primary-hover focus:ring-primary"
          >
            <svg
              v-if="props.isLoading"
              class="animate-spin -ml-1 mr-3 h-5 w-5 text-white"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                class="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                stroke-width="4"
              ></circle>
              <path
                class="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              ></path>
            </svg>
            {{ props.confirmText || t('common.confirm', '确认') }}
          </button>
        </div>
      </div>
    </div>
  </teleport>
</template>

<style scoped>
.confirm-dialog-diff {
  min-height: 0;
}

.confirm-diff-body {
  max-height: min(52vh, 520px);
}

.confirm-diff-line {
  display: grid;
  grid-template-columns: 3.2em 3.2em 1.4em minmax(0, 1fr);
  min-width: max-content;
}

.confirm-diff-no {
  padding-right: 0.5em;
  text-align: right;
  color: var(--text-color-secondary, #94a3b8);
  opacity: 0.7;
  user-select: none;
}

.confirm-diff-sign {
  text-align: center;
  user-select: none;
}

.confirm-diff-text {
  padding-right: 0.75em;
  white-space: pre;
}

.confirm-diff-line.is-add {
  background: color-mix(in srgb, var(--color-success, #22c55e) 16%, transparent);
}

.confirm-diff-line.is-add .confirm-diff-sign {
  color: var(--color-success, #22c55e);
}

.confirm-diff-line.is-del {
  background: color-mix(in srgb, var(--color-error, #ef4444) 16%, transparent);
}

.confirm-diff-line.is-del .confirm-diff-sign {
  color: var(--color-error, #ef4444);
}

.confirm-diff-skip {
  background: color-mix(in srgb, var(--text-color-secondary, #94a3b8) 10%, transparent);
  font-style: italic;
}

@media (max-width: 640px) {
  .confirm-diff-line {
    grid-template-columns: 2.6em 2.6em 1.2em minmax(0, 1fr);
  }
}
</style>
