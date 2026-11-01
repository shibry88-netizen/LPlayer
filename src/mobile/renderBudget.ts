import { getPerfTier } from './perfTier';

// src/mobile/renderBudget.ts
//
// 可视化（pixi 主题）每帧的像素量 = 宽 × 高 × resolution²。分辨率从 2 倍降到 1.5 倍，
// 像素量少 44%，而发光/模糊这类画面本来就不靠像素级锐利，肉眼看不出差别。
//
// 什么时候降：只在「已经掉帧」时降。perfTier 会按帧时间自动降档（见 perfTier.ts），
// 正常设备一直是 high，这条规则不会生效 —— 所以默认观感不变。
// 桌面端不受影响。

const isTouchDevice = (): boolean => {
    try {
        return typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
    } catch {
        return false;
    }
};

/** 分辨率上限；`Number.POSITIVE_INFINITY` 表示不额外限制（仍受各主题自己的 MAX_RESOLUTION 约束）。 */
export const visualizerResolutionCap = (): number => {
    const tier = getPerfTier();
    if (!isTouchDevice()) return tier === 'low' ? 2 : Number.POSITIVE_INFINITY;
    // 手机上正常最多 2 倍（超过 2 倍在 400+ ppi 屏上看不出区别，只是白烧 GPU）
    return tier === 'low' ? 1.5 : 2;
};

/** 把 devicePixelRatio 夹到当前预算里。 */
export const budgetedPixelRatio = (devicePixelRatio: number): number => (
    Math.min(visualizerResolutionCap(), Math.max(1, devicePixelRatio || 1))
);
