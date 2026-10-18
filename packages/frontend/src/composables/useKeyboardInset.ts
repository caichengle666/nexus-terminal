import { onBeforeUnmount, onMounted } from 'vue';

// Tracks the on-screen keyboard via window.visualViewport and exposes it as CSS
// variables on <html>, so fixed overlays can stay above the keyboard:
//   --kb-inset       space covered at the bottom of the layout viewport (px)
//   --vv-offset-top  how far the visual viewport is scrolled down (iOS) (px)
// With `interactive-widget=resizes-content` (Chromium) the layout viewport
// shrinks itself and both values stay ~0; iOS Safari ignores that hint, which
// is what the variables are for. Reference counted so several users can share it.

let users = 0;
let frame: number | null = null;

const apply = () => {
  frame = null;
  const viewport = window.visualViewport;
  const root = document.documentElement;
  if (!viewport) {
    root.style.setProperty('--kb-inset', '0px');
    root.style.setProperty('--vv-offset-top', '0px');
    return;
  }
  const offsetTop = Math.max(0, viewport.offsetTop);
  const inset = Math.max(0, window.innerHeight - viewport.height - offsetTop);
  // Ignore sub-pixel noise and browser toolbar jitter.
  root.style.setProperty('--kb-inset', `${inset < 1 ? 0 : Math.round(inset)}px`);
  root.style.setProperty('--vv-offset-top', `${Math.round(offsetTop)}px`);
};

const schedule = () => {
  if (frame !== null) return;
  frame = window.requestAnimationFrame(apply);
};

const start = () => {
  users += 1;
  if (users > 1) return;
  window.visualViewport?.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('scroll', schedule);
  window.addEventListener('resize', schedule);
  apply();
};

const stop = () => {
  users = Math.max(0, users - 1);
  if (users > 0) return;
  window.visualViewport?.removeEventListener('resize', schedule);
  window.visualViewport?.removeEventListener('scroll', schedule);
  window.removeEventListener('resize', schedule);
  if (frame !== null) window.cancelAnimationFrame(frame);
  frame = null;
  document.documentElement.style.removeProperty('--kb-inset');
  document.documentElement.style.removeProperty('--vv-offset-top');
};

export function useKeyboardInset(enabled: () => boolean = () => true) {
  let active = false;
  onMounted(() => {
    if (!enabled() || typeof window === 'undefined') return;
    active = true;
    start();
  });
  onBeforeUnmount(() => {
    if (!active) return;
    active = false;
    stop();
  });
}
