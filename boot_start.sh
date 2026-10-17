#!/system/bin/sh
# kano-clipboard 开机自启脚本
# 由 /sdcard/ufi_tools_boot.sh 调用（UFI-TOOLS 平台在开机窗口内以 root 执行）。
#
# 注意：本脚本通常以 root 身份运行，而 kano-clipctl 内部会自行 setuid 到
# uid 2000(com.android.shell) 再去读写剪贴板 —— 这是 Android 10+ 后台读取
# 剪贴板的前提条件。所以这里刻意不做任何 setuid，交给工具自己处理。

DIR=/data/local/tmp/kano_clipboard
DEX=$DIR/clipctl.dex
LOG=$DIR/watch.log
PIDF=$DIR/clip.pid

[ -f "$DEX" ] || exit 0
mkdir -p "$DIR" 2>/dev/null

# 1) 等系统启动完成：开机窗口内很早就被调用，此时 clipboard 服务可能还没就绪
i=0
while [ "$i" -lt 60 ]; do
    [ "$(getprop sys.boot_completed)" = "1" ] && break
    i=$((i + 1))
    sleep 3
done
sleep 5

# 2) 已在运行就别重复拉起（避免多次触发叠加多个监听进程）
if [ -f "$PIDF" ]; then
    OLD=$(cat "$PIDF" 2>/dev/null)
    if [ -n "$OLD" ] && kill -0 "$OLD" 2>/dev/null; then
        echo "[$(date)] [自启] 监听已在运行 pid=$OLD，跳过" >> "$LOG"
        exit 0
    fi
fi

# 3) 拉起监听。setsid 让它脱离本脚本的会话，脚本退出后不被回收
echo "[$(date)] [自启] 启动剪贴板监听" >> "$LOG"
CLASSPATH="$DEX" setsid app_process /system/bin kano.clipctl.Cli \
    watch --history "$DIR/history.jsonl" --pidfile "$PIDF" >> "$LOG" 2>&1 &
