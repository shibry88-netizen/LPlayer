// LPlayer 手机端适配 · 横竖屏自动识别
//
// 把当前方向写到 <html data-lp-orient="portrait|landscape">，CSS 和 JS 都能直接读。
// 用 screen.orientation.type 为主（旋转后立刻准确），拿不到再退回「高 ≥ 宽」。
// 桌面端也会写这个属性，但所有竖屏规则都包在 @media (pointer: coarse) 里，所以桌面零影响。
const PORTRAIT_ATTR = 'data-lp-orient';

export const isPortraitViewport = (): boolean => {
  if (typeof window === 'undefined') return false;
  const orientationType = window.screen?.orientation?.type;
  if (typeof orientationType === 'string' && orientationType.length > 0) {
    return orientationType.startsWith('portrait');
  }
  return window.innerHeight >= window.innerWidth;
};

export const installOrientationWatcher = (): void => {
  if (typeof window === 'undefined') return;
  const root = document.documentElement;

  const apply = () => {
    root.setAttribute(PORTRAIT_ATTR, isPortraitViewport() ? 'portrait' : 'landscape');
  };

  apply();

  // resize 在旋转时会来，但键盘/通知栏引起的视口变化只走 visualViewport。
  window.addEventListener('resize', apply, { passive: true });
  window.addEventListener('orientationchange', apply, { passive: true });
  window.visualViewport?.addEventListener('resize', apply, { passive: true });

  // 安卓 WebView 旋转后有时先给旧尺寸，隔一拍再纠正一次。
  window.setTimeout(apply, 350);
};
