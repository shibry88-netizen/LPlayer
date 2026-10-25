#!/usr/bin/env bash
# 二号 · 音乐后端多用户隔离加固（幂等，可重复跑）
#
# 解决的问题：客户端把登录 cookie 放在 URL query（?cookie=），
#   combined 格式的 access.log / error.log 会把真值落盘，多个用户共用一个日志文件。
#
# 做四件事：
#   1) nginx 换成不含 query 的 log_format，access/error 各自独立文件
#   2) compose 关掉 netease 容器的日志（它打印原始 URL 且无日志级别开关）
#   3) 就地清洗历史日志里的 cookie 真值
#   4) 用探针验证：发一个带 cookie=PROBE 的请求，日志里必须搜不到
#
# 用法（在二号上）：
#   bash harden-isolation.sh            # 全套
#   bash harden-isolation.sh verify     # 只跑自检
set -euo pipefail

MUSIC_DIR=${MUSIC_DIR:-/opt/music}
CONF=/etc/nginx/sites-available/music.conf
LOG_FMT=/etc/nginx/conf.d/folia-log.conf
ACCESS_LOG=/var/log/nginx/music-api.log
ERROR_LOG=/var/log/nginx/music-error.log
PROBE=PROBE_SHOULD_NOT_APPEAR

verify() {
  echo "=== 自检 ==="
  local n1 n2
  curl -s -o /dev/null -w "  netease %{http_code}\n" \
    "https://music.lucifer.yoga/netease/search?keywords=test&cookie=$PROBE" || true
  curl -s -o /dev/null -w "  qq      %{http_code}\n" \
    "https://music.lucifer.yoga/qq/login/status?cookie=$PROBE" || true
  sleep 1
  n1=$(grep -c "$PROBE" "$ACCESS_LOG" 2>/dev/null || true)
  n2=$(grep -c "$PROBE" "$ERROR_LOG" 2>/dev/null || true)
  echo "  access 日志命中探针: ${n1:-0}（应为 0）"
  echo "  error  日志命中探针: ${n2:-0}（应为 0）"
  echo "  access 尾行（应无 query）:"; tail -1 "$ACCESS_LOG" 2>/dev/null || echo "  （无文件）"
  echo "  netease 容器日志行数（应为 0）: $(docker logs music-netease-api-1 2>&1 | wc -l)"
  if [ "${n1:-0}" != "0" ] || [ "${n2:-0}" != "0" ]; then
    echo "✗ 仍有泄漏"; return 1
  fi
  echo "✓ 通过"
}

if [ "${1:-}" = "verify" ]; then verify; exit $?; fi

echo "=== 1. nginx log_format（不含 query）==="
if grep -q "folia_noquery" "$LOG_FMT" 2>/dev/null; then
  echo "  已存在，跳过"
else
  cat > "$LOG_FMT" <<'EOS'
# 音乐后端专用访问日志格式：只记 $uri（不带 query），
# 因为客户端把登录 cookie 放在 ?cookie= 里，combined 格式会把它原样写进日志。
log_format folia_noquery '$remote_addr - $remote_user [$time_local] '
                         '"$request_method $uri $server_protocol" $status $body_bytes_sent '
                         '"$http_referer" "$http_user_agent" rt=$request_time';
EOS
  echo "  写入 $LOG_FMT"
fi

echo "=== 2. music.conf：挂 access_log / error_log ==="
cp -a "$CONF" "$CONF.bak.$(date +%s)"
python3 - "$CONF" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1]); s = p.read_text()
changed = False
if 'folia_noquery' not in s:
    anchor = '    client_max_body_size 4m;'
    add = ('\n\n    # 不要把 ?cookie= 写进日志（格式定义见 /etc/nginx/conf.d/folia-log.conf）\n'
           '    access_log /var/log/nginx/music-api.log folia_noquery;')
    if anchor not in s:
        sys.exit('✗ 找不到 client_max_body_size 锚点')
    s = s.replace(anchor, anchor + add, 1); changed = True
if 'music-error.log' not in s:
    anchor = '    access_log /var/log/nginx/music-api.log folia_noquery;'
    add = ('\n    # error.log 里的 request 行同样带 ?cookie=，单独归档并限制保留天数\n'
           '    error_log /var/log/nginx/music-error.log warn;')
    if anchor not in s:
        sys.exit('✗ 找不到 access_log 锚点')
    s = s.replace(anchor, anchor + add, 1); changed = True
p.write_text(s)
print('  已更新' if changed else '  已存在，跳过')
PY

echo "=== 3. logrotate（每日轮转，只留 3 份）==="
cat > /etc/logrotate.d/music-nginx <<'EOS'
# 音乐后端日志：内容含用户请求（可能带 cookie），保留期压到 3 天
/var/log/nginx/music-api.log /var/log/nginx/music-error.log {
    daily
    rotate 3
    maxsize 20M
    missingok
    notifempty
    compress
    delaycompress
    sharedscripts
    postrotate
        [ -f /var/run/nginx.pid ] && kill -USR1 $(cat /var/run/nginx.pid) 2>/dev/null || true
    endscript
}
EOS
echo "  写入 /etc/logrotate.d/music-nginx"

echo "=== 4. compose：netease 关日志 + QQ 限大小 ==="
if grep -q 'driver: "none"' "$MUSIC_DIR/compose.yaml" 2>/dev/null; then
  echo "  已存在，跳过"
else
  cp -a "$MUSIC_DIR/compose.yaml" "$MUSIC_DIR/compose.yaml.bak.$(date +%s)"
  python3 - "$MUSIC_DIR/compose.yaml" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1]); s = p.read_text()
# netease-api 服务块内、ports 之后插入 logging
marker = '    ports:\n      - "127.0.0.1:3100:3000"\n'
if marker not in s:
    sys.exit('✗ 找不到 netease ports 锚点')
s = s.replace(marker, marker + '    logging:\n      driver: "none"   # 它打印含 ?cookie= 的原始 URL，且无日志级别开关\n', 1)
p.write_text(s)
print('  已插入 logging: none')
PY
  (cd "$MUSIC_DIR" && docker compose up -d --force-recreate)
fi

echo "=== 5. nginx 校验 + 重载 ==="
nginx -t
systemctl reload nginx

echo "=== 6. 清洗历史日志 ==="
for f in /var/log/nginx/access.log "$ACCESS_LOG" "$ERROR_LOG"; do
  [ -f "$f" ] || continue
  before=$(grep -c 'cookie=' "$f" || true)
  sed -i -E 's/(cookie=)[^&" ]*/\1<redacted>/g' "$f"
  echo "  $f: 处理 $before 处"
done

sleep 2
verify
