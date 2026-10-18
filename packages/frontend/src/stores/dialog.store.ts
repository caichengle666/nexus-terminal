import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

interface DialogState {
  visible: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  isLoading: boolean;
  resolvePromise?: (value: boolean) => void;
  rejectPromise?: (reason?: any) => void;
}

export interface ShowDialogOptions {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  /** Aborting resolves the dialog with `false` and dismisses it (or drops it from the queue). */
  signal?: AbortSignal;
}

interface QueuedDialog {
  options: ShowDialogOptions;
  resolve: (value: boolean) => void;
  cleanup: () => void;
}

// There is a single global confirm dialog. Requests that arrive while one is
// open are queued and shown in order, so no caller is left waiting on a
// promise that a later showDialog() silently replaced.
export const useDialogStore = defineStore('dialog', () => {
  const { t } = useI18n();

  const defaultState: DialogState = {
    visible: false,
    title: '',
    message: '',
    confirmText: t('common.confirm', '确认'),
    cancelText: t('common.cancel', '取消'),
    isLoading: false,
  };

  const state = ref<DialogState>({ ...defaultState });
  const queue: QueuedDialog[] = [];
  let current: QueuedDialog | null = null;

  const showNext = () => {
    if (current) return;
    const next = queue.shift();
    if (!next) return;
    current = next;
    const { signal: _signal, ...options } = next.options;
    state.value = {
      ...defaultState,
      ...options,
      visible: true,
      isLoading: false,
      resolvePromise: (value: boolean) => settle(next, value),
      rejectPromise: () => settle(next, false),
    };
  };

  const settle = (entry: QueuedDialog, value: boolean) => {
    entry.cleanup();
    if (current === entry) {
      current = null;
      state.value.visible = false;
      state.value.resolvePromise = undefined;
      state.value.rejectPromise = undefined;
    } else {
      const index = queue.indexOf(entry);
      if (index >= 0) queue.splice(index, 1);
    }
    entry.resolve(value);
    // Let the closing dialog leave the DOM before the next one opens.
    if (!current && queue.length > 0) setTimeout(showNext, 0);
  };

  const showDialog = (options: ShowDialogOptions): Promise<boolean> => {
    if (options.signal?.aborted) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const entry: QueuedDialog = {
        options,
        resolve: (value) => {
          if (settled) return;
          settled = true;
          resolve(value);
        },
        cleanup: () => options.signal?.removeEventListener('abort', onAbort),
      };
      const onAbort = () => settle(entry, false);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      queue.push(entry);
      showNext();
    });
  };

  const handleConfirm = async () => {
    if (current) settle(current, true);
    else state.value.visible = false;
  };

  const handleCancel = () => {
    if (current) settle(current, false);
    else state.value.visible = false;
  };

  // The dialog component can also close itself (overlay click / Esc) by
  // writing visible=false directly; treat that as a cancel.
  watch(() => state.value.visible, (visible) => {
    if (!visible && current) settle(current, false);
  });

  // For actions that might take time, to show a loading spinner on the confirm button
  const setLoading = (loading: boolean) => {
    state.value.isLoading = loading;
  };

  return {
    visible: ref(state.value.visible), // Expose refs for reactivity in component
    title: ref(state.value.title),
    message: ref(state.value.message),
    confirmText: ref(state.value.confirmText),
    cancelText: ref(state.value.cancelText),
    isLoading: ref(state.value.isLoading),
    // ---
    state, // Expose whole state for ConfirmDialog.vue to bind
    showDialog,
    handleConfirm,
    handleCancel,
    setLoading,
  };
});
