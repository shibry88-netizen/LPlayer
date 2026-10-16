// LPlayer 手机端适配 · P0-6 安卓返回键层级栈
// 顺序：关掉最上层弹层 → SPA 回退 → 双击退出。
import { App } from '@capacitor/app';

const EXIT_WINDOW_MS = 2000;
let lastBackAt = 0;

const TOP_LAYER_SELECTORS = [
  '[role="dialog"][data-state="open"]',
  '[aria-modal="true"]',
  '[data-state="open"][role="dialog"]',
  '[data-lp-sheet="open"]',
];

const findTopLayer = (): HTMLElement | null => {
  for (const selector of TOP_LAYER_SELECTORS) {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>(selector));
    const visible = nodes.filter((node) => node.getClientRects().length > 0);
    if (visible.length > 0) return visible[visible.length - 1];
  }
  return null;
};

/** 大多数弹层监听 Escape；先发键，再给一次「点遮罩」兜底。 */
const dismissTopLayer = (): boolean => {
  const layer = findTopLayer();
  if (!layer) return false;
  const eventInit: KeyboardEventInit = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
  document.dispatchEvent(new KeyboardEvent('keydown', eventInit));
  window.dispatchEvent(new KeyboardEvent('keydown', eventInit));
  if (!layer.getClientRects().length) return true;
  layer.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return true;
};

const showExitHint = (): void => {
  const id = 'lp-exit-hint';
  let el = document.getElementById(id) as HTMLDivElement | null;
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    el.textContent = '再按一次退出';
    el.setAttribute('data-lp-no-touch', '');
    el.style.cssText = [
      'position:fixed',
      'left:50%',
      'transform:translateX(-50%)',
      'bottom:max(env(safe-area-inset-bottom),24px)',
      'padding:8px 16px',
      'border-radius:999px',
      'background:rgba(20,20,22,.92)',
      'color:#fff',
      'font-size:14px',
      'z-index:2147483647',
      'pointer-events:none',
      'transition:opacity .2s ease',
      'opacity:0',
    ].join(';');
    document.body.appendChild(el);
  }
  requestAnimationFrame(() => {
    el!.style.opacity = '1';
  });
  window.setTimeout(() => {
    if (el) el.style.opacity = '0';
  }, 1600);
};

export const installBackButtonHandler = async (): Promise<void> => {
  try {
    await App.addListener('backButton', () => {
      if (dismissTopLayer()) return;
      if (window.history.length > 1) {
        window.history.back();
        return;
      }
      const now = Date.now();
      if (now - lastBackAt < EXIT_WINDOW_MS) {
        void App.exitApp();
        return;
      }
      lastBackAt = now;
      showExitHint();
    });
  } catch {
    /* 非 Capacitor 环境（浏览器 / 桌面端）静默跳过 */
  }
};
