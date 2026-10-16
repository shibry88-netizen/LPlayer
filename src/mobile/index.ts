// LPlayer 手机端适配层入口：性能档采样 + 安卓返回键层级栈 + 横竖屏识别 + 双指缩放。
import { installBackButtonHandler } from './backButton';
import { installOrientationWatcher } from './orientation';
import { installPinchZoom } from './pinchZoom';
import { startPerfWatch } from './perfTier';

export const installMobileShell = (): void => {
    installOrientationWatcher();
    startPerfWatch();
    void installBackButtonHandler();
    installPinchZoom();
};

export { getPerfTier, setPerfTier } from './perfTier';
export { isPortraitViewport } from './orientation';
