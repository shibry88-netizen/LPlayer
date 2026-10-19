package top.izuna.foliamajor;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.webkit.WebView;

import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * LPlayer 的原生媒体会话（0.7.19-m13 新增）。
 *
 * 为什么需要它：LPlayer 是 Capacitor 6 套上游 Web 播放器的壳，WebView 里的 HTML5 audio
 * 系统看不到，所以任何外部消费者（车载 HUD、锁屏、手表…）都拿不到"正在播什么"。
 * 这个服务把 WebView 的播放状态镜像成一条标准的 Android MediaSession，
 * 于是**不用改一行 Web 前端**，LPlayer 就能被系统与第三方正常识别；
 * 顺带把「后台播放」也修了 —— 前台服务让进程不会在切后台后被回收。
 *
 * 读取方式：每秒用 evaluateJavascript 问一次 WebView
 *   - navigator.mediaSession.metadata（Web 播放器一般都会设，供媒体键用）
 *   - <audio> 元素的 paused / currentTime / duration
 * 拿不到 metadata 时退回 document.title，至少不会显示空白。
 */
public class NowPlayingService extends Service {

    public static final String CHANNEL = "lplayer_now_playing";
    public static final String ACTION_CTL = "top.izuna.foliamajor.CTL";

    private static final int NOTI_ID = 0x4C50;
    private static final long POLL_MS = 1000L;

    /** 由 MainActivity 挂上来的 WebView（宿主 Activity 结束后失效，属预期） */
    private static volatile WebView sWebView;

    private final Handler h = new Handler(Looper.getMainLooper());

    private MediaSession session;
    private Bitmap art;
    private String lastTitle = "";
    private String lastArtist = "";
    private String lastAlbum = "";
    private String lastArtUrl = "\u0000";
    private String notifiedTitle = "\u0000";
    private boolean playing = false;

    /** 挂 WebView 并拉起服务（前台服务：切后台不被回收，顺便修后台播放） */
    public static void attach(Context ctx, WebView wv) {
        sWebView = wv;
        try {
            Intent i = new Intent(ctx, NowPlayingService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(i);
            } else {
                ctx.startService(i);
            }
        } catch (Throwable ignored) {
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        try {
            session = new MediaSession(this, "LPlayer");
            session.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS
                    | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
            session.setCallback(new MediaSession.Callback() {
                @Override
                public void onPlay() {
                    jsPlay();
                }

                @Override
                public void onPause() {
                    jsPause();
                }

                @Override
                public void onStop() {
                    jsPause();
                }

                @Override
                public void onSkipToNext() {
                    jsKey("MediaTrackNext");
                }

                @Override
                public void onSkipToPrevious() {
                    jsKey("MediaTrackPrevious");
                }
            });
            session.setPlaybackState(playbackState(false, 0L));
            session.setActive(true);
        } catch (Throwable ignored) {
        }
        startFg(buildNotification("LPlayer", "准备中…"));
        h.postDelayed(tick, 800L);
    }

    private void startFg(Notification n) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTI_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            } else {
                startForeground(NOTI_ID, n);
            }
        } catch (Throwable t) {
            // 有些 ROM 在通知权限被关时不允许前台服务，退化成普通服务，不影响 MediaSession
            try {
                startForeground(NOTI_ID, n);
            } catch (Throwable ignored) {
            }
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        try {
            if (intent != null && ACTION_CTL.equals(intent.getAction())) {
                String what = intent.getStringExtra("what");
                if ("toggle".equals(what)) {
                    if (playing) {
                        jsPause();
                    } else {
                        jsPlay();
                    }
                } else if ("next".equals(what)) {
                    jsKey("MediaTrackNext");
                } else if ("prev".equals(what)) {
                    jsKey("MediaTrackPrevious");
                }
            }
        } catch (Throwable ignored) {
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        try {
            h.removeCallbacks(tick);
        } catch (Throwable ignored) {
        }
        try {
            if (session != null) {
                session.setActive(false);
                session.release();
                session = null;
            }
        } catch (Throwable ignored) {
        }
        super.onDestroy();
    }

    // ---------------------------------------------------------------- 轮询 WebView

    private static final String JS_PROBE =
            "(function(){try{"
                    + "var ms=navigator.mediaSession&&navigator.mediaSession.metadata;"
                    + "var a=document.querySelector('audio');"
                    + "var au=null;"
                    + "if(a){au={p:!a.paused,c:a.currentTime||0,"
                    + "d:(a.duration&&isFinite(a.duration))?a.duration:0};}"
                    + "return JSON.stringify({"
                    + "dt:document.title||'',"
                    + "ms:ms?{t:ms.title||'',ar:ms.artist||'',al:ms.album||'',"
                    + "art:(ms.artwork&&ms.artwork.length)?ms.artwork[ms.artwork.length-1].src:''}:null,"
                    + "au:au});"
                    + "}catch(e){return '';}})()";

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            poll();
            h.postDelayed(this, POLL_MS);
        }
    };

    private void poll() {
        final WebView wv = sWebView;
        if (wv == null) {
            return;
        }
        try {
            wv.evaluateJavascript(JS_PROBE, new android.webkit.ValueCallback<String>() {
                @Override
                public void onReceiveValue(String value) {
                    apply(value);
                }
            });
        } catch (Throwable ignored) {
        }
    }

    private void apply(String raw) {
        if (raw == null || raw.length() < 4) {
            return;
        }
        try {
            Object o = new JSONTokener(raw).nextValue();
            if (!(o instanceof String)) {
                return;
            }
            String json = (String) o;
            if (json.length() == 0) {
                return;
            }
            JSONObject j = new JSONObject(json);
            JSONObject ms = j.optJSONObject("ms");
            JSONObject au = j.optJSONObject("au");

            String title = ms == null ? "" : ms.optString("t", "");
            String artist = ms == null ? "" : ms.optString("ar", "");
            String album = ms == null ? "" : ms.optString("al", "");
            String artUrl = ms == null ? "" : ms.optString("art", "");
            if (title.length() == 0) {
                title = j.optString("dt", "").trim();
            }
            if (artist.length() == 0) {
                artist = "LPlayer";
            }

            boolean nowPlaying = au != null && au.optBoolean("p", false);
            long pos = au == null ? 0L : (long) (au.optDouble("c", 0d) * 1000d);
            long dur = au == null ? 0L : (long) (au.optDouble("d", 0d) * 1000d);

            playing = nowPlaying;
            lastTitle = title;
            lastArtist = artist;
            lastAlbum = album;

            if (!artUrl.equals(lastArtUrl)) {
                lastArtUrl = artUrl;
                fetchArt(artUrl);
            }
            push(title, artist, album, nowPlaying, pos, dur);
        } catch (Throwable ignored) {
        }
    }

    private void push(String title, String artist, String album,
                      boolean nowPlaying, long pos, long dur) {
        try {
            if (session == null) {
                return;
            }
            MediaMetadata.Builder b = new MediaMetadata.Builder();
            b.putString(MediaMetadata.METADATA_KEY_TITLE, title);
            b.putString(MediaMetadata.METADATA_KEY_ARTIST, artist);
            if (album.length() > 0) {
                b.putString(MediaMetadata.METADATA_KEY_ALBUM, album);
            }
            if (dur > 0) {
                b.putLong(MediaMetadata.METADATA_KEY_DURATION, dur);
            }
            if (art != null) {
                b.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, art);
            }
            session.setMetadata(b.build());
            session.setPlaybackState(playbackState(nowPlaying, pos));

            if (!title.equals(notifiedTitle)) {
                notifiedTitle = title;
                NotificationManager nm =
                        (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                if (nm != null) {
                    nm.notify(NOTI_ID, buildNotification(title, artist));
                }
            }
        } catch (Throwable ignored) {
        }
    }

    private PlaybackState playbackState(boolean nowPlaying, long pos) {
        PlaybackState.Builder b = new PlaybackState.Builder();
        b.setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE
                | PlaybackState.ACTION_PLAY_PAUSE
                | PlaybackState.ACTION_SKIP_TO_NEXT
                | PlaybackState.ACTION_SKIP_TO_PREVIOUS);
        b.setState(nowPlaying ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                Math.max(0L, pos), nowPlaying ? 1f : 0f);
        return b.build();
    }

    // ---------------------------------------------------------------- 控制 WebView

    private void jsPlay() {
        js("(function(){var a=document.querySelector('audio');if(a&&a.paused){try{a.play();}catch(e){}}})()");
    }

    private void jsPause() {
        js("(function(){var a=document.querySelector('audio');if(a&&!a.paused){try{a.pause();}catch(e){}}})()");
    }

    private void jsKey(final String key) {
        js("(function(){try{var e=new KeyboardEvent('keydown',{key:'" + key
                + "',bubbles:true});document.dispatchEvent(e);}catch(x){}})()");
    }

    private void js(final String code) {
        final WebView wv = sWebView;
        if (wv == null) {
            return;
        }
        h.post(new Runnable() {
            @Override
            public void run() {
                try {
                    wv.evaluateJavascript(code, null);
                } catch (Throwable ignored) {
                }
            }
        });
    }

    private void fetchArt(final String url) {
        if (url == null || url.length() == 0) {
            art = null;
            return;
        }
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                    c.setConnectTimeout(6000);
                    c.setReadTimeout(8000);
                    c.setInstanceFollowRedirects(true);
                    InputStream in = c.getInputStream();
                    final Bitmap bm = BitmapFactory.decodeStream(in);
                    in.close();
                    c.disconnect();
                    if (bm != null) {
                        h.post(new Runnable() {
                            @Override
                            public void run() {
                                art = bm;
                            }
                        });
                    }
                } catch (Throwable ignored) {
                }
            }
        }).start();
    }

    // ---------------------------------------------------------------- 通知

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        try {
            NotificationManager nm =
                    (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null || nm.getNotificationChannel(CHANNEL) != null) {
                return;
            }
            NotificationChannel ch = new NotificationChannel(CHANNEL, "正在播放",
                    NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            ch.setSound(null, null);
            nm.createNotificationChannel(ch);
        } catch (Throwable ignored) {
        }
    }

    private Notification buildNotification(String title, String sub) {
        ensureChannel();
        int piFlag = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                ? PendingIntent.FLAG_IMMUTABLE : 0;

        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent content = PendingIntent.getActivity(this, 1, open, piFlag);

        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            b = new Notification.Builder(this, CHANNEL);
        } else {
            b = new Notification.Builder(this);
        }
        b.setContentTitle(title == null || title.length() == 0 ? "LPlayer" : title)
                .setContentText(sub == null ? "" : sub)
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setContentIntent(content)
                .setOngoing(true)
                .setShowWhen(false);

        Notification.MediaStyle st = new Notification.MediaStyle();
        if (session != null) {
            st.setMediaSession(session.getSessionToken());
        }
        st.setShowActionsInCompactView(0, 1, 2);
        b.setStyle(st);

        b.addAction(new Notification.Action.Builder(android.R.drawable.ic_media_previous,
                "上一首", ctl("prev")).build());
        b.addAction(new Notification.Action.Builder(
                playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                playing ? "暂停" : "播放", ctl("toggle")).build());
        b.addAction(new Notification.Action.Builder(android.R.drawable.ic_media_next,
                "下一首", ctl("next")).build());
        return b.build();
    }

    private PendingIntent ctl(String what) {
        Intent i = new Intent(this, NowPlayingService.class)
                .setAction(ACTION_CTL)
                .putExtra("what", what);
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                ? PendingIntent.FLAG_IMMUTABLE : 0;
        return PendingIntent.getService(this, what.hashCode(), i, flags);
    }
}
