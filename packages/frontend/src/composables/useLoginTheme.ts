import { computed, ref } from 'vue';
import { uiThemePresets } from '../features/appearance/config/default-themes';

// 登录页（未登录时）的亮/暗切换。登录页和移动端顶栏共用同一份状态。
// 默认与新安装一致：Glass Dark；切换在 Glass Dark / Glass Light 之间进行，
// 同时同步 html[data-ui-effect]，避免“毛玻璃深色背景 + 亮色主题深色文字”看不清。
const STORAGE_KEY = 'nexus-terminal-login-theme';
const DARK_KEY = 'glass-dark';
const LIGHT_KEY = 'glass-light';

const findPreset = (key: string | null) => uiThemePresets.find(preset => preset.key === key);
const themeKey = ref(DARK_KEY);

const apply = (key: string, persist = true) => {
  const preset = findPreset(key) ?? findPreset(DARK_KEY) ?? uiThemePresets[0];
  themeKey.value = preset.key;
  const root = document.documentElement;
  for (const [name, value] of Object.entries(preset.theme)) root.style.setProperty(name, value);
  const effect = String((preset.theme as Record<string, string>)['--ui-effect'] ?? '').trim();
  if (effect) root.dataset.uiEffect = effect;
  else delete root.dataset.uiEffect;
  root.style.colorScheme = preset.mode;
  if (!persist) return;
  try { localStorage.setItem(STORAGE_KEY, preset.key); } catch { /* 隐私模式 */ }
};

export function useLoginTheme() {
  const isDark = computed(() => (findPreset(themeKey.value)?.mode ?? 'dark') === 'dark');
  const init = () => {
    let saved: string | null = null;
    try { saved = localStorage.getItem(STORAGE_KEY); } catch { /* ignore */ }
    // 旧版本存的是 default / pro-dark 等非玻璃预设：按明暗映射到对应的玻璃主题
    const savedPreset = findPreset(saved);
    apply(savedPreset ? (savedPreset.mode === 'light' ? LIGHT_KEY : DARK_KEY) : DARK_KEY, false);
  };
  const toggle = () => apply(isDark.value ? LIGHT_KEY : DARK_KEY);
  return { isDark, init, toggle };
}
