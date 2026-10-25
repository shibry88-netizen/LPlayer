# 二号机（music.lucifer.yoga）的多用户隔离配置与操作手册

> 目的：LPlayer 分发给多个人用同一个后端时，**一个人不能看到/改到另一个人的账号数据**。
> 2026-10-25 做了一次完整审计，结论和加固都在这里。机器上的路径是 `/opt/music/`。

## 1. 结论先说：登录态本来就是按用户隔离的

三个音乐源（网易云 / QQ / 酷狗）的登录态**都存在 App 本地**，每次请求带给后端：

| 源 | 客户端怎么带 | 服务端是否存用户态 | 证据 |
| :-- | :-- | :-- | :-- |
| 网易云 | `?cookie=` 逐请求 | **不存** | NeteaseCloudMusicApi 无状态，cookie 只在请求里 |
| QQ | `?cookie=`（外部 base）或 `X-QQ-Session`（同源） | **不存账号凭证** | 容器只挂 `qq-device.json`，内容是 IMEI/AndroidID/model，见第 4 节实测 |
| 酷狗 | `?cookie=` 逐请求（`kugouTransport.ts:482`） | **不存** | KuGouMusicApi 1.6.0：`server.js` 把 `req.cookies` 与 `query.cookie` 合并后逐请求使用，全仓无 `fs.writeFile` |

所以「A 用户登录 QQ 后 B 用户变成 A」这种事**不会发生** —— 前提是别开服务端会话仓库（见第 3 节）。

## 2. 审计揪出来的真问题：cookie 明文进日志

问题不在业务数据，在**日志**：日志文件是所有用户共用的一份，而客户端把 cookie 放在 URL query 里。

| 位置 | 审计前 | 处理 |
| :-- | :-- | :-- |
| nginx `access.log` | combined 格式记 `$request` → **含 `?cookie=` 真值**（实测 28 条） | 换 `folia_noquery` 格式，只记 `$uri`，输出到 `music-api.log` |
| nginx `error.log` | 上游报错时打印 request 行 → 同样含 cookie | 音乐单独 `error_log /var/log/nginx/music-error.log warn` + logrotate 每日只留 3 份 |
| netease 容器 stdout | `Request Success: ... ${decode(req.originalUrl)}` → **cookie 真值**（实测 261 条），且无日志级别开关 | compose 里 `logging: driver: none` |
| qq 容器 stdout | 自带 `sanitizeRequestUrl`，`cookie=*** MASKED ***` | 保留日志，加 `max-size: 10m / max-file: 3` |
| 历史日志 | 上述三个文件里的旧记录 | 就地 `sed` 打码成 `<redacted>` |

## 3. 三条铁律

1. **不要设 `QQ_AUTH_SESSION_PATH`**（也不要在其它源上启用服务端会话仓库）。
   一旦设了，登录凭证就从「客户端持有」变成「容器内一个加密文件」= 全局一个账号，所有人共用。
2. **新加 API 源时，日志必须先过一遍**：这个源会不会把原始 URL 打进日志？有没有日志级别开关？
   没有就 `logging: driver: none`，有就打码/降级。酷狗上线时按第 5 节做。
3. **新 location 一律挂在 `access_log ... folia_noquery` 下**（server 级已设，新增 location 自动继承）。

## 4. 实测：qq-device.json 里到底有什么

```json
{"version":1,"device":{"display":"QMAPI.176059.001","product":"iarim","device":"sagit","board":"eomam",
"model":"MI 6","fingerprint":"xiaomi/iarim/sagit:10/...","imei":"4796...","brand":"Xiaomi",
"androidId":"72be...","openUdid":"02c0..."}}
```

只有设备指纹，**没有 `musickey`、MQTT token 或任何账号凭证**。

## 5. 还剩两处「共用」（不是数据泄漏，但要知道）

1. **上游设备身份共用**：QQ 后端对所有用户上报的是同一台「MI 6」，IMEI/AndroidID 全局一份。
   后果不是串号，而是**风控连坐** —— 一个人行为异常，上游可能对整个设备指纹限流。
   要真正按用户隔离设备身份，只能一人一实例（QQ API 的 `QQ_AUTH_STATE_PATH` 是进程级路径，不支持按请求切换）。
2. **出口 IP 共用**：上游按 IP 限流，人多时更容易触发 20028/验证码。

代价参考：二号 2C / 1967MB / 已加 1G swap，netease+qq 两容器约占 120MB，
每加一个 API 容器约 +80~150MB。一人一实例最多撑 3~4 人，不建议。

## 6. 酷狗（2026-10-25 已上线）

| 项 | 值 |
| :-- | :-- |
| 镜像 | `papersman/folia-kugou-api:latest` |
| 容器 | `music-kugou-api-1`，`127.0.0.1:3300→3000`，`read_only: true` + `tmpfs /tmp` |
| 路由 | `/kugou/` → `http://127.0.0.1:3300/`（同样挂 `folia_noquery` 日志格式） |
| App 侧 | `VITE_KUGOU_API_BASE=https://music.lucifer.yoga/kugou`（构建期写死，改了就得出新包） |

实测：
- `GET /kugou/search?keyword=周杰伦&page=1&pagesize=2` → 200，`status:1`，真实曲目
- `OPTIONS` 预检 → **204**，`access-control-allow-origin: https://localhost`（WebView 跨域必需）
- 探针请求 `/kugou/user/detail?cookie=KUGOU_PROBE_XYZ` → 日志里命中 **0**（access + error 都没有）
- 容器日志：目前只有启动行，不带 URL；但**没有 `sanitizeRequestUrl`**，所以保留 `json-file` 限 10m×3，
  一旦它开始打印请求行要立刻改 `driver: none`（与 netease 同样处理）

### 6.1 酷狗的付费墙（2026-10-25 实测）

| 请求 | 结果 |
| :-- | :-- |
| `/song/url` 不带 `dfid` | `errcode 20028`「本次请求需要验证」（一律） |
| `/song/url` 带 `dfid` | 免费曲 → 有直链；热门曲 → `fail_process:["pkg","buy"]`、`pay_type:3`、`privilege:10`，**无 url** |
| 再叠加完整设备指纹（MID/GUID/DEV/MAC/WEBGL） | 仍 `pkg,buy` → 真付费墙 |
| 老接口 `m.kugou.com/app/i/getSongInfo.php` | 也空（`privilege:10`） |

抽样 8 首里只有 2 首能拿到直链。**未登录/非会员 = 只能听免费曲**，用户感知为「只有纯音乐能播」。
App 侧（`kugouProvider`）已把这类响应升成 `membership-required` / `purchase-required` / `entitlement-required`，
不再误报成网络失败。

> KuGouMusicApi 1.6.0 是**逐请求无状态**的（`server.js` 把 `req.cookies` 与 `query.cookie` 合并后使用，
> 全仓无 `fs.writeFile`），所以容器不需要卷，登录态天然留在 App 侧。

## 7. 一键加固脚本

`bash harden-isolation.sh`（幂等）。做四件事：写 log_format → 挂 access_log/error_log →
compose 关掉 netease 日志 → 清洗历史日志 → 自检探针。

自检通过的标准：
- `music-api.log` 尾行形如 `"GET /qq/login/status HTTP/2.0"`，**没有 query**
- 用 `?cookie=PROBE` 打一次，`grep PROBE` 在 `music-api.log` / `music-error.log` 里为 0
- `docker logs music-netease-api-1` 为空

## 8. 文件清单

| 机器上 | 仓库里 |
| :-- | :-- |
| `/opt/music/compose.yaml` | `deploy/lucifer-yoga/music/compose.yaml` |
| `/etc/nginx/sites-available/music.conf` | `deploy/lucifer-yoga/music/nginx-music.conf` |
| `/etc/nginx/conf.d/folia-log.conf` | `deploy/lucifer-yoga/music/nginx-folia-log.conf` |
| `/etc/logrotate.d/music-nginx` | `deploy/lucifer-yoga/music/logrotate-music-nginx` |
| `/tmp/harden_*.sh` | `deploy/lucifer-yoga/music/harden-isolation.sh` |
