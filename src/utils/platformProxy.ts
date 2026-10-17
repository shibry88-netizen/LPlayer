// src/utils/platformProxy.ts
//
// 网页版把跨域请求交给 `/api/lyric-proxy` —— 那是 Vite dev / preview 的中间件，部署到有服务端
// 的地方（Vercel / 自建 Node）时也在。
//
// 但安卓壳（Capacitor）里**没有服务端**：请求 `/api/lyric-proxy` 只会落到 WebView 的静态文件
// 回退，拿回 index.html。日志里的
//   SyntaxError: Unexpected token '<', "<!DOCTYPE " ... is not valid JSON
// 就是这么来的 —— QQ 歌词、酷狗歌词与搜索、封面图全都走这条路，于是一起失效。
//
// 原生壳里改成直连目标地址；跨域交给 CapacitorHttp（它把 fetch 换成原生请求，不受 CORS 约束）。

type ElectronWindow = Window & { electron?: unknown };
type CapacitorWindow = Window & { Capacitor?: { isNativePlatform?: () => boolean } };

export const isElectronShell = (): boolean => (
    typeof window !== 'undefined' && Boolean((window as ElectronWindow).electron)
);

export const isNativeShell = (): boolean => (
    typeof window !== 'undefined'
    && (window as CapacitorWindow).Capacitor?.isNativePlatform?.() === true
);

/** 需要直连、不能走 `/api/lyric-proxy` 的环境：Electron 桌面端与 Capacitor 原生壳。 */
export const usesDirectNetwork = (): boolean => isElectronShell() || isNativeShell();

/**
 * 把目标地址包装成当前环境该用的请求地址。
 * 网页版给代理 URL；原生壳直连（配合 CapacitorHttp 绕开 CORS）。
 */
export const resolveProxiedUrl = (targetUrl: string): string => (
    usesDirectNetwork() ? targetUrl : `/api/lyric-proxy?url=${encodeURIComponent(targetUrl)}`
);
