<script setup lang="ts">
import { ref, computed, watch, type PropType, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import type { FileListItem } from '../types/sftp.types';
import FilePermissionEditor from './FilePermissionEditor.vue';

/** 确认时回传：value 为新名称 / 八进制权限；chmod 额外带 owner / group（空 = 不修改） */
export interface FileManagerActionConfirmPayload {
  value: string;
  owner?: string;
  group?: string;
}

const props = defineProps({
  isVisible: {
    type: Boolean,
    required: true,
  },
  actionType: {
    type: String as PropType<'delete' | 'rename' | 'chmod' | 'newFile' | 'newFolder' | null>,
    default: null,
  },
  item: { // Used for delete, rename, chmod
    type: Object as PropType<FileListItem | null>,
    default: null,
  },
  items: { // Used for multi-item delete
    type: Array as PropType<FileListItem[]>,
    default: () => [],
  },
  initialValue: { // For pre-filling input, e.g., old name for rename, current perms for chmod
    type: String,
    default: '',
  }
});

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'confirm', payload?: FileManagerActionConfirmPayload): void; // For delete, value is empty.
}>();

const { t } = useI18n();
const inputValue = ref('');
const inputRef = ref<HTMLInputElement | null>(null);
/** 所有者 / 所属组：每次打开都从空开始，留空 = 不修改 */
const ownerValue = ref('');
const groupValue = ref('');
const isChmodAction = computed(() => props.actionType === 'chmod');
/** 批量修改权限时的目标数量（>1 时标题与提示显示数量） */
const chmodTargetCount = computed(() => (props.actionType === 'chmod' ? Math.max(props.items.length, props.item ? 1 : 0) : 0));
const currentUid = computed(() => (chmodTargetCount.value === 1 ? (props.item?.attrs?.uid ?? null) : null) as number | null);
const currentGid = computed(() => (chmodTargetCount.value === 1 ? (props.item?.attrs?.gid ?? null) : null) as number | null);
const CHOWN_NAME_RE = /^([0-9]{1,10}|[A-Za-z0-9_][A-Za-z0-9_.-]{0,63})$/;
const chownInputsInvalid = computed(() =>
  (!!ownerValue.value.trim() && !CHOWN_NAME_RE.test(ownerValue.value.trim()))
  || (!!groupValue.value.trim() && !CHOWN_NAME_RE.test(groupValue.value.trim())));

watch(() => props.isVisible, (newValue) => {
  if (newValue) {
    inputValue.value = props.initialValue || '';
    ownerValue.value = '';
    groupValue.value = '';
    nextTick(() => {
      inputRef.value?.focus();
      inputRef.value?.select();
    });
    document.addEventListener('keydown', handleGlobalKeydown);
  } else {
    document.removeEventListener('keydown', handleGlobalKeydown);
  }
});

const modalTitle = computed(() => {
  switch (props.actionType) {
    case 'delete':
      if (props.items.length > 1) {
        return t('fileManager.modals.titles.deleteMultiple', { count: props.items.length });
      } else if (props.items.length === 1) {
        // 当删除单个项目时，从 props.items[0] 获取文件名
        return t('fileManager.modals.titles.delete', { name: props.items[0]?.filename || '' });
      } else {
        // Fallback or error case if items is empty, though this shouldn't happen for delete
        return t('fileManager.modals.titles.delete', { name: '' });
      }
    case 'rename':
      return t('fileManager.modals.titles.rename', { name: props.item?.filename || '' });
    case 'chmod':
      if (chmodTargetCount.value > 1) return t('fileManager.modals.titles.chmodMultiple', { count: chmodTargetCount.value });
      return t('fileManager.modals.titles.chmod', { name: props.item?.filename || '' });
    case 'newFile':
      return t('fileManager.modals.titles.newFile', 'Create New File');
    case 'newFolder':
      return t('fileManager.modals.titles.newFolder', 'Create New Folder');
    default:
      return '';
  }
});

const confirmButtonText = computed(() => {
  switch (props.actionType) {
    case 'delete':
      return t('fileManager.modals.buttons.delete', 'Delete');
    case 'rename':
      return t('fileManager.modals.buttons.rename', 'Rename');
    case 'chmod':
      return t('fileManager.modals.buttons.changePermissions', 'Set Permissions');
    case 'newFile':
    case 'newFolder':
      return t('fileManager.modals.buttons.create', 'Create');
    default:
      return t('fileManager.modals.buttons.confirm', 'Confirm');
  }
});

const messageText = computed(() => {
  if (props.actionType === 'delete') {
    if (props.items.length > 1) {
      const names = props.items.map(i => i.filename).join(', ');
      return t('fileManager.modals.messages.confirmDeleteMultiple', { count: props.items.length, names: names });
    } else if (props.items.length === 1 && props.items[0]) {
      // 当删除单个项目时，从 props.items[0] 获取信息
      const singleItem = props.items[0];
      const type = singleItem.attrs.isDirectory
        ? t('fileManager.modals.labels.folder', 'folder')
        : t('fileManager.modals.labels.file', 'file');
      return t('fileManager.modals.messages.confirmDelete', { type: type, name: singleItem.filename });
    }
  }
  return '';
});

const showInput = computed(() => {
  return ['rename', 'chmod', 'newFile', 'newFolder'].includes(props.actionType || '');
});

const inputLabel = computed(() => {
  switch (props.actionType) {
    case 'rename':
      return t('fileManager.modals.labels.newName', 'New name:');
    case 'chmod':
      return t('fileManager.modals.labels.newPermissions', 'New permissions (octal):');
    case 'newFile':
      return t('fileManager.modals.labels.fileName', 'File name:');
    case 'newFolder':
      return t('fileManager.modals.labels.folderName', 'Folder name:');
    default:
      return '';
  }
});

const inputPlaceholder = computed(() => {
  switch (props.actionType) {
    case 'rename':
      return props.item?.filename || t('fileManager.modals.placeholders.newName', 'Enter new name');
    case 'chmod':
      return props.initialValue || '0755';
    case 'newFile':
      return t('fileManager.modals.placeholders.newFile', 'Enter file name');
    case 'newFolder':
      return t('fileManager.modals.placeholders.newFolder', 'Enter folder name');
    default:
      return '';
  }
});

const isConfirmDisabled = computed(() => {
  if (!showInput.value) return false; // For delete, button is never disabled by input
  if (!inputValue.value.trim()) return true; // Disable if input is empty
  if (props.actionType === 'rename' && inputValue.value.trim() === props.item?.filename) return true; // Disable if name is unchanged
  if (props.actionType === 'chmod' && !/^[0-7]{3,4}$/.test(inputValue.value.trim())) return true; // Disable for invalid chmod format
  if (props.actionType === 'chmod' && chownInputsInvalid.value) return true;
  return false;
});


const closeModal = () => {
  emit('close');
};

const confirmAction = () => {
  if (isConfirmDisabled.value && showInput.value) return; // Re-check, though button should be disabled

  if (props.actionType === 'chmod' && inputValue.value.trim() && !/^[0-7]{3,4}$/.test(inputValue.value.trim())) {
    // This case should ideally be handled by disabling the button, but as a fallback:
    // Consider showing an inline error message instead of alert
    console.warn('Invalid chmod format submitted');
    return;
  }
  if (props.actionType === 'chmod') {
    emit('confirm', { value: inputValue.value.trim(), owner: ownerValue.value.trim(), group: groupValue.value.trim() });
    return;
  }
  emit('confirm', { value: inputValue.value.trim() });
  // closeModal(); // Parent component will close it after action
};

const handleGlobalKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    closeModal();
  } else if (event.key === 'Enter' && props.isVisible) {
    if (showInput.value) {
      if (!isConfirmDisabled.value) {
        confirmAction();
      }
    } else { // For delete confirmation
      confirmAction();
    }
  }
};

import { onUnmounted } from 'vue';
onUnmounted(() => {
  document.removeEventListener('keydown', handleGlobalKeydown);
});

</script>

<template>
  <div v-if="isVisible" class="fixed inset-0 bg-overlay flex justify-center items-center z-[100] p-4" @click.self="closeModal">
    <div class="bg-background text-foreground p-5 rounded-lg shadow-xl border border-border w-full flex flex-col relative max-h-full"
         :class="isChmodAction ? 'max-w-lg' : 'max-w-md'">
      <!-- Close Button -->
      <button class="absolute top-3 right-3 p-1 text-text-secondary hover:text-foreground z-10" @click="closeModal" :title="t('fileManager.modals.buttons.close', 'Close')">
         <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
           <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
         </svg>
      </button>

      <!-- Title -->
      <h3 class="text-xl font-semibold text-center mb-4 flex-shrink-0">{{ modalTitle }}</h3>

      <!-- Content -->
      <!-- 内容区自己滚动：弹窗外框保持不滚，毛玻璃底层 (::before) 才能完整覆盖 -->
      <div class="flex-grow min-h-0 overflow-y-auto mb-6 text-sm">
        <p v-if="actionType === 'delete'" class="text-center whitespace-pre-wrap">
          {{ messageText }}
        </p>

        <template v-if="isChmodAction">
          <p v-if="chmodTargetCount > 1" class="mb-3 text-xs text-text-secondary">
            {{ t('fileManager.permissions.batchHint', { count: chmodTargetCount }) }}
          </p>
          <FilePermissionEditor
            v-model:mode="inputValue"
            v-model:owner="ownerValue"
            v-model:group="groupValue"
            :current-uid="currentUid"
            :current-gid="currentGid"
          />
        </template>

        <div v-else-if="showInput">
          <label :for="`fileManagerActionInput-${actionType}`" class="block text-sm font-medium text-text-secondary mb-1">
            {{ inputLabel }}
          </label>
          <input
            :id="`fileManagerActionInput-${actionType}`"
            ref="inputRef"
            type="text"
            v-model="inputValue"
            :placeholder="inputPlaceholder"
            class="w-full px-3 py-2 bg-input border border-border rounded-md shadow-sm focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary sm:text-sm text-foreground"
          />
          <p v-if="actionType === 'chmod' && inputValue.trim() && !/^[0-7]{3,4}$/.test(inputValue.trim())" class="mt-1 text-xs text-red-500">
            {{ t('fileManager.errors.invalidPermissionsFormat', 'Invalid octal format (e.g., 755 or 0755).') }}
          </p>
           <p v-else-if="actionType === 'chmod'" class="mt-1 text-xs text-text-tertiary">
            {{ t('fileManager.modals.chmodHelp', 'Enter permissions in octal format (e.g., 755 or 0755).') }}
          </p>
        </div>
      </div>

      <!-- Actions -->
      <div class="flex justify-end gap-3 flex-shrink-0">
        <button
          @click="closeModal"
          type="button"
          class="px-4 py-2 rounded-md focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-500 dark:focus:ring-offset-background-dark text-sm font-medium transition-colors duration-150 bg-background border border-border/50 text-text-secondary hover:bg-border hover:text-foreground"
        >
          {{ t('fileManager.modals.buttons.cancel', 'Cancel') }}
        </button>
        <button
          @click="confirmAction"
          type="button"
          :disabled="isConfirmDisabled"
          class="px-4 py-2 text-sm font-medium text-white rounded-md focus:outline-none focus:ring-2 focus:ring-offset-2 dark:focus:ring-offset-background-dark transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          :class="{
            'bg-red-600 hover:bg-red-700 focus:ring-red-500': actionType === 'delete',
            'bg-primary hover:bg-primary-hover focus:ring-primary': actionType !== 'delete'
          }"
        >
          {{ confirmButtonText }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Styles can be further refined or rely on global Tailwind utility classes */
</style>