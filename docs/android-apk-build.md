# Android APK 构建（Capacitor 自构建路线）

本分支只是把「Web 产物 → Capacitor → APK」这条链路固化下来，方便以后重建。
上游 folia-major 不发布 Android 安装包，官方示范仓库是
[chthollyphile/folia-sonnet](https://github.com/chthollyphile/folia-sonnet)（已归档、基于 0.6.7）。

## 产物

- applicationId `top.izuna.foliamajor`，App 名 `Folia`
- minSdk 22 / targetSdk 34 / compileSdk 34
- 容器 Capacitor 6（**必须 6.x**：Capacitor 7 需要 JDK 21，构建机只有 JDK 17）
- debug keystore 自签名，仅供侧载

## 环境

Node 24、JDK 17、Android SDK（platforms;android-34 + build-tools;34.0.0）、Gradle 8.2.1。

## 步骤

```bash
npm ci
npm i @capacitor/core@6 @capacitor/android@6 @capacitor/splash-screen@6 @capacitor/status-bar@6
npm i -D @capacitor/cli@6

npm run build                     # 产出 dist/

npx cap add android               # 只需一次
npx cap sync android              # 每次改完 Web 都要重跑
cd android && ./gradlew assembleDebug
# 产物：android/app/build/outputs/apk/debug/app-debug.apk
```

## 踩过的坑

1. **`capacitor.config.ts` 解析失败**：`@capacitor/cli@6` + TypeScript 5 会报
   `TypeError: Cannot read properties of undefined (reading 'CommonJS')`。
   改用 `capacitor.config.json`（本文件同目录那份），或降级 typescript。
2. **Capacitor 版本**：7 要 JDK 21；构建机只有 JDK 17 → 用 6。
3. **Android SDK**：Capacitor 6 模板要 compileSdk 34，缺就
   `sdkmanager "platforms;android-34" "build-tools;34.0.0"`。
4. **Gradle 下载**：把 `android/gradle/wrapper/gradle-wrapper.properties` 的
   `distributionUrl` 换成国内镜像（如 `https://mirrors.cloud.tencent.com/gradle/gradle-8.2.1-bin.zip`）。
5. **PWA service worker**：Web 产物带 SW，装进 WebView 后更新可能吃到旧缓存，
   真机上遇到「改了没生效」先想它。

## 已知限制

- 在线音乐（网易云 / 酷狗 / QQ）需要在 `npm run build` **之前**通过 `.env.local`
  里的 `VITE_*_API_BASE` 指向自建后端，否则只有界面与基础播放能力。
- 本地音乐目录导入依赖浏览器目录选择器，Android WebView 下未验证。
- 后台播放、锁屏媒体控制、前台服务未适配。
