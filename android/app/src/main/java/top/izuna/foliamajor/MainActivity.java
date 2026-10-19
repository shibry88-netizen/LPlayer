package top.izuna.foliamajor;

import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

/**
 * 0.7.19-m13：挂上原生媒体会话（见 NowPlayingService）。
 *
 * 改动刻意做到最小：不动 Capacitor 自己的启动流程，只在 decorView 上延后一次，
 * 把 WebView 交给前台服务，由服务每秒把播放状态镜像成标准 MediaSession。
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        try {
            final MainActivity self = this;
            getWindow().getDecorView().postDelayed(new Runnable() {
                @Override
                public void run() {
                    try {
                        WebView wv = getBridge() != null ? getBridge().getWebView() : null;
                        if (wv != null) {
                            NowPlayingService.attach(self, wv);
                        }
                    } catch (Throwable ignored) {
                    }
                }
            }, 1500L);
        } catch (Throwable ignored) {
        }
    }
}
