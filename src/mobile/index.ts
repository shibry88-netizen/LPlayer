import { installBackButtonHandler } from "./backButton";
import { installPinchZoom } from "./pinchZoom";
import { startPerfWatch } from "./perfTier";
import { StatusBar } from "@capacitor/status-bar";

export const installMobileShell = (): void => {
  startPerfWatch();
  void installBackButtonHandler();
  installPinchZoom();
  void StatusBar.setOverlaysWebView({ overlay: true }).catch(() => {});
};

export { getPerfTier, setPerfTier } from "./perfTier";
