> LPlayer 的 iOS 侧（Capacitor + GitHub Actions macOS runner）现状与流程。
> 上游不发 iOS 包；和安卓一样，走「Web 产物 → Capacitor iOS 容器 → IPA」。
> 相关：《LPlayer · 安卓 APK 自构建记录》《LPlayer · 手机端 UI 适配设计规范》。

## 1. 一句话

`ios/` 工程**不入库**（同安卓 `android/` 的做法），由 `packaging/ios/prepare-ios.sh` 现场生成 + 打补丁；
构建在 **GitHub Actions `macos-14`** 上跑，产物是**未签名 ipa**，装机靠自签（Sideloadly / AltStore）或 TrollStore。

仓库 public → macOS runner 免费不限时长，不用自己的 Mac，也不用云 Mac 按时计费。

## 2. 产物与命名

| 项 | 值 |
| :-- | :-- |
| 触发 | Actions → **iOS 无签名 IPA** → Run workflow，或打 tag `ios-v*` |
| 产物 | `LPlayer-<version>-<suffix>-ios-unsigned.ipa`（如 `LPlayer-0.7.19-i1-ios-unsigned.ipa`） |
| Bundle ID | `top.izuna.foliamajor`（与安卓同 appId；两者可共存于同一 Apple ID） |
| 产物存放 | Actions 运行页的 Artifacts（保留 30 天），**不自动发 Release** |
| 签名 | 无。`CODE_SIGNING_ALLOWED=NO` 归档后直接把 `App.app` 塞进 `Payload/` 打的包 |

**版本命名**：安卓用 `-mN`，iOS 用 `-iN`，两边各自递增，互不干扰。

## 3. 构建链路（5 步）

```bash
npm ci                                        # 锁文件安装
npm install @capacitor/ios@^6.2.2 --no-save   # 不进 package.json/lockfile
npm run build                                 # → dist/
bash packaging/ios/prepare-ios.sh               # cap add ios → cap sync → 打补丁
xcodebuild archive + zip 成 ipa               # 无签名
```

`--no-save` 是刻意的：`@capacitor/ios` 一旦写进 package.json 而 lockfile 没跟着更新，
下一次 `npm ci` 会因为「不同步」直接失败。

本机（Mac）复现同上，只是把 `xcodebuild` 那步换成 Xcode GUI 也行。

## 4. iOS 侧踩的坑（和安卓的坑不是一套）

| # | 坑 | 处理 |
| :-- | :-- | :-- |
| 1 | **ATS 拦 http 播放直链** —— 网易云 / QQ 的 CDN 是 `http://`，安卓靠 `allowMixedContent` + `usesCleartextTraffic`，iOS 没有这两个开关 | `Info.plist` 加 `NSAppTransportSecurity` → `NSAllowsArbitraryLoads` + `NSAllowsArbitraryLoadsInWebContent` |
| 2 | **后台播放被掐** —— WKWebView 的 `<audio>` 默认没有后台能力 | ① `UIBackgroundModes = [audio]`；② AppDelegate 里 `AVAudioSession.setCategory(.playback)`。**两个都要，少一个就不生效** |
| 3 | **混合内容策略** —— App 跑在 `capacitor://localhost`（不是 https），所以混合内容那道门不生效，只剩 ATS | 只处理 ATS 就够 |
| 4 | **没有返回键** —— `src/mobile/backButton.ts` 依赖 Capacitor `App` 的 `backButton` 事件，iOS 不会触发 | 目前靠 UI 自身的返回按钮；手势返回（边缘滑动）没做 |
| 5 | **Service Worker** —— 产物带 PWA SW，WKWebView 对 SW 支持极弱，注册会静默失败 | 不影响功能，但「更新吃旧缓存」这条在 iOS 上不成立，反而是好事 |
| 6 | **`/api/lyric-proxy` 不存在** —— 同安卓 m10 的坑 | m10 已改直连 + `CapacitorHttp.enabled`，iOS 走同一份 Web 产物，无需再改 |
| 7 | **Pixi 渲染的主题**没做竖屏适配 | 与安卓同状态，iOS 上一样 |
| 8 | 应用图标仍是 Capacitor 默认图标 | 设计师 SVG 已在，未写进 `AppIcon.appiconset`，与安卓同待办 |

**`ios.contentInset: "never"`**（写进 `capacitor.config.json`）：安全区交给 Web 侧的 `env(safe-area-inset-*)`，
不让 Capacitor 再叠一层 inset，否则上下会出现两条额外留白。

## 5. 装机（无签名包的三种走法）

| 方式 | 条件 | 有效期 | 备注 |
| :-- | :-- | :-- | :-- |
| **Sideloadly / AltStore（免费 Apple ID）** | Windows/Mac + 数据线 | **7 天**，过期重签；同时最多 3 个自签 App | 最通用。免费账号不能开某些能力，但播放器用不到 |
| **TrollStore** | 设备系统在 TrollStore 支持区间、且未升级 | 长期 | 免签直装 ipa；受系统版本限制 |
| **付费开发者账号（$99/年）** | 有账号 | 1 年 | 用 `.mobileprovision` 导出正式包，或走 TestFlight 分发 |

**第一次装机必看**：设置 → 通用 → VPN与设备管理 → 信任开发者证书，否则点了图标闪退。

## 6. 想换成正式签名包时

需要三样：`Apple Development/Distribution` 证书（`.p12`）、`Provisioning Profile`（`.mobileprovision`）、
Team ID。做法：
1. 证书 base64 存进仓库 Secrets（`IOS_CERT_P12`、`IOS_CERT_PASSWORD`、`IOS_PROFILE`、`IOS_TEAM_ID`）；
2. 归档时去掉 `CODE_SIGNING_ALLOWED=NO`，换成 `xcodebuild -exportArchive -exportOptionsPlist ExportOptions.plist`；
3. `ExportOptions.plist` 里 `method` 用 `development`（自用装机）或 `app-store`（上架）。

## 7. 待办

- [ ] 应用图标 / 启动图（`AppIcon.appiconset` + `Splash.imageset`，用设计师那份 SVG）
- [ ] 首轮真机验证：登录、播放、歌词（中英文）、封面、后台播放、锁屏媒体控制
- [ ] 边缘滑动手势返回（替代安卓的物理返回键）
- [ ] 若 `Pixi` 主题在 iOS 上掉帧，按 `perfTier` 的参数再压一档
