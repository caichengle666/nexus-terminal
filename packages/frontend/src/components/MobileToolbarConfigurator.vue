<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import draggable from 'vuedraggable';
import { useSettingsStore } from '../stores/settings.store';
import {
  defaultMobileToolbarItems,
  mobileToolbarModules,
  type MobileToolbarModuleId,
} from '../features/mobile-toolbar/mobile-toolbar';

const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{ (event: 'close'): void }>();
const settingsStore = useSettingsStore();
const activeItems = ref<MobileToolbarModuleId[]>([]);
const isSaving = ref(false);
const errorMessage = ref('');

const moduleById = new Map(mobileToolbarModules.map(module => [module.id, module]));
const mobileToolbarItemKey = (item: MobileToolbarModuleId) => item;
const activeModules = computed(() => activeItems.value.map(id => moduleById.get(id)).filter(Boolean));
const availableModules = computed(() => mobileToolbarModules.filter(module => !activeItems.value.includes(module.id)));

watch(() => props.visible, visible => {
  if (!visible) return;
  activeItems.value = [...settingsStore.mobileToolbarItems];
  errorMessage.value = '';
});

const addModule = (moduleId: MobileToolbarModuleId) => {
  if (!activeItems.value.includes(moduleId)) activeItems.value.push(moduleId);
};

const removeModule = (moduleId: MobileToolbarModuleId) => {
  if (moduleById.get(moduleId)?.required) return;
  activeItems.value = activeItems.value.filter(id => id !== moduleId);
};

const restoreDefault = () => {
  activeItems.value = [...defaultMobileToolbarItems];
};

const save = async () => {
  isSaving.value = true;
  errorMessage.value = '';
  try {
    await settingsStore.updateMobileToolbarItems(activeItems.value);
    emit('close');
  } catch (error: any) {
    errorMessage.value = error?.message || '保存移动工具栏失败';
  } finally {
    isSaving.value = false;
  }
};
</script>

<template>
  <div v-if="visible" class="fixed inset-0 z-[180] flex items-end bg-overlay" @click.self="emit('close')">
    <section class="flex max-h-[82dvh] w-full flex-col rounded-t-lg border-t border-border bg-background text-foreground shadow-2xl" role="dialog" aria-modal="true" aria-label="配置移动工具栏">
      <header class="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <h2 class="text-base font-semibold">配置底部工具栏</h2>
          <p class="mt-0.5 text-xs text-text-secondary">拖动调整顺序，按需添加或移除模块</p>
        </div>
        <button type="button" class="flex h-9 w-9 items-center justify-center rounded hover:bg-hover" title="关闭" aria-label="关闭" @click="emit('close')">
          <i class="fas fa-times" aria-hidden="true" />
        </button>
      </header>

      <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div class="mb-2 text-xs font-medium text-text-secondary">已启用模块</div>
        <draggable v-model="activeItems" :item-key="mobileToolbarItemKey" handle=".drag-handle" class="space-y-2" :animation="160">
          <template #item="{ element }">
            <div class="flex min-h-11 items-center gap-3 rounded border border-border bg-header/30 px-3 py-2">
              <button type="button" class="drag-handle flex h-8 w-8 flex-shrink-0 cursor-grab items-center justify-center text-text-secondary" title="拖动排序" aria-label="拖动排序">
                <i class="fas fa-grip-vertical" aria-hidden="true" />
              </button>
              <i :class="[moduleById.get(element)?.icon, 'w-5 text-center text-text-secondary']" aria-hidden="true" />
              <span class="min-w-0 flex-1 truncate text-sm">{{ moduleById.get(element)?.label }}</span>
              <span v-if="moduleById.get(element)?.required" class="text-xs text-text-secondary">必需</span>
              <button
                v-else
                type="button"
                class="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded text-error hover:bg-error/10"
                title="移除模块"
                aria-label="移除模块"
                @click="removeModule(element)"
              >
                <i class="fas fa-minus" aria-hidden="true" />
              </button>
            </div>
          </template>
        </draggable>

        <div v-if="availableModules.length" class="mb-2 mt-5 text-xs font-medium text-text-secondary">可添加模块</div>
        <div class="grid grid-cols-2 gap-2">
          <button
            v-for="module in availableModules"
            :key="module.id"
            type="button"
            class="flex min-h-11 items-center gap-2 rounded border border-border px-3 py-2 text-left text-sm hover:border-primary/60 hover:bg-hover"
            @click="addModule(module.id)"
          >
            <i :class="[module.icon, 'w-5 text-center text-text-secondary']" aria-hidden="true" />
            <span class="min-w-0 flex-1 truncate">{{ module.label }}</span>
            <i class="fas fa-plus text-xs text-primary" aria-hidden="true" />
          </button>
        </div>

        <div v-if="errorMessage" class="mt-3 rounded border border-error/40 bg-error/10 px-3 py-2 text-sm text-error">{{ errorMessage }}</div>
      </div>

      <footer class="flex items-center justify-between gap-3 border-t border-border px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <button type="button" class="rounded border border-border px-3 py-2 text-sm hover:bg-hover" @click="restoreDefault">恢复默认</button>
        <div class="flex gap-2">
          <button type="button" class="rounded border border-border px-4 py-2 text-sm hover:bg-hover" @click="emit('close')">取消</button>
          <button type="button" class="rounded bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-60" :disabled="isSaving" @click="save">
            {{ isSaving ? '保存中...' : '保存' }}
          </button>
        </div>
      </footer>
    </section>
  </div>
</template>