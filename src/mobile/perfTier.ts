// LPlayer 手机端适配 · P0-7 玻璃模糊性能三档
// 每秒采样一次帧时间：平均 > 20ms 自动降一档，写进 <html data-lp-perf>。
export type PerfTier = 'high' | 'mid' | 'low';

const ORDER: PerfTier[] = ['high', 'mid', 'low'];
const STORAGE_KEY = 'lplayer:perf-tier';

const readStored = (): PerfTier | null => {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'high' || value === 'mid' || value === 'low' ? value : null;
  } catch {
    return null;
  }
};

const isTouchDevice = (): boolean => {
  try {
    return typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
  } catch {
    return false;
  }
};

let tier: PerfTier = readStored() ?? (isTouchDevice() ? 'mid' : 'high');

export const applyPerfTier = (): void => {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (tier === 'high') root.removeAttribute('data-lp-perf');
  else root.setAttribute('data-lp-perf', tier);
};

export const getPerfTier = (): PerfTier => tier;

export const setPerfTier = (next: PerfTier, persist = true): void => {
  tier = next;
  if (persist) {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* 无痕模式等场景忽略 */
    }
  }
  applyPerfTier();
  window.dispatchEvent(new CustomEvent('lp:perf-tier', { detail: tier }));
};

/** 采样帧时间，连续掉帧就自动降一档（只降不升，避免抖动）。 */
export const startPerfWatch = (): void => {
  if (typeof requestAnimationFrame !== 'function') return;
  let windowStart = performance.now();
  let lastFrame = windowStart;
  let sampleSum = 0;
  let sampleCount = 0;

  const tick = (now: number): void => {
    const delta = now - lastFrame;
    lastFrame = now;
    if (delta > 0 && delta < 400) {
      sampleSum += delta;
      sampleCount += 1;
    }
    if (now - windowStart >= 1000) {
      const average = sampleCount > 0 ? sampleSum / sampleCount : 0;
      windowStart = now;
      sampleSum = 0;
      sampleCount = 0;
      if (average > 20 && tier !== 'low') {
        setPerfTier(ORDER[Math.min(ORDER.indexOf(tier) + 1, ORDER.length - 1)], true);
      }
    }
    requestAnimationFrame(tick);
  };

  requestAnimationFrame(tick);
};

applyPerfTier();
