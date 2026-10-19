<script setup lang="ts">
import { ref, watch, computed, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAppearanceStore } from '../../stores/appearance.store';
import { useUiNotificationsStore } from '../../stores/uiNotifications.store';
import { storeToRefs } from 'pinia';
import { defaultUiTheme, defaultAppUiTheme, uiThemePresets, type UiThemePreset } from '../../features/appearance/config/default-themes';
import { safeJsonParse } from '../../stores/appearance.store';
import UiAppearancePreview from './UiAppearancePreview.vue';
import {
  ALL_GLASS_KEYS,
  GLASS_BACKDROP_KEY,
  GLASS_COLOR_KEYS,
  GLASS_EFFECT_KEY,
  GLASS_EFFECT_VALUE,
  GLASS_NON_COLOR_KEYS,
  GLASS_SHADOW_KEY,
  guessThemeMode,
  isGlassTheme,
  isSafeGlassBackdrop,
  isSafeGlassShadow,
  resolveEffectiveUiTheme,
} from '../../features/appearance/glass-effect';

const { t } = useI18n();
const appearanceStore = useAppearanceStore();
const notificationsStore = useUiNotificationsStore();
const { appearanceSettings, uiGlassEnabled } = storeToRefs(appearanceStore);

const CUSTOM_UI_THEMES_KEY = 'nexus_custom_ui_themes';
type CustomUiTheme = UiThemePreset;

const editableUiTheme = ref<Record<string, string>>({});
// 毛玻璃效果开关 (与主题一起在“保存”时提交)
const editableGlassEnabled = ref(false);
// 预览使用最终生效的主题 (开关打开时推导毛玻璃变量，关闭时毛玻璃主题回退为实色)
const previewUiTheme = computed(() => resolveEffectiveUiTheme(editableUiTheme.value, editableGlassEnabled.value));
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

    // 编辑中的主题若为毛玻璃主题，则模板带上 --glass-* 变量，让 AI 一并设计半透明配色
    const sourceTheme = editableUiTheme.value;
    const generateGlass = isGlassTheme(sourceTheme);
    const glassDefaults: Record<string, string> = generateGlass ? resolveEffectiveUiTheme({ ...sourceTheme, [GLASS_EFFECT_KEY]: '' }, true) : {};
    const baseKeys = Object.keys(defaultUiTheme);
    const glassKeys = generateGlass ? ALL_GLASS_KEYS : [];
    const themeTemplate: Record<string, string> = Object.fromEntries(
      [...baseKeys, ...glassKeys].map(key => [key, sourceTheme[key] ?? glassDefaults[key] ?? defaultUiTheme[key]]),
    );
    const glassInstructions = generateGlass
      ? ' This is a frosted-glass (translucent) theme. The surfaces must stay translucent: use rgba() with alpha roughly 0.4-0.7 for --app-bg-color, --header-bg-color, --footer-bg-color and --glass-surface, about 0.85 for --glass-surface-strong, and low-alpha rgba() for --glass-inner, --glass-field, --glass-border, --glass-highlight. --glass-base-color must be an opaque color matching the backdrop. Design a matching --glass-backdrop made only of linear-gradient()/radial-gradient()/conic-gradient() layers using colors, percentages, px, deg and "at" positions (no url(), no other functions). --glass-shadow is a plain box-shadow such as "0 10px 30px rgba(0, 0, 0, 0.35)". Keep --glass-blur, --glass-saturate and --glass-terminal-alpha unchanged.'
      : '';
    const responseText = await requestAiThemeJson({
      temperature: 1,
      responseFormat: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'You are a UI theme designer. Return only one valid JSON object with exactly two keys: "name" and "theme". Give the theme a short, creative Chinese name that reflects its palette. In "theme", keep exactly the provided CSS variable keys. Create a coherent, visually polished and distinctly original color palette. Change color-related values only; preserve font, spacing, and non-color values. Use CSS color values, and do not add CSS rules or properties.' + glassInstructions,
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
    const expectedKeys = baseKeys;
    const allowedKeys = [...baseKeys, ...glassKeys];

    if (!generatedResult || typeof generatedResult.name !== 'string' || !generatedResult.name.trim()
      || generatedResult.name.trim().length > 40
      || Object.keys(generatedResult).some(key => !['name', 'theme'].includes(key))
      || !generatedTheme || typeof generatedTheme !== 'object' || Array.isArray(generatedTheme)
      || expectedKeys.some(key => typeof generatedTheme[key] !== 'string' || generatedTheme[key].length > 200)
      // --ui-effect 即使 AI 返回也会被忽略 (毛玻璃主题固定为 glass)，不因此判定整体无效
      || Object.keys(generatedTheme).some(key => !allowedKeys.includes(key) && !(generateGlass && key === GLASS_EFFECT_KEY))
      || expectedKeys.some(key => !nonColorThemeKeys.includes(key) && !isValidCssColor(generatedTheme[key]))) {
      throw new Error(t('styleCustomizer.aiThemeInvalidResponse', 'AI 返回的主题格式无效，请重试。'));
    }

    const nextTheme: Record<string, string> = Object.fromEntries(expectedKeys.map(key => [
      key,
      nonColorThemeKeys.includes(key) ? themeTemplate[key] : generatedTheme[key],
    ]));
    if (generateGlass) {
      // --ui-effect 固定为 glass，不取自 AI；毛玻璃附加变量单独校验，不合格时回退模板值而不是整体失败
      nextTheme[GLASS_EFFECT_KEY] = GLASS_EFFECT_VALUE;
      const pick = (key: string, valid: (value: unknown) => boolean) => {
        const value = generatedTheme[key];
        nextTheme[key] = typeof value === 'string' && value.length <= 1500 && valid(value) ? value.trim() : themeTemplate[key];
      };
      GLASS_COLOR_KEYS.forEach(key => pick(key, value => typeof value === 'string' && value.length <= 200 && isValidCssColor(value)));
      pick(GLASS_BACKDROP_KEY, isSafeGlassBackdrop);
      pick(GLASS_SHADOW_KEY, isSafeGlassShadow);
      GLASS_NON_COLOR_KEYS.forEach(key => { nextTheme[key] = themeTemplate[key]; });
    }
    editableUiTheme.value = nextTheme;
    if (generateGlass) editableGlassEnabled.value = true;
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
  editableGlassEnabled.value = uiGlassEnabled.value;
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

watch(uiGlassEnabled, (enabled) => {
    editableGlassEnabled.value = enabled;
});

const toggleGlassEffect = () => {
  editableGlassEnabled.value = !editableGlassEnabled.value;
};


const handleSaveUiTheme = async () => {
  if (isGeneratingTheme.value) return;
  try {
    await appearanceStore.saveCustomUiTheme(editableUiTheme.value, editableGlassEnabled.value);
    notificationsStore.addNotification({ type: 'success', message: t('styleCustomizer.uiThemeSaved') });
  } catch (error: any) {
    console.error("保存 UI 主题失败:", error);
    notificationsStore.addNotification({ type: 'error', message: t('styleCustomizer.uiThemeSaveFailed', { message: error.message }) });
  }
};

const handleResetUiTheme = () => {
  cancelAiThemeGeneration();
  editableUiTheme.value = JSON.parse(JSON.stringify(defaultAppUiTheme));
  editableGlassEnabled.value = true;
};

const previewThemePreset = (preset: UiThemePreset) => {
  cancelAiThemeGeneration();
  editableUiTheme.value = JSON.parse(JSON.stringify(preset.theme));
  // 选择毛玻璃主题时自动打开毛玻璃效果；选择普通主题时保持开关现状
  if (isGlassTheme(preset.theme)) editableGlassEnabled.value = true;
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
    mode: guessThemeMode(editableUiTheme.value),
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
  // 毛玻璃主题的背景色是半透明的，色块改用其底色展示
  preset.theme['--glass-base-color'] || preset.theme['--app-bg-color'],
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
    <div class="mb-3 flex items-center justify-between gap-4 rounded-md border border-border bg-header px-3 py-2.5">
      <div class="min-w-0">
        <label for="uiGlassEffectSwitch" class="block text-sm font-medium text-foreground">{{ t('styleCustomizer.glassEffect', '毛玻璃效果') }}</label>
        <p class="mt-0.5 text-xs text-text-secondary">{{ t('styleCustomizer.glassEffectHint', '半透明磨砂面板，可叠加在任意主题上') }}</p>
      </div>
      <button
        type="button"
        id="uiGlassEffectSwitch"
        role="switch"
        :aria-checked="editableGlassEnabled"
        @click="toggleGlassEffect"
        :class="[
          'relative inline-flex flex-shrink-0 h-6 w-11 border-2 border-transparent rounded-full cursor-pointer transition-colors ease-in-out duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary',
          editableGlassEnabled ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'
        ]"
      >
        <span
          aria-hidden="true"
          :class="[
            'pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transform ring-0 transition ease-in-out duration-200',
            editableGlassEnabled ? 'translate-x-5' : 'translate-x-0'
          ]"
        ></span>
      </button>
    </div>
    <UiAppearancePreview class="mb-5" :theme="previewUiTheme" />
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
