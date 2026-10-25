#!/usr/bin/env bash
# LPlayer · iOS 工程准备（幂等，可重复执行）
#
#   1) ios/ 不存在 -> npx cap add ios（含 pod install）
#   2) npx cap sync ios（dist -> WebView 资源 + 插件 PBX 注册）
#   3) Info.plist 打补丁：ATS / 后台音频 / 显示名 / 状态栏
#   4) AppDelegate.swift 打补丁：AVAudioSession = .playback
#
# 只能在 macOS 上跑（Xcode + CocoaPods）。iOS 工程目录不入库，
# 所有「手改」都收敛在本脚本 + patch_appdelegate.py 里（同安卓的 patch/ 思路）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

PLIST="ios/App/App/Info.plist"
APPDELEGATE="ios/App/App/AppDelegate.swift"

if [ ! -d ios ]; then
  echo "==> npx cap add ios"
  npx cap add ios
else
  echo "==> ios/ 已存在，跳过 cap add（要重来就 rm -rf ios）"
fi

echo "==> npx cap sync ios"
npx cap sync ios

[ -f "$PLIST" ] || { echo "✗ 找不到 $PLIST"; exit 1; }

pb() { /usr/libexec/PlistBuddy -c "$1" "$PLIST" >/dev/null 2>&1 || true; }
pb_bool() { pb "Add :$1 bool $2"; pb "Set :$1 $2"; }
pb_str()  { pb "Add :$1 string $2"; pb "Set :$1 $2"; }

# ---- 1. ATS：网易云 / QQ 的播放直链是 http://，iOS 默认一律拦掉 ----------
#     安卓那边是 allowMixedContent + usesCleartextTraffic，iOS 没有对应开关，
#     只能在 Info.plist 里放开。App 走 capacitor://localhost，不是 https 源，
#     所以不用担心混合内容策略，只差 ATS 这一道。
echo "==> Info.plist · NSAppTransportSecurity"
pb "Add :NSAppTransportSecurity dict"
pb_bool "NSAppTransportSecurity:NSAllowsArbitraryLoads" true
pb_bool "NSAppTransportSecurity:NSAllowsArbitraryLoadsInWebContent" true

# ---- 2. 后台播放：WKWebView 的 <audio> 要 audio 背景模式 --------------------
#     注意这只是「允许」，真正让音频活下去还要 AppDelegate 里的 .playback 类别。
echo "==> Info.plist · UIBackgroundModes = [audio]"
/usr/libexec/PlistBuddy -c "Delete :UIBackgroundModes" "$PLIST" >/dev/null 2>&1 || true
/usr/libexec/PlistBuddy -c "Add :UIBackgroundModes array" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :UIBackgroundModes:0 string audio" "$PLIST"

# ---- 3. 显示名 / 状态栏 / 版本号 -------------------------------------------
# cap add ios 生成的模板写死 1.0 / 1，必须覆盖：
#   CFBundleShortVersionString = package.json 的 version（0.7.19）
#   CFBundleVersion            = 整数构建号（CI 传 run_number，自签工具靠它判断升级）
echo "==> Info.plist · 显示名、状态栏与版本号"
pb_str "CFBundleDisplayName" "LPlayer"
pb_str "UIStatusBarStyle" "UIStatusBarStyleLightContent"
pb_str "UIUserInterfaceStyle" "Dark"

APP_VERSION="$(node -p "require('./package.json').version")"
APP_BUILD="${LPLAYER_IOS_BUILD:-1}"
case "$APP_BUILD" in
  ''|*[!0-9]*) echo "✗ LPLAYER_IOS_BUILD 必须是整数，收到：$APP_BUILD"; exit 1 ;;
esac
pb_str "CFBundleShortVersionString" "$APP_VERSION"
pb_str "CFBundleVersion" "$APP_BUILD"
echo "    version=$APP_VERSION build=$APP_BUILD"

# ---- 4. AppDelegate：AVAudioSession ---------------------------------------
echo "==> AppDelegate.swift · AVAudioSession = .playback"
python3 packaging/ios/patch_appdelegate.py "$APPDELEGATE"

# ---- 5. 自检（把关键项打出来，CI 日志里一眼可核对） ------------------------
echo "==> 自检"
/usr/libexec/PlistBuddy -c "Print :NSAppTransportSecurity" "$PLIST" || true
/usr/libexec/PlistBuddy -c "Print :UIBackgroundModes" "$PLIST" || true
/usr/libexec/PlistBuddy -c "Print :CFBundleDisplayName" "$PLIST" || true
/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$PLIST" || true
/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "$PLIST" || true
grep -n "LPLAYER_AUDIO_SESSION" "$APPDELEGATE" || echo "⚠ AppDelegate 未打上音频会话补丁（后台播放可能被系统掐断）"
echo "==> OK"
