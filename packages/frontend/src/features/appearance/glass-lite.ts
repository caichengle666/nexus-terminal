// 轻量毛玻璃 (lite) 的 DOM 部分：检测运行时、生成预模糊的页面背景图。纯计算见 glass-effect.ts。
import { GLASS_RENDER_OVERRIDE_KEY, computeLiteBlurPlan, resolveGlassRenderMode, type GlassRenderMode } from './glass-effect';

const BLURRED_BG_VAR = '--glass-blurred-bg';

const readOverride = (): string | null => {
  try {
    return window.localStorage.getItem(GLASS_RENDER_OVERRIDE_KEY);
  } catch {
    return null;
  }
};

type ElectronGpuApi = {
  getGpuCompositingEnabled?: () => Promise<boolean>;
  onGpuCompositingChanged?: (listener: (enabled: boolean) => void) => () => void;
};

let lastBackgroundUrl: string | null = null;

/** 按 GPU 合成状态重新确定渲染模式；切到 lite 时为当前背景图补生成预模糊版本。 */
const applyGpuCompositing = (isElectron: boolean, gpuCompositing: boolean, override: string | null) => {
  const previous = document.documentElement.dataset.glassRender;
  const actual = resolveGlassRenderMode({ isElectron, gpuCompositing, override });
  document.documentElement.dataset.glassRender = actual;
  if (actual !== 'lite') {
    generation += 1; // 作废进行中的预模糊生成
    clearBlurredBackground();
  } else if (previous !== 'lite') {
    void updateLiteBlurredBackground(lastBackgroundUrl);
  }
};

/**
 * 在 <html> 上设置 data-glass-render。应在挂载应用前调用。
 * Electron 中先按 lite 处理 (避免启动时在软件渲染下跑实时模糊)，再向主进程查询实际的 GPU 合成状态，
 * 已启用则切回 full。
 */
export const initGlassRenderMode = (): GlassRenderMode => {
  const electronApi = (window as { electronAPI?: ElectronGpuApi }).electronAPI;
  const isElectron = Boolean(electronApi);
  const override = readOverride();
  const mode = resolveGlassRenderMode({ isElectron, gpuCompositing: null, override });
  document.documentElement.dataset.glassRender = mode;
  if (isElectron && typeof electronApi?.getGpuCompositingEnabled === 'function') {
    electronApi.getGpuCompositingEnabled()
      .then(gpuCompositing => applyGpuCompositing(isElectron, gpuCompositing === true, override))
      .catch(() => { /* 查询失败：保持 lite */ });
  }
  // 运行中 GPU 进程崩溃 / 回退时主进程会通知，实时切换 (通常退回 lite)
  electronApi?.onGpuCompositingChanged?.(enabled => applyGpuCompositing(isElectron, enabled === true, override));
  return mode;
};

export const isLiteGlassRender = () => document.documentElement.dataset.glassRender === 'lite';

let currentBlobUrl: string | null = null;
let generation = 0;

const clearBlurredBackground = () => {
  const root = document.documentElement;
  root.style.removeProperty(BLURRED_BG_VAR);
  delete root.dataset.glassBg;
  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = null;
  }
};

const loadImage = (url: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.decoding = 'async';
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error('image load failed'));
  img.src = url;
});

const readCssNumber = (name: string, fallback: number) => {
  const value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/**
 * lite 模式下为页面背景图生成一张预模糊版本 (blob URL)，写入 --glass-blurred-bg 并设置 html[data-glass-bg="image"]。
 * 传入空 URL、非 lite 模式或生成失败时清除，glass.css 退回纯半透明底色。
 */
export const updateLiteBlurredBackground = async (imageUrl: string | null | undefined) => {
  const token = ++generation;
  lastBackgroundUrl = imageUrl || null;
  if (!imageUrl || !isLiteGlassRender()) {
    clearBlurredBackground();
    return;
  }
  try {
    const img = await loadImage(imageUrl);
    if (token !== generation) return;
    const plan = computeLiteBlurPlan({
      imageWidth: img.naturalWidth,
      imageHeight: img.naturalHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      cssBlurPx: readCssNumber('--glass-blur', 22),
    });
    if (!plan) throw new Error('invalid image size');
    const saturate = readCssNumber('--glass-saturate', 160);

    // 外扩画布：先把整图拉伸铺满作为边缘填充，再把原图画在中间，模糊时边缘不会混入透明像素
    const padded = document.createElement('canvas');
    padded.width = plan.width + plan.pad * 2;
    padded.height = plan.height + plan.pad * 2;
    const pctx = padded.getContext('2d');
    if (!pctx) throw new Error('no 2d context');
    pctx.drawImage(img, 0, 0, padded.width, padded.height);
    pctx.drawImage(img, plan.pad, plan.pad, plan.width, plan.height);

    const out = document.createElement('canvas');
    out.width = plan.width;
    out.height = plan.height;
    const ctx = out.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.filter = `blur(${plan.blurPx}px) saturate(${saturate}%)`;
    ctx.drawImage(padded, -plan.pad, -plan.pad);

    const blob = await new Promise<Blob | null>(resolve => out.toBlob(resolve, 'image/jpeg', 0.9));
    if (token !== generation) return;
    if (!blob) throw new Error('toBlob failed');
    const url = URL.createObjectURL(blob);
    const previous = currentBlobUrl;
    currentBlobUrl = url;
    const root = document.documentElement;
    root.style.setProperty(BLURRED_BG_VAR, `url("${url}")`);
    root.dataset.glassBg = 'image';
    if (previous) URL.revokeObjectURL(previous);
  } catch (error) {
    if (token !== generation) return;
    console.warn('[glass-lite] 预模糊背景生成失败，退回纯半透明玻璃:', error);
    clearBlurredBackground();
  }
};
