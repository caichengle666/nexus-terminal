import { computed, ref } from 'vue';

const MOBILE_VIEWPORT_WIDTH = 768;
const TOUCH_TABLET_WIDTH = 1180;
const viewportWidth = ref(typeof window === 'undefined' ? TOUCH_TABLET_WIDTH + 1 : window.innerWidth);

if (typeof window !== 'undefined') {
  const updateViewportWidth = () => {
    viewportWidth.value = window.innerWidth;
  };
  window.addEventListener('resize', updateViewportWidth, { passive: true });
  window.visualViewport?.addEventListener('resize', updateViewportWidth, { passive: true });
}

export function useDeviceDetection() {
  const isMobile = computed(() => {
    if (typeof navigator === 'undefined') return viewportWidth.value <= MOBILE_VIEWPORT_WIDTH;

    const mobileUserAgent = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    const narrowViewport = viewportWidth.value <= MOBILE_VIEWPORT_WIDTH;
    const touchTablet = navigator.maxTouchPoints > 1 && viewportWidth.value <= TOUCH_TABLET_WIDTH;
    return mobileUserAgent || narrowViewport || touchTablet;
  });

  return { isMobile };
}
