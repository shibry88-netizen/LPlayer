#!/usr/bin/env python3
"""LPlayer · 给 Capacitor 生成的 AppDelegate 挂上 AVAudioSession(.playback)

为什么需要：
  WKWebView 里的 <audio> 默认拿不到后台播放能力 —— App 一进后台，系统就把音频掐掉。
  两件事一起做才有效：
    1) Info.plist 的 UIBackgroundModes 含 audio      （prepare-ios.sh 负责）
    2) AVAudioSession 类别设成 .playback             （本脚本负责）

幂等判据：源码里已出现 LPLAYER_AUDIO_SESSION 标记就直接返回。
用法：python3 packaging/ios/patch_appdelegate.py ios/App/App/AppDelegate.swift
"""
import re
import sys
import pathlib

MARK = "LPLAYER_AUDIO_SESSION"

INJECT = """
        // LPLAYER_AUDIO_SESSION: WKWebView 后台播放需要 .playback 类别
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [])
        } catch {
            NSLog("[LPlayer] AVAudioSession setCategory failed: \\(error)")
        }"""

FUNC_RE = re.compile(
    r"func\s+application\([^)]*didFinishLaunchingWithOptions[^)]*\)\s*->\s*Bool\s*\{",
    re.S,
)


def main(path_str: str) -> int:
    path = pathlib.Path(path_str)
    if not path.exists():
        print(f"✗ 文件不存在：{path}")
        return 1

    src = path.read_text(encoding="utf-8")

    if MARK in src:
        print("· AppDelegate 已打过补丁，跳过")
        return 0

    if "import AVFoundation" not in src:
        if "import Capacitor" in src:
            src = src.replace("import Capacitor", "import Capacitor\nimport AVFoundation", 1)
        else:
            src = "import AVFoundation\n" + src

    m = FUNC_RE.search(src)
    if not m:
        # 模板变了就只告警不阻断：构建能过，后台播放退化成「不保证」
        print("⚠ 找不到 didFinishLaunching 锚点（Capacitor 模板变了？）—— 跳过音频会话补丁")
        path.write_text(src, encoding="utf-8")
        return 0

    src = src[: m.end()] + INJECT + src[m.end():]
    path.write_text(src, encoding="utf-8")
    print(f"✓ 已注入 {MARK} → {path}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
