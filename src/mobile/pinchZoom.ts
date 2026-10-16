// LPlayer 手机端适配 · 双指缩放（仅歌单列表 / 歌单详情）
//
// 双指张开 = 放大，双指聚拢 = 缩小，双击复位。
// 只在带 [data-lp-zoom] 的容器上生效：
//   - 首页曲库 / 歌单列表      library/suites/grid/home/Grid3D.tsx
//   - 歌单详情（点进歌单后的歌曲列表） library/suites/grid/collection/GridView.tsx
//
// 播放页（全屏歌词 / 可视化舞台）不再做任何缩放。
// 原因：给舞台容器加 transform 会让它成为 absolute 后代的 containing block，
// 字幕层（.lp-subtitle-layer 用 absolute + bottom 定位）会因此改变定位基准，
// 表现为歌词时不时跳到屏幕外面。缩放退出播放页后该类问题不再出现。
const MIN_SCALE = 0.6;
const MAX_SCALE = 2;
const TARGET_SELECTOR = '[data-lp-zoom]';
const DOUBLE_TAP_MS = 300;

let scale = 1;
let startDistance = 0;
let startScale = 1;
let pinching = false;
let lastTapAt = 0;

const findTargets = (): HTMLElement[] => (
  typeof document === 'undefined'
    ? []
    : Array.from(document.querySelectorAll<HTMLElement>(TARGET_SELECTOR))
);

const touchDistance = (touches: TouchList): number => Math.hypot(
  touches[0].clientX - touches[1].clientX,
  touches[0].clientY - touches[1].clientY,
);

const applyScale = (animate: boolean): void => {
  const targets = findTargets();
  if (targets.length === 0) return;
  const isIdle = Math.abs(scale - 1) < 0.001;
  for (const target of targets) {
    target.style.transformOrigin = 'center center';
    target.style.transition = animate ? 'transform .18s ease-out' : 'none';
    if (isIdle) {
      target.style.removeProperty('transform');
    } else {
      target.style.transform = `scale(${scale.toFixed(4)})`;
    }
  }
};

/** 复位到 1×（双击，或外部主动调用）。 */
export const resetPinchZoom = (): void => {
  scale = 1;
  applyScale(true);
};

export const installPinchZoom = (): void => {
  const onTouchStart = (event: TouchEvent) => {
    if (event.touches.length !== 2 || findTargets().length === 0) return;
    pinching = true;
    startDistance = touchDistance(event.touches);
    startScale = scale;
    // 容器可能在路由切换后被重建，丢掉了内联 transform：重新贴一次，保证手感连续。
    applyScale(false);
  };

  const onTouchMove = (event: TouchEvent) => {
    if (!pinching || event.touches.length !== 2 || startDistance === 0) return;
    event.preventDefault();
    const ratio = touchDistance(event.touches) / startDistance;
    scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, startScale * ratio));
    applyScale(false);
  };

  const onTouchEnd = (event: TouchEvent) => {
    if (event.touches.length > 0) return;
    if (pinching) {
      pinching = false;
      startDistance = 0;
      return;
    }
    const now = Date.now();
    if (now - lastTapAt < DOUBLE_TAP_MS && findTargets().length > 0) {
      lastTapAt = 0;
      resetPinchZoom();
      return;
    }
    lastTapAt = now;
  };

  window.addEventListener('touchstart', onTouchStart, { passive: true });
  window.addEventListener('touchmove', onTouchMove, { passive: false });
  window.addEventListener('touchend', onTouchEnd, { passive: true });
  window.addEventListener('touchcancel', onTouchEnd, { passive: true });
};
