package lino.clipctl;

import android.content.ClipData;
import android.os.Binder;
import android.os.IBinder;
import android.os.Parcel;
import android.os.Process;
import android.os.RemoteException;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.lang.reflect.Method;
import java.nio.charset.Charset;
import java.util.ArrayList;
import java.util.List;

/**
 * lino-clipctl —— 设备端剪贴板读取/写入/监听器（app_process 运行，无需安装 APK）。
 *
 * 为什么必须用它，而不能在网页里直接调 navigator.clipboard：
 *   Android 10+ 的 ClipboardService.clipboardAccessAllowed() 对 OP_READ_CLIPBOARD 要求
 *   调用方满足三者之一：①持有签名级权限 READ_CLIPBOARD_IN_BACKGROUND ②是默认输入法
 *   ③当前拥有窗口焦点。UFI-TOOLS 网页所在应用在后台时三条全不满足，读到的永远是 null，
 *   也拿不到剪贴板变化事件。
 *
 *   com.android.shell（uid 2000）持有该签名权限。只要以 uid 2000 身份调用 IClipboard
 *   并把 callingPackage 传成 com.android.shell，就能无焦点读写。本机实测：
 *   写入后由另一个进程读取仍成功，进程退出后内容仍保存在 system_server 中。
 *
 *   因此本工具若以 root 启动，会先 setgid/setuid 到 2000 再访问剪贴板；否则
 *   AppOpsManager.checkPackage(uid, "com.android.shell") 会因包与 uid 不匹配而抛
 *   SecurityException。
 *
 *   注意：这里刻意直接走 IClipboard AIDL，不用 ClipboardManager。
 *   实测 ClipboardManager 在 opPackageName 与 uid 不匹配时会「静默」失败
 *   （setPrimaryClip 不抛异常但不生效、getPrimaryClip 直接返回 null），极难排查。
 *
 * 命令（均输出单行 JSON）：
 *   status                       自身身份 + 当前剪贴板，用于自检
 *   read                         读当前剪贴板
 *   write <base64>               写入剪贴板（base64 避免 shell 引号/换行问题）
 *   watch --history <path> [--pidfile <path>]
 *                                常驻监听，变化时逐行追加 {"t":ts,"s":text}
 *   stop --pidfile <path>        结束 watch
 */
public final class Cli {

    /** 借用 com.android.shell 的签名权限以绕过后台读取限制 */
    private static final String OP_PKG = "com.android.shell";
    /** com.android.shell 的 uid */
    private static final int SHELL_UID = 2000;

    /** IOnPrimaryClipChangedListener.dispatchPrimaryClipChanged() 的事务码 */
    private static final int TX_DISPATCH_CLIP_CHANGED = 1;

    /** 历史文件上限，超过则裁剪保留尾部，防止长期运行撑爆 /data */
    private static final long HISTORY_MAX_BYTES = 512 * 1024;
    private static final int HISTORY_KEEP_LINES = 400;

    /** 同一次复制会被系统回调两次（setPrimaryClip + 文本分类广播），据此去重 */
    private static final long DEDUPE_WINDOW_MS = 1500;

    /** 等待 clipboard 服务就绪：开机早期 system_server 可能还没准备好 */
    private static final int SERVICE_WAIT_TRIES = 20;
    private static final long SERVICE_WAIT_INTERVAL_MS = 1500L;

    private static final Charset UTF8 = Charset.forName("UTF-8");

    /** IClipboard 代理，反射拿到后复用 */
    private static Object iClipboard;
    private static Method mGetPrimaryClip;
    private static Method mHasPrimaryClip;
    private static Method mSetPrimaryClip;
    private static Method mAddListener;

    public static void main(String[] args) {
        int exit = 0;
        try {
            run(args);
        } catch (Throwable e) {
            System.out.println(jsonError("fatal", e));
            exit = 1;
        }
        System.out.flush();
        Runtime.getRuntime().halt(exit);
    }

    private static void run(String[] args) throws Exception {
        String cmd = args.length > 0 ? args[0] : "status";

        int uidBefore = Process.myUid();
        boolean dropped = false;
        if (uidBefore == 0) {
            dropped = dropToShellUid();
        }

        openClipboard();

        if ("status".equals(cmd)) {
            String text = null;
            String err = null;
            Boolean has = null;
            try {
                has = Boolean.valueOf(hasPrimaryClip());
                text = readText();
            } catch (Throwable e) {
                err = e.getClass().getName() + ": " + e.getMessage();
            }
            StringBuilder sb = new StringBuilder();
            sb.append("{\"ok\":").append(err == null)
              .append(",\"uidBefore\":").append(uidBefore)
              .append(",\"uid\":").append(Process.myUid())
              .append(",\"dropped\":").append(dropped)
              .append(",\"opPkg\":").append(quote(OP_PKG))
              .append(",\"hasClip\":").append(has == null ? "null" : has.toString());
            if (text != null) {
                sb.append(",\"text\":").append(quote(text));
            }
            if (err != null) {
                sb.append(",\"error\":").append(quote(err));
            }
            sb.append('}');
            System.out.println(sb);
            return;
        }

        if ("read".equals(cmd)) {
            String text = readText();
            System.out.println("{\"ok\":true,\"text\":"
                    + (text == null ? "null" : quote(text))
                    + ",\"ts\":" + System.currentTimeMillis() + '}');
            return;
        }

        if ("write".equals(cmd)) {
            // 支持 --file：由插件先把长文本 base64 落盘再调用，
            // 避免直接把几 MB 的 base64 塞进 argv（mksh 与 kernel 都对单个参数有上限）
            String payloadFile = optValue(args, "--file");
            String payload;
            if (payloadFile != null) {
                payload = readTextFile(payloadFile).trim();
            } else if (args.length >= 2) {
                payload = args[1];
            } else {
                payload = "";
            }
            if (payload.length() == 0) {
                System.out.println(jsonError("write",
                        new IllegalArgumentException("missing base64 payload")));
                return;
            }
            String text = new String(base64Decode(payload), UTF8);
            writeText(text);
            // 回读校验：写入被权限拦下时接口不会报错，只有回读才看得出真假
            String back = readText();
            System.out.println("{\"ok\":" + text.equals(back)
                    + ",\"written\":" + text.length()
                    + ",\"verified\":" + text.equals(back)
                    + ",\"ts\":" + System.currentTimeMillis() + '}');
            return;
        }

        if ("watch".equals(cmd)) {
            String history = optValue(args, "--history");
            String pidFile = optValue(args, "--pidfile");
            if (history == null) {
                System.out.println(jsonError("watch",
                        new IllegalArgumentException("--history required")));
                return;
            }
            if (pidFile != null) {
                writeTextFile(pidFile, String.valueOf(Process.myPid()));
            }
            watch(new File(history));
            return;
        }

        if ("stop".equals(cmd)) {
            String pidFile = optValue(args, "--pidfile");
            int pid = pidFile == null ? 0 : parseInt(readTextFile(pidFile), 0);
            boolean killed = false;
            if (pid > 0) {
                try {
                    Process.killProcess(pid);
                    killed = true;
                } catch (Throwable ignore) {
                    // 跨 uid 时可能无权限，插件侧再用 root kill 兜底
                }
            }
            System.out.println("{\"ok\":" + killed + ",\"pid\":" + pid + '}');
            return;
        }

        System.out.println(jsonError("unknown",
                new IllegalArgumentException("unknown cmd: " + cmd)));
    }

    /* ---------------- IClipboard ---------------- */

    private static void openClipboard() throws Exception {
        if (iClipboard != null) {
            return;
        }
        Class<?> smc = Class.forName("android.os.ServiceManager");
        Method getService = smc.getDeclaredMethod("getService", String.class);
        getService.setAccessible(true);
        IBinder binder = (IBinder) getService.invoke(null, "clipboard");
        // 开机自启时可能比 system_server 的 clipboard 服务更早跑起来，
        // 这里轮询等待而不是直接失败，否则自启会偶发不生效。
        for (int i = 0; binder == null && i < SERVICE_WAIT_TRIES; i++) {
            Thread.sleep(SERVICE_WAIT_INTERVAL_MS);
            binder = (IBinder) getService.invoke(null, "clipboard");
        }
        if (binder == null) {
            throw new IllegalStateException("clipboard service not found");
        }
        Class<?> stub = Class.forName("android.content.IClipboard$Stub");
        Method asInterface = stub.getDeclaredMethod("asInterface", IBinder.class);
        asInterface.setAccessible(true);
        iClipboard = asInterface.invoke(null, binder);

        Class<?> ic = Class.forName("android.content.IClipboard");
        mGetPrimaryClip = ic.getMethod("getPrimaryClip", String.class, int.class);
        mHasPrimaryClip = ic.getMethod("hasPrimaryClip", String.class, int.class);
        mSetPrimaryClip = ic.getMethod("setPrimaryClip", ClipData.class, String.class, int.class);
        mAddListener = ic.getMethod("addPrimaryClipChangedListener",
                Class.forName("android.content.IOnPrimaryClipChangedListener"),
                String.class, int.class);
    }

    private static boolean hasPrimaryClip() throws Exception {
        Object r = mHasPrimaryClip.invoke(iClipboard, OP_PKG, Integer.valueOf(0));
        return r instanceof Boolean && ((Boolean) r).booleanValue();
    }

    private static String readText() throws Exception {
        Object d = mGetPrimaryClip.invoke(iClipboard, OP_PKG, Integer.valueOf(0));
        if (!(d instanceof ClipData)) {
            return null;
        }
        ClipData cd = (ClipData) d;
        if (cd.getItemCount() == 0) {
            return null;
        }
        CharSequence cs = cd.getItemAt(0).getText();
        if (cs == null) {
            cs = cd.getItemAt(0).coerceToText(null);
        }
        return cs == null ? null : cs.toString();
    }

    private static void writeText(String text) throws Exception {
        mSetPrimaryClip.invoke(iClipboard, ClipData.newPlainText("lino-clip", text),
                OP_PKG, Integer.valueOf(0));
    }

    /* ---------------- 常驻监听 ---------------- */

    /**
     * 注册剪贴板变化监听并常驻。
     *
     * 用自建 Binder（而非动态 Proxy）承接回调：ClipboardService 会把
     * IOnPrimaryClipChangedListener 存进 RemoteCallbackList 并直接对其 binder 发事务，
     * 我们只要在 onTransact 里处理 dispatchPrimaryClipChanged（事务码 1）即可。
     * 回调落在 binder 线程上，不需要 Looper。
     */
    /**
     * 扫描 /proc，确认没有第二个 watch 实例在跑。
     *
     * 只靠 pidfile 不够：pidfile 能被后来者覆盖，一旦发生就会出现两个监听同时写同一个
     * 历史文件，表现为「同一条内容被记两遍」。这里做独立的进程级校验。
     */
    private static int findOtherWatchPids() {
        int others = 0;
        File proc = new File("/proc");
        String[] entries = proc.list();
        if (entries == null) {
            return 0;
        }
        int self = Process.myPid();
        for (int i = 0; i < entries.length; i++) {
            String name = entries[i];
            if (name.length() == 0 || name.charAt(0) < '0' || name.charAt(0) > '9') {
                continue;
            }
            int pid;
            try {
                pid = Integer.parseInt(name);
            } catch (Throwable e) {
                continue;
            }
            if (pid == self) {
                continue;
            }
            BufferedReader r = null;
            try {
                r = new BufferedReader(new InputStreamReader(
                        new FileInputStream("/proc/" + name + "/cmdline"), UTF8));
                StringBuilder sb = new StringBuilder();
                int ch;
                while ((ch = r.read()) > 0) {
                    sb.append((char) ch);
                }
                String cmdline = sb.toString().replace('\0', ' ').trim();
                if (cmdline.indexOf("lino.clipctl.Cli") >= 0
                        && cmdline.indexOf("watch") >= 0) {
                    others++;
                }
            } catch (Throwable ignore) {
                // 进程可能在扫描期间退出，属正常
            } finally {
                if (r != null) {
                    try {
                        r.close();
                    } catch (Throwable ignore) {
                    }
                }
            }
        }
        return others;
    }

    private static void watch(final File history) throws Exception {
        final long[] lastTs = new long[]{0L};
        final String[] lastText = new String[]{null};

        // 单例保护：已有实例在跑就直接退出，避免两个进程往同一份历史里重复写
        if (findOtherWatchPids() > 0) {
            System.out.println("{\"ok\":false,\"error\":\"another watch is already running\",\"pid\":"
                    + Process.myPid() + "}");
            System.out.flush();
            return;
        }

        // 启动瞬间补记一次当前内容，避免上次停机期间漏掉最后一条。
        // 但若历史末尾已经是同一段文本（例如插件刚写过、或上次运行已记录），
        // 就不再重复追加 —— 否则每次开关监听都会在文件里留一条重复。
        try {
            String cur = readText();
            if (cur != null && cur.length() > 0) {
                synchronized (lastText) {
                    lastText[0] = cur;
                    lastTs[0] = System.currentTimeMillis();
                    if (!cur.equals(lastHistoryText(history))) {
                        appendHistory(history, cur);
                    }
                }
            }
        } catch (Throwable ignore) {
        }

        final Binder listener = new Binder() {
            @Override
            protected boolean onTransact(int code, Parcel data, Parcel reply, int flags)
                    throws RemoteException {
                if (code != TX_DISPATCH_CLIP_CHANGED) {
                    return super.onTransact(code, data, reply, flags);
                }
                try {
                    String cur = readText();
                    if (cur != null && cur.length() > 0) {
                        // 加锁：系统对同一次复制会连发两次 dispatchPrimaryClipChanged，
                        // 两次事务可能落在**不同 binder 线程**上并发执行。
                        // 不加锁时「比较-写入」之间会被插队，导致同一条内容被记两遍。
                        synchronized (lastText) {
                            long now = System.currentTimeMillis();
                            boolean dup = cur.equals(lastText[0])
                                    && (now - lastTs[0]) < DEDUPE_WINDOW_MS;
                            if (!dup) {
                                lastText[0] = cur;
                                lastTs[0] = now;
                                appendHistory(history, cur);
                            }
                        }
                    }
                } catch (Throwable ignore) {
                    // 单次读取失败不能打断常驻
                }
                return true;
            }
        };

        Class<?> listenerIface = Class.forName("android.content.IOnPrimaryClipChangedListener");
        Object listenerObj = java.lang.reflect.Proxy.newProxyInstance(
                listenerIface.getClassLoader(),
                new Class<?>[]{listenerIface},
                new ListenerStub(listener));
        mAddListener.invoke(iClipboard, listenerObj, OP_PKG, Integer.valueOf(0));

        System.out.println("{\"ok\":true,\"watching\":true,\"uid\":" + Process.myUid()
                + ",\"pid\":" + Process.myPid()
                + ",\"history\":" + quote(history.getAbsolutePath()) + '}');
        System.out.flush();

        // binder 线程负责回调，主线程只需活着
        while (true) {
            Thread.sleep(3600000L);
        }
    }

    /**
     * IOnPrimaryClipChangedListener 的实现体。
     * 直接实现接口在编译期需要 AIDL 生成的类，这里用「继承 Binder 并提供同名方法 +
     * 动态代理」两种方式都不如显式继承 android.content.IOnPrimaryClipChangedListener.Stub
     * 可靠；但该 Stub 是隐藏类，无法在 javac 下直接 import。
     * 折中：用 Proxy 绑定到上面的 Binder，asBinder 返回真实 binder。
     */
    private static final class ListenerStub implements java.lang.reflect.InvocationHandler {
        private final Binder binder;

        ListenerStub(Binder binder) {
            this.binder = binder;
        }

        @Override
        public Object invoke(Object proxy, Method method, Object[] argv) {
            if ("asBinder".equals(method.getName())) {
                return binder;
            }
            return null; // dispatchPrimaryClipChanged 的实际处理在 binder.onTransact 里
        }
    }

    /* ---------------- 历史文件 ---------------- */

    /**
     * 读历史文件最后一条的文本内容，用于「启动补记」时判重。
     * 只在文件不大时读尾部，避免历史很长时每次启动都全量扫一遍。
     */
    private static String lastHistoryText(File history) {
        java.io.RandomAccessFile raf = null;
        try {
            if (!history.exists() || history.length() == 0) {
                return null;
            }
            long len = history.length();
            int tail = (int) Math.min(len, 8192);
            raf = new java.io.RandomAccessFile(history, "r");
            raf.seek(len - tail);
            byte[] buf = new byte[tail];
            raf.readFully(buf);
            String s = new String(buf, UTF8);
            int nl = s.lastIndexOf('\n', s.length() - 2);
            String lastLine = nl >= 0 ? s.substring(nl + 1) : s;
            lastLine = lastLine.trim();
            if (lastLine.length() == 0) {
                return null;
            }
            // 复用最小 JSON 解析：只取 "s" 字段
            return jsonStringField(lastLine, "s");
        } catch (Throwable e) {
            return null;
        } finally {
            if (raf != null) {
                try {
                    raf.close();
                } catch (Throwable ignore) {
                }
            }
        }
    }

    /** 从 {"t":...,"s":"..."} 里取出 s 字段的原始字符串（支持常见转义） */
    private static String jsonStringField(String line, String field) {
        String key = "\"" + field + "\":";
        int i = line.indexOf(key);
        if (i < 0) {
            return null;
        }
        i = line.indexOf('"', i + key.length());
        if (i < 0) {
            return null;
        }
        StringBuilder sb = new StringBuilder();
        for (int p = i + 1; p < line.length(); p++) {
            char ch = line.charAt(p);
            if (ch == '"') {
                return sb.toString();
            }
            if (ch != '\\') {
                sb.append(ch);
                continue;
            }
            p++;
            if (p >= line.length()) {
                return null;
            }
            char esc = line.charAt(p);
            switch (esc) {
                case 'n': sb.append('\n'); break;
                case 'r': sb.append('\r'); break;
                case 't': sb.append('\t'); break;
                case '"': sb.append('"'); break;
                case '\\': sb.append('\\'); break;
                case 'u':
                    if (p + 4 < line.length()) {
                        try {
                            sb.append((char) Integer.parseInt(line.substring(p + 1, p + 5), 16));
                            p += 4;
                        } catch (Throwable ignore) {
                        }
                    }
                    break;
                default: sb.append(esc);
            }
        }
        return null;
    }

    private static synchronized void appendHistory(File history, String text) {
        Writer w = null;
        try {
            File dir = history.getParentFile();
            if (dir != null && !dir.exists()) {
                dir.mkdirs();
            }
            w = new OutputStreamWriter(new FileOutputStream(history, true), UTF8);
            w.write("{\"t\":" + System.currentTimeMillis() + ",\"s\":" + quote(text) + "}\n");
            w.flush();
        } catch (Throwable ignore) {
            return;
        } finally {
            if (w != null) {
                try {
                    w.close();
                } catch (Throwable ignore) {
                }
            }
        }
        trimHistory(history);
    }

    private static void trimHistory(File history) {
        try {
            if (history.length() <= HISTORY_MAX_BYTES) {
                return;
            }
            List<String> lines = new ArrayList<String>();
            BufferedReader r = new BufferedReader(
                    new InputStreamReader(new FileInputStream(history), UTF8));
            try {
                String line;
                while ((line = r.readLine()) != null) {
                    lines.add(line);
                }
            } finally {
                r.close();
            }
            int from = Math.max(0, lines.size() - HISTORY_KEEP_LINES);
            StringBuilder sb = new StringBuilder();
            for (int i = from; i < lines.size(); i++) {
                sb.append(lines.get(i)).append('\n');
            }
            writeTextFile(history.getAbsolutePath(), sb.toString());
        } catch (Throwable ignore) {
        }
    }

    /* ---------------- 身份 ---------------- */

    /**
     * 由 root 调起时降到 shell uid；返回是否成功降权。
     *
     * 用 android.system.Os 而非反射 android.os.Process：后者在 Android 11+ 属 non-SDK
     * 接口（实测 NoSuchMethodException），而 Os 的 setuid/setgid 是公开 API。
     * 非 root 进程调用会被内核以 EPERM 拒绝，因此无需额外判断权限。
     */
    private static boolean dropToShellUid() {
        try {
            android.system.Os.setgid(SHELL_UID);
        } catch (Throwable ignore) {
        }
        try {
            android.system.Os.setuid(SHELL_UID);
        } catch (Throwable ignore) {
        }
        return Process.myUid() == SHELL_UID;
    }

    /* ---------------- 文件与格式 ---------------- */

    private static void writeTextFile(String path, String content) {
        Writer w = null;
        try {
            File f = new File(path);
            File dir = f.getParentFile();
            if (dir != null && !dir.exists()) {
                dir.mkdirs();
            }
            w = new OutputStreamWriter(new FileOutputStream(f, false), UTF8);
            w.write(content);
            w.flush();
        } catch (Throwable ignore) {
        } finally {
            if (w != null) {
                try {
                    w.close();
                } catch (Throwable ignore) {
                }
            }
        }
    }

    private static String readTextFile(String path) {
        BufferedReader r = null;
        try {
            r = new BufferedReader(new InputStreamReader(new FileInputStream(path), UTF8));
            String line = r.readLine();
            return line == null ? "" : line.trim();
        } catch (Throwable e) {
            return "";
        } finally {
            if (r != null) {
                try {
                    r.close();
                } catch (Throwable ignore) {
                }
            }
        }
    }

    private static int parseInt(String s, int def) {
        try {
            return Integer.parseInt(s.trim());
        } catch (Throwable e) {
            return def;
        }
    }

    private static String optValue(String[] args, String key) {
        for (int i = 0; i < args.length - 1; i++) {
            if (key.equals(args[i])) {
                return args[i + 1];
            }
        }
        return null;
    }

    private static String jsonError(String where, Throwable e) {
        return "{\"ok\":false,\"where\":" + quote(where)
                + ",\"error\":" + quote(e.getClass().getName() + ": " + e.getMessage()) + '}';
    }

    private static String quote(String s) {
        StringBuilder sb = new StringBuilder(s.length() + 16);
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            switch (ch) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (ch < 0x20) {
                        sb.append("\\u").append(hex4(ch));
                    } else {
                        sb.append(ch);
                    }
            }
        }
        sb.append('"');
        return sb.toString();
    }

    private static String hex4(int v) {
        char[] h = "0123456789abcdef".toCharArray();
        return new String(new char[]{
                h[(v >> 12) & 0xF], h[(v >> 8) & 0xF], h[(v >> 4) & 0xF], h[v & 0xF]});
    }

    private static final char[] B64 =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".toCharArray();

    private static byte[] base64Decode(String in) {
        int len = in.length();
        while (len > 0 && in.charAt(len - 1) == '=') {
            len--;
        }
        byte[] out = new byte[len * 3 / 4 + 3];
        int buf = 0;
        int bits = 0;
        int pos = 0;
        for (int i = 0; i < len; i++) {
            int v = indexOfB64(in.charAt(i));
            if (v < 0) {
                continue;
            }
            buf = (buf << 6) | v;
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                out[pos++] = (byte) ((buf >> bits) & 0xFF);
            }
        }
        byte[] exact = new byte[pos];
        System.arraycopy(out, 0, exact, 0, pos);
        return exact;
    }

    private static int indexOfB64(char ch) {
        for (int i = 0; i < B64.length; i++) {
            if (B64[i] == ch) {
                return i;
            }
        }
        return -1;
    }
}
