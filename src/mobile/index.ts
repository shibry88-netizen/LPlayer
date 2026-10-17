// LPlayer 手机端适配层入口：性能档采样 + 安卓返回键层级栈 + 横竖屏识别 + 双指缩放。
import { StatusBar } from '@capacitor/status-bar';
import { installBackButtonHandler } from './backButton';
import { installOrientationWatcher } from './orientation';
import { installPinchZoom } from './pinchZoom';
import { startPerfWatch } from './perfTier';

export const installMobileShell = (): void => {
    // 内容要一直延伸到状态栏/导航栏下面（edge-to-edge）。Capacitor 的这条配置只在插件初始化时
    // 应用一次，个别 ROM 上会丢，于是状态栏区域露出窗口背景。这里再确认一次；
    // 网页环境下插件会直接 reject，吞掉即可。
    void StatusBar.setOverlaysWebView({ overlay: true }).catch(() => undefined);
    installOrientationWatcher();
    startPerfWatch();
    void installBackButtonHandler();
    installPinchZoom();
};

export { getPerfTier, setPerfTier } from './perfTier';
export { isPortraitViewport } from './orientation';
