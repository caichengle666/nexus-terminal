<script setup lang="ts">
import { ref, watch, computed, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAppearanceStore } from '../../stores/appearance.store';
import { useUiNotificationsStore } from '../../stores/uiNotifications.store';
import { storeToRefs } from 'pinia';
import { defaultUiTheme, uiThemePresets, type UiThemePreset } from '../../features/appearance/config/default-themes';
import { safeJsonParse } from '../../stores/appearance.store';
import UiAppearancePreview from './UiAppearancePreview.vue';

const { t } = useI18n();
const appearanceStore = useAppearanceStore();
const notificationsStore = useUiNotificationsStore();
const { appearanceSettings } = storeToRefs(appearanceStore);

const CUSTOM_UI_THEMES_KEY = 'nexus_custom_ui_themes';
type CustomUiTheme = UiThemePreset;

const editableUiTheme = ref<Record<string, string>>({});
const editableUiThemeString = ref('');
const themeParseError = ref<string | null>(null);
const customUiThemes = ref<CustomUiTheme[]>([]);
const isCreatingCustomTheme = ref(false);
const customThemeName = ref('');
const isGeneratingTheme = ref(false);
const aiThemeGenerationError = ref<string | null>(null);
let aiThemeAbortController: AbortController | null = null;
let aiThemeGenerationRequestId = 0;
const nonColorThemeKeys = ['--font-family-sans-serif', '--base-padding', '--base-margin'];

const cancelAiThemeGeneration = () => {
  aiThemeGenerationRequestId += 1;
  aiThemeAbortController?.abort();
  aiThemeAbortController = null;
  isGeneratingTheme.value = false;
  aiThemeGenerationError.value = null;
};

const isValidCssColor = (value: string): boolean => {
  if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') return true;
  try {
    return CSS.supports('color', value);
  } catch {
    return true;
  }
};

const requestAiThemeJson = async (payload: Record<string, unknown>, signal: AbortSignal): Promise<string> => {
  const response = await fetch('/api/v1/ai/chat', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    signal,
    body: JSON.stringify({ ...payload, stream: true }),
  });

  if (!response.ok) {
    const body = await response.text();
    let message = body;
    try {
      message = JSON.parse(body)?.message || body;
    } catch {
      // Keep the provider response when it is not JSON.
    }
    throw new Error(message || `AI 请求失败（${response.status}）。`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream') || !response.body) {
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    return typeof content === 'string' ? content : '';
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let responseText = '';

  const processLine = (line: string) => {
    if (!line.startsWith('data:')) return;
    const value = line.slice(5).trim();
    if (!value || value === '[DONE]') return;
    try {
      const chunk = JSON.parse(value);
      const delta = chunk?.choices?.[0]?.delta?.content;
      if (typeof delta === 'string') responseText += delta;
    } catch {
      // Ignore keepalive or malformed SSE lines.
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      lines.forEach(processLine);
    }
    if (done) break;
  }
  if (buffer.trim()) processLine(buffer.trim());
  return responseText;
};

const generateAiUiTheme = async () => {
  if (isGeneratingTheme.value) return;

  const requestId = ++aiThemeGenerationRequestId;
  const controller = new AbortController();
  aiThemeAbortController = controller;
  aiThemeGenerationError.value = null;
  isGeneratingTheme.value = true;

  try {
    const configResponse = await fetch('/api/v1/ai/config', { credentials: 'include', signal: controller.signal });
    if (!configResponse.ok) throw new Error(t('styleCustomizer.aiThemeGenerateFailed', 'AI 配色生成失败。'));
    const aiConfig = await configResponse.json();
    if (!aiConfig?.apiBaseUrl || !aiConfig?.model || !aiConfig?.hasApiKey) {
      throw new Error(t('styleCustomizer.aiThemeSetupRequired', '请先在 AI 助手设置中配置 API 地址、密钥和模型。'));
    }

    const themeTemplate = Object.fromEntries(
      Object.keys(defaultUiTheme).map(key => [key, editableUiTheme.value[key] ?? defaultUiTheme[key]]),
    );
    const responseText = await requestAiThemeJson({
      temperature: 1,
      responseFormat: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'You are a UI theme designer. Return only one valid JSON object with exactly two keys: "name" and "theme". Give the theme a short, creative Chinese name that reflects its palette. In "theme", keep exactly the provided CSS variable keys. Create a coherent, visually polished and distinctly original color palette. Change color-related values only; preserve font, spacing, and non-color values. Use CSS color values, and do not add CSS rules or properties.',
        },
        {
          role: 'user',
          content: `Create a fresh random UI color theme. Random seed: ${Date.now()}. Return JSON in this shape: {"name":"中文主题名","theme":{...}}. Use exactly these CSS variable keys and values as the starting template for the theme object:\n${JSON.stringify(themeTemplate)}`,
        },
      ],
    }, controller.signal);

    if (requestId !== aiThemeGenerationRequestId) return;

    const jsonText = responseText.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const generatedResult = JSON.parse(jsonText);
    const generatedTheme = generatedResult?.theme;
    const expectedKeys = Object.keys(defaultUiTheme);

    if (!generatedResult || typeof generatedResult.name !== 'string' || !generatedResult.name.trim()
      || generatedResult.name.trim().length > 40
      || Object.keys(generatedResult).some(key => !['name', 'theme'].includes(key))
      || !generatedTheme || typeof generatedTheme !== 'object' || Array.isArray(generatedTheme)
      || expectedKeys.some(key => typeof generatedTheme[key] !== 'string' || generatedTheme[key].length > 200)
      || Object.keys(generatedTheme).some(key => !expectedKeys.includes(key))
      || expectedKeys.some(key => !nonColorThemeKeys.includes(key) && !isValidCssColor(generatedTheme[key]))) {
      throw new Error(t('styleCustomizer.aiThemeInvalidResponse', 'AI 返回的主题格式无效，请重试。'));
    }

    editableUiTheme.value = Object.fromEntries(expectedKeys.map(key => [
      key,
      nonColorThemeKeys.includes(key) ? themeTemplate[key] : generatedTheme[key],
    ]));
    customThemeName.value = generatedResult.name.trim();
    isCreatingCustomTheme.value = true;
    notificationsStore.addNotification({
      type: 'success',
      message: t('styleCustomizer.aiThemeGenerated', 'AI 配色已生成并预览，确认后再保存。'),
    });
  } catch (error: any) {
    if (requestId !== aiThemeGenerationRequestId || error?.name === 'AbortError') return;
    console.error('AI 随机生成 UI 主题失败:', error);
    const errorMessage = error.message || t('styleCustomizer.aiThemeGenerateFailed', 'AI 配色生成失败。');
    aiThemeGenerationError.value = errorMessage;
    notificationsStore.addNotification({
      type: 'error',
      message: errorMessage,
    });
  } finally {
    if (requestId !== aiThemeGenerationRequestId) return;
    isGeneratingTheme.value = false;
    aiThemeAbortController = null;
  }
};

const loadCustomUiThemes = () => {
  try {
    const parsed = JSON.parse(localStorage.getItem(CUSTOM_UI_THEMES_KEY) || '[]');
    customUiThemes.value = Array.isArray(parsed) ? parsed.filter(theme => (
      theme && typeof theme.key === 'string' && typeof theme.name === 'string'
      && theme.theme && typeof theme.theme === 'object'
    )) : [];
  } catch {
    customUiThemes.value = [];
  }
};

const persistCustomUiThemes = () => {
  localStorage.setItem(CUSTOM_UI_THEMES_KEY, JSON.stringify(customUiThemes.value));
};

const initializeEditableState = () => {
  const userThemeJson = appearanceSettings.value.customUiTheme;
  const userTheme = safeJsonParse(userThemeJson, {});
  const mergedTheme = { ...defaultUiTheme, ...userTheme };
  editableUiTheme.value = JSON.parse(JSON.stringify(mergedTheme));
  themeParseError.value = null;
  try {
      const themeObject = editableUiTheme.value;
      if (themeObject && typeof themeObject === 'object' && Object.keys(themeObject).length > 0) {
          const lines = Object.entries(themeObject).map(([key, value]) => `${key}: ${value}`);
          editableUiThemeString.value = lines.join('\n');
      } else {
          editableUiThemeString.value = '';
      }
  } catch (e) {
      console.error("初始化 UI 主题字符串失败:", e);
      editableUiThemeString.value = '';
  }
};

onMounted(() => {
  initializeEditableState();
  loadCustomUiThemes();
});

watch(() => appearanceSettings.value.customUiTheme, () => {
    console.log('[StyleCustomizerUiTab Watch] customUiTheme changed, re-initializing.');
    initializeEditableState();
}, { deep: true });


const handleSaveUiTheme = async () => {
  if (isGeneratingTheme.value) return;
  try {
    await appearanceStore.saveCustomUiTheme(editableUiTheme.value);
    notificationsStore.addNotification({ type: 'success', message: t('styleCustomizer.uiThemeSaved') });
  } catch (error: any) {
    console.error("保存 UI 主题失败:", error);
    notificationsStore.addNotification({ type: 'error', message: t('styleCustomizer.uiThemeSaveFailed', { message: error.message }) });
  }
};

const handleResetUiTheme = () => {
  cancelAiThemeGeneration();
  editableUiTheme.value = JSON.parse(JSON.stringify(defaultUiTheme));
};

const previewThemePreset = (preset: UiThemePreset) => {
  cancelAiThemeGeneration();
  editableUiTheme.value = JSON.parse(JSON.stringify(preset.theme));
};

const openCreateCustomTheme = () => {
  cancelAiThemeGeneration();
  customThemeName.value = t('styleCustomizer.newThemeDefaultName', '新主题');
  isCreatingCustomTheme.value = true;
};

const cancelCreateCustomTheme = () => {
  cancelAiThemeGeneration();
  isCreatingCustomTheme.value = false;
  customThemeName.value = '';
};

const createCustomUiTheme = () => {
  const name = customThemeName.value.trim();
  if (!name) {
    notificationsStore.addNotification({ type: 'error', message: t('styleCustomizer.errorThemeNameRequired') });
    return;
  }

  const theme: CustomUiTheme = {
    key: `custom-${Date.now()}`,
    name,
    description: t('styleCustomizer.customThemeDescription', '由用户创建的自定义界面主题'),
    mode: /#(?:0{2,}|[0-3][0-9a-f]{5})/i.test(editableUiTheme.value['--app-bg-color'] || '') ? 'dark' : 'light',
    theme: JSON.parse(JSON.stringify(editableUiTheme.value)),
  };
  customUiThemes.value.push(theme);
  persistCustomUiThemes();
  cancelCreateCustomTheme();
  previewThemePreset(theme);
};

const deleteCustomUiTheme = async (theme: CustomUiTheme) => {
  const confirmed = window.confirm(`确定删除自定义主题“${theme.name}”吗？`);
  if (!confirmed) return;
  customUiThemes.value = customUiThemes.value.filter(item => item.key !== theme.key);
  persistCustomUiThemes();
  notificationsStore.addNotification({ type: 'success', message: t('styleCustomizer.themeDeletedSuccess') });
};

const isPresetActive = (preset: UiThemePreset) => {
  const currentTheme = JSON.stringify(editableUiTheme.value);
  return currentTheme === JSON.stringify(preset.theme);
};

const getPresetSwatches = (preset: UiThemePreset) => [
  preset.theme['--app-bg-color'],
  preset.theme['--header-bg-color'],
  preset.theme['--link-active-color'],
  preset.theme['--button-bg-color'],
];

const formattedEditableUiThemeJson = computed(() => {
    try {
        const themeObject = editableUiTheme.value;
        if (!themeObject || typeof themeObject !== 'object' || Object.keys(themeObject).length === 0) {
            return '';
        }
        const lines = Object.entries(themeObject).map(([key, value]) => {
            return `${key}: ${value}`;
        });
        return lines.join('\n');
    } catch (e) {
        console.error("序列化可编辑 UI 主题键值对失败:", e);
        return '';
    }
});

watch(formattedEditableUiThemeJson, (newJson) => {
    if (document.activeElement?.id !== 'uiThemeTextarea' || themeParseError.value) {
        editableUiThemeString.value = newJson;
        if (themeParseError.value && document.activeElement?.id !== 'uiThemeTextarea') {
             themeParseError.value = null;
        }
    }
});

const handleUiThemeStringChange = () => {
    themeParseError.value = null;
    let inputText = editableUiThemeString.value.trim();

    if (!inputText) {
        editableUiTheme.value = {};
        return;
    }

    let jsonStringToParse = inputText
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && line.includes(':'))
        .map(line => {
            const parts = line.split(/:(.*)/s);
            if (parts.length < 2) return null;

            let key = parts[0].trim();
            let value = parts[1].trim();

            if (key.startsWith('"') && key.endsWith('"')) key = key.slice(1, -1);
            if (key.startsWith("'") && key.endsWith("'")) key = key.slice(1, -1);
            key = JSON.stringify(key);

            if (value.endsWith(',')) value = value.slice(0, -1).trim();
            let originalValue = value;
            if (value.startsWith('"') && value.endsWith('"')) originalValue = value.slice(1, -1);
            else if (value.startsWith("'") && value.endsWith("'")) originalValue = value.slice(1, -1);

            if (isNaN(Number(originalValue)) && originalValue !== 'true' && originalValue !== 'false' && originalValue !== 'null') {
                 value = JSON.stringify(originalValue);
            } else {
                value = originalValue;
            }
            return `  ${key}: ${value}`;
        })
        .filter(line => line !== null)
        .join(',\n');

    const fullJsonString = `{\n${jsonStringToParse}\n}`;

    try {
        const parsedTheme = JSON.parse(fullJsonString);
        if (typeof parsedTheme !== 'object' || parsedTheme === null || Array.isArray(parsedTheme)) {
            throw new Error(t('styleCustomizer.errorInvalidJsonObject'));
        }
        editableUiTheme.value = parsedTheme;
    } catch (error: any) {
        console.error('解析 UI 主题配置失败:', error);
        let errorMessage = error.message || t('styleCustomizer.errorInvalidJsonConfig');
        if (error instanceof SyntaxError) {
            errorMessage = `${t('styleCustomizer.errorJsonSyntax')}: ${error.message}`;
        }
        themeParseError.value = errorMessage;
    }
};

const formatLabel = (key: string): string => {
  return key
    .replace(/^--/, '')
    .replace(/-/g, ' ')
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (str) => str.toUpperCase());
};

const handleFocusAndSelect = (event: FocusEvent) => {
  const target = event.target;
  if (target instanceof HTMLInputElement) {
    target.select();
  }
};

defineExpose({
  handleSaveUiTheme,
  handleResetUiTheme
});

onUnmounted(() => {
  cancelAiThemeGeneration();
});

</script>

<template>
  <section>
    <h3 class="mt-0 border-b border-border pb-2 mb-4 text-lg font-semibold text-foreground">{{ t('styleCustomizer.uiStyles') }}</h3>
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <button
        type="button"
        class="inline-flex min-h-9 items-center gap-2 rounded border border-primary/50 px-3 py-1.5 text-sm font-medium text-primary transition-colors hover:bg-primary/10 disabled:cursor-wait disabled:opacity-60"
        :disabled="isGeneratingTheme"
        :aria-busy="isGeneratingTheme"
        @click="generateAiUiTheme"
      >
        <i :class="isGeneratingTheme ? 'fas fa-spinner fa-spin' : 'fas fa-wand-magic-sparkles'" aria-hidden="true" />
        {{ isGeneratingTheme ? t('styleCustomizer.aiThemeGenerating', 'AI 正在创作配色...') : t('styleCustomizer.aiThemeGenerate', 'AI 随机生成配色') }}
      </button>
      <span class="text-xs text-text-secondary">{{ t('styleCustomizer.aiThemePreviewHint', '生成后先预览，满意后再保存。') }}</span>
    </div>
    <div v-if="isGeneratingTheme" class="mb-3 flex items-center gap-2 rounded border border-primary/40 bg-primary/10 px-3 py-2 text-sm text-foreground">
      <i class="fas fa-spinner fa-spin text-primary" aria-hidden="true" />
      <span>{{ t('styleCustomizer.aiThemeGenerating', 'AI 正在创作配色...') }}</span>
      <button type="button" @click="cancelAiThemeGeneration" class="ml-auto rounded border border-border px-3 py-1 text-xs font-medium hover:bg-border">{{ t('common.cancel', '取消') }}</button>
    </div>
    <div v-else-if="aiThemeGenerationError" class="mb-3 flex flex-wrap items-center justify-between gap-2 rounded border border-error/30 bg-error/10 px-3 py-2 text-sm text-error-text">
      <span>{{ aiThemeGenerationError }}</span>
      <button type="button" @click="generateAiUiTheme" class="rounded border border-error/40 px-3 py-1 text-xs font-medium hover:bg-error/20">{{ t('common.retry', '重试') }}</button>
    </div>
    <UiAppearancePreview class="mb-5" :theme="editableUiTheme" />
    <div class="grid grid-cols-1 md:grid-cols-[auto_1fr] items-start md:items-center gap-2 md:gap-3 mb-6">
        <label class="text-left text-foreground text-sm font-medium mb-1 md:mb-0">{{ t('styleCustomizer.themeModeLabel', '主题模式:') }}</label>
        <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            <button
              v-for="preset in uiThemePresets"
              :key="preset.key"
              type="button"
              @click="previewThemePreset(preset)"
              class="text-left border rounded-md p-3 bg-header hover:bg-border transition duration-200 ease-in-out"
              :class="isPresetActive(preset) ? 'border-primary ring-1 ring-primary' : 'border-border'"
            >
              <div class="flex items-center justify-between gap-3">
                <span class="text-sm font-semibold text-foreground">{{ preset.name }}</span>
                <span class="text-[11px] px-2 py-0.5 rounded-full border border-border text-text-secondary">
                  {{ preset.mode === 'dark' ? t('styleCustomizer.darkMode', '黑暗模式') : t('styleCustomizer.defaultMode', '默认模式') }}
                </span>
              </div>
              <p class="mt-1 mb-3 text-xs text-text-secondary leading-relaxed">{{ preset.description }}</p>
              <div class="flex items-center gap-1.5">
                <span
                  v-for="color in getPresetSwatches(preset)"
                  :key="`${preset.key}-${color}`"
                  class="h-5 flex-1 rounded border border-border"
                  :style="{ backgroundColor: color }"
                ></span>
              </div>
            </button>
            <div
              v-for="theme in customUiThemes"
              :key="theme.key"
              @click="previewThemePreset(theme)"
              @keydown.enter="previewThemePreset(theme)"
              role="button"
              tabindex="0"
              class="text-left border rounded-md p-3 bg-header hover:bg-border transition duration-200 ease-in-out"
              :class="isPresetActive(theme) ? 'border-primary ring-1 ring-primary' : 'border-border'"
            >
              <div class="flex items-center justify-between gap-3">
                <span class="min-w-0 truncate text-sm font-semibold text-foreground">{{ theme.name }}</span>
                <button
                  type="button"
                  class="flex-shrink-0 rounded px-1.5 py-0.5 text-[11px] text-error hover:bg-error/10"
                  @click.stop="deleteCustomUiTheme(theme)"
                >
                  {{ t('styleCustomizer.deleteCustomTheme', '删除') }}
                </button>
              </div>
              <p class="mt-1 mb-3 text-xs text-text-secondary leading-relaxed">{{ theme.description }}</p>
              <div class="flex items-center gap-1.5">
                <span
                  v-for="color in getPresetSwatches(theme)"
                  :key="`${theme.key}-${color}`"
                  class="h-5 flex-1 rounded border border-border"
                  :style="{ backgroundColor: color }"
                ></span>
              </div>
            </div>
            <button
              type="button"
              class="flex min-h-[128px] items-center justify-center rounded-md border border-dashed border-primary/60 p-3 text-sm font-semibold text-primary hover:bg-primary/10"
              @click="openCreateCustomTheme"
            >
              + {{ t('styleCustomizer.addCustomTheme', '新建自定义主题') }}
            </button>
        </div>
    </div>
    <div v-if="isCreatingCustomTheme" class="mb-4 rounded-md border border-primary/40 bg-primary/5 p-3">
      <label class="block text-sm font-medium text-foreground" for="custom-ui-theme-name">
        {{ t('styleCustomizer.themeName') }}
      </label>
      <div class="mt-2 flex flex-wrap gap-2">
        <input
          id="custom-ui-theme-name"
          v-model="customThemeName"
          class="min-w-[220px] flex-1 rounded border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          :placeholder="t('styleCustomizer.newThemeDefaultName')"
          @keyup.enter="createCustomUiTheme"
        />
        <button type="button" class="rounded bg-primary px-3 py-1.5 text-sm text-white" @click="createCustomUiTheme">
          {{ t('styleCustomizer.saveUiTheme') }}
        </button>
        <button type="button" class="rounded border border-border px-3 py-1.5 text-sm hover:bg-hover" @click="cancelCreateCustomTheme">
          {{ t('common.cancel', '取消') }}
        </button>
      </div>
      <p class="mt-2 text-xs text-text-secondary">{{ t('styleCustomizer.customThemeHint', '将保存当前编辑器中的颜色配置，并作为独立主题保留。') }}</p>
    </div>
    <p class="text-text-secondary text-sm leading-relaxed mb-3">{{ t('styleCustomizer.uiDescription') }}</p>
    <div v-for="(value, key) in editableUiTheme" :key="key" class="grid grid-cols-1 md:grid-cols-[auto_1fr] items-start md:items-center gap-x-3 gap-y-1 mb-3">
      <label :for="`ui-${key}`" class="text-left text-foreground text-sm font-medium overflow-hidden text-ellipsis block w-full mb-1 md:mb-0">{{ formatLabel(key) }}:</label>
      <div class="flex items-center gap-2 w-full">
        <input
          v-if="typeof value === 'string' && (value.startsWith('#') || value.startsWith('rgb') || value.startsWith('hsl'))"
          type="color"
          :id="`ui-${key}`"
          v-model="editableUiTheme[key]"
          class="p-0.5 h-[34px] min-w-[40px] max-w-[50px] rounded border border-border flex-shrink-0 focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
        />
        <input
          v-if="typeof value === 'string' && (value.startsWith('#') || value.startsWith('rgb') || value.startsWith('hsl'))"
          type="text"
          :value="editableUiTheme[key]"
          class="flex-grow min-w-[80px] bg-background cursor-text border border-border px-[0.7rem] py-2 rounded text-sm text-foreground w-full box-border transition duration-200 ease-in-out focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          @focus="handleFocusAndSelect"
          @input="editableUiTheme[key] = ($event.target as HTMLInputElement).value"
        />
        <input
          v-else
          type="text"
          :id="`ui-${key}`"
          v-model="editableUiTheme[key]"
          class="col-span-full border border-border px-[0.7rem] py-2 rounded text-sm bg-background text-foreground w-full box-border transition duration-200 ease-in-out focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </div>
    </div>
    <hr style="margin-top: calc(var(--base-padding) * 2); margin-bottom: calc(var(--base-padding) * 2);">
    <h4 class="mt-6 mb-2 text-base font-semibold text-foreground">{{ t('styleCustomizer.uiThemeJsonEditorTitle') }}</h4>
    <p class="text-text-secondary text-sm leading-relaxed mb-3">{{ t('styleCustomizer.uiThemeJsonEditorDesc') }}</p>
    <div class="mt-4">
       <label for="uiThemeTextarea" class="sr-only">{{ t('styleCustomizer.uiThemeJsonEditorTitle') }}</label>
       <textarea
         id="uiThemeTextarea"
         v-model="editableUiThemeString"
         @blur="handleUiThemeStringChange"
         rows="15"
         :placeholder="'--app-bg-color: #ffffff\n--text-color: #333333\n...'"
         spellcheck="false"
         class="w-full font-mono text-sm leading-snug border border-border rounded p-3 bg-background text-foreground resize-y min-h-[200px] box-border whitespace-pre-wrap break-words transition duration-200 ease-in-out focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
       ></textarea>
    </div>
     <p v-if="themeParseError" class="text-error-text bg-error/10 border border-error/30 px-3 py-2 rounded text-sm mt-2">{{ themeParseError }}</p>
  </section>
</template>
