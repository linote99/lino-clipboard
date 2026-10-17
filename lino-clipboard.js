<!-- [KANO_PLUGIN_START] Lino剪贴板同步-设备端.js -->
// Lino 插件版本: v1.0（设备剪贴板 ↔ 高级后台双向同步 + 跨端共享历史）
//
// 能力:
//   1. 读取安卓设备（本机，即 UFI 自身）的系统剪贴板，在插件面板里查看
//   2. 面板输入框内容一键写入设备剪贴板（可回读校验）
//   3. 历史记录：监听设备剪贴板变化并持久化，跨浏览器/跨设备共享同一份历史
//
// 依赖:
//   · 高级功能（root）—— 全部设备操作都走 runShellWithRoot
//   · 首次使用时自动部署设备端工具 lino-clipctl（dex，约 12KB，内嵌在本文件里）
//
// 为什么需要设备端工具（这是本插件的核心，绕不开）:
//   Android 10+ 的 ClipboardService.clipboardAccessAllowed() 对「读」剪贴板要求调用方满足
//   三者之一：持有签名级权限 READ_CLIPBOARD_IN_BACKGROUND / 是默认输入法 / 当前有窗口焦点。
//   UFI-TOOLS 的网页所在应用退到后台时三条都不满足，Web 层拿到的永远是空。
//
//   而 com.android.shell（uid 2000）恰好持有该签名权限。只要以 uid 2000 身份调用
//   IClipboard 并把 callingPackage 传成 com.android.shell，即可无焦点读写。
//   本机实测：写入后换进程读取仍成功，进程退出后内容仍由 system_server 持有。
//
//   故 lino-clipctl 若被 root 调起，会先通过 android.system.Os.setuid(2000) 降到 shell
//   再操作剪贴板；否则 AppOpsManager.checkPackage 会因「包不属于该 uid」抛 SecurityException。
//   同时刻意绕开 ClipboardManager 直接走 IClipboard AIDL —— 后者在 opPackageName 与 uid
//   不匹配时会「静默」失败（写入不生效、读取返回 null 且不抛异常），极难排查。
//
// 数据落盘:
//   /data/local/tmp/lino_clipboard/clipctl.dex    设备端工具（自部署）
//   /data/local/tmp/lino_clipboard/history.jsonl  历史（每行 {"t":ts,"s":text}）
//   /data/local/tmp/lino_clipboard/clip.pid       watch 进程 pid
//
// 实现取舍:
//   · 历史以设备文件为唯一数据源，localStorage 只做首屏缓存 —— 换浏览器打开
//     高级后台读到的是同一份历史；未开高级功能时自动降级为「仅本地缓存」。
//   · 历史条目按文本内容去重（相同内容只保留最近一次），避免同一条反复复制刷屏。
//   · 面板不做自动轮询设备（每次 runShellWithRoot 都是一次 HTTP 往返），
//     改为「打开时拉一次 + 手动刷新 + 写入后回读」，避免后台持续占用。
<script>
(() => {
  /* ================= 常量 ================= */

  const VERSION = 'v1.0';
  const BTN_TEXT = '剪贴板同步';
  /** 面板标题：收纳箱用「标题行文字」当插件名 key，两者必须一致 */
  const TITLE = BTN_TEXT;
  const STYLE_ID = 'lino_clipboard_style';

  const DEVICE_DIR = '/data/local/tmp/lino_clipboard';
  const DEVICE_DEX = `${DEVICE_DIR}/clipctl.dex`;
  const DEVICE_HISTORY = `${DEVICE_DIR}/history.jsonl`;
  const DEVICE_PID = `${DEVICE_DIR}/clip.pid`;
  const DEVICE_LOG = `${DEVICE_DIR}/watch.log`;
  const DEVICE_PAYLOAD = `${DEVICE_DIR}/payload.b64`;

  /** UFI-TOOLS 官方开机脚本：平台上电后由 samba root preexec 以 root 身份执行 */
  const BOOT_SH = '/sdcard/ufi_tools_boot.sh';
  /** 写进启动脚本的那一行，带独立标记，卸载/关闭时可精确摘除 */
  const BOOT_LINE = `sh ${DEVICE_DIR}/boot_start.sh #lino_clipboard_autostart`;
  /** 自启落地脚本：等网/等服务就绪后再拉起监听 */
  const DEVICE_BOOT_SH = `${DEVICE_DIR}/boot_start.sh`;

  /** 面板展示的历史条数上限 */
  const UI_HISTORY_LIMIT = 60;
  /** 设备文件读取上限（历史文件本身由设备端工具裁剪到 512KB 内） */
  const LOCAL_CACHE_KEY = 'lino_clipboard_history_v1';
  const LOCAL_CACHE_LIMIT = 200;

  const state = {
    busy: false,
    ready: false,
    watchOn: false,
    bootOn: false,
    installState: 'unknown',
    history: [],
    lastDeviceText: null,
    shellAvailable: null,   // null=未知 true=可用 false=不可用
    modalEl: null,
  };

  /* ================= 基础工具 ================= */

  const runShell = async (cmd, timeout) => {
    let fn = null;
    try { fn = (typeof runShellWithRoot === 'function') ? runShellWithRoot : null; } catch (e) { fn = null; }
    if (typeof fn !== 'function') fn = (typeof window !== 'undefined') ? window.runShellWithRoot : null;
    if (typeof fn !== 'function') return null;
    try {
      return await fn(cmd, timeout || 15000);
    } catch (e) {
      console.error('[LinoClip] shell 执行失败：', e);
      return null;
    }
  };

  /** UTF-8 安全的 base64（历史里有中文/emoji，不能用裸 btoa） */
  const b64encode = (str) => {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  };

  const b64decode = (b64) => {
    const bin = atob(String(b64).replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  };

  const toast = (text, color) => {
    try { createToast(text, color || ''); } catch (e) { console.log('[LinoClip]', text); }
  };

  /** 从 runShellWithRoot 的返回里取纯 stdout 文本 */
  const outOf = (res) => {
    if (!res || typeof res.content !== 'string') return '';
    return res.content;
  };

  const fmtTime = (ts) => {
    const d = new Date(Number(ts) || Date.now());
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  const preview = (s, n) => {
    const one = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return one.length > n ? one.slice(0, n) + '…' : one;
  };

  /* ================= 样式 ================= */

  const ensureStyle = () => {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .kc-status {
        display: flex; align-items: center; gap: 6px;
        font-size: .78rem; opacity: .85; margin-bottom: 8px;
        flex-wrap: wrap;
      }
      .kc-chip {
        padding: 1px 7px; border-radius: 9px;
        background: var(--dark-tag-color, #4b556380);
        font-size: .72rem;
      }
      .kc-chip.kc-ok { background: #2fa84f66; }
      .kc-chip.kc-warn { background: #d9832466; }
      .kc-chip.kc-bad { background: #d9534f66; }
      .kc-input-row { display: flex; gap: 8px; flex-direction: column; }
      .kc-textarea {
        width: 100%; box-sizing: border-box; min-height: 74px; max-height: 190px;
        resize: vertical; font-family: inherit; font-size: .82rem;
        padding: 7px 9px; border-radius: 8px; outline: none;
        color: var(--dark-text-color, #eee);
        background: var(--dark-card-bg, #00000024);
        border: 0.1rem solid var(--dark-btn-color, #87ceeb61);
      }
      .kc-textarea:focus { border-color: var(--dark-btn-color-active, #018ad8a8); }
      .kc-actions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
      .kc-actions button { font-size: .78rem; }
      .kc-list {
        margin-top: 10px; max-height: 300px; overflow-y: auto;
        display: flex; flex-direction: column; gap: 5px;
      }
      .kc-item {
        display: flex; align-items: flex-start; gap: 8px;
        padding: 6px 8px; border-radius: 7px;
        background: var(--dark-card-bg, #00000024);
        border: 1px solid transparent;
      }
      .kc-item:hover { border-color: var(--dark-btn-color, #87ceeb61); }
      .kc-item-main { flex: 1; min-width: 0; }
      .kc-item-text {
        font-size: .8rem; word-break: break-all; white-space: pre-wrap;
        max-height: 3.2em; overflow: hidden;
      }
      .kc-item-meta { font-size: .68rem; opacity: .55; margin-top: 2px; }
      .kc-item-ops { display: flex; gap: 4px; flex-shrink: 0; }
      .kc-item-ops button { padding: 1px 6px; font-size: .7rem; }
      .kc-empty { text-align: center; opacity: .5; font-size: .78rem; padding: 16px 0; }
      .kc-hint { font-size: .7rem; opacity: .55; line-height: 1.5; margin-top: 8px; }
      .kc-hint-inline { font-size: .7rem; opacity: .55; }
      .kc-section {
        margin-top: 12px; padding-top: 10px;
        border-top: 1px solid var(--dark-btn-color, #87ceeb61);
      }
      .kc-section-title { font-size: .78rem; opacity: .8; margin-bottom: 6px; }
      .kc-actions button.kc-danger {
        border: 1px solid #d9534f88;
        background: #d9534f22;
      }
      .kc-actions button.kc-on {
        background: var(--dark-btn-color-active, #018ad8a8);
      }
    `;
    document.head.appendChild(style);
  }

  /* ================= 设备端工具部署 ================= */

  /** 内嵌的 lino-clipctl dex（base64），首次使用时落盘到设备 */
  const CLIPCTL_DEX_B64 =
    'ZGV4CjAzNQAN9QjB2kK8RQwSSfMKWWNIUEGXK5cZcgkEOgAAcAAAAHhWNBIAAAAAAAAAADQ5AAAHAQAAcAAAAD4AAACMBAAAQQAAAIQFAAAVAAAAkAgAAHsA' +
    'AAA4CQAAAwAAABANAACULAAAcA0AAKgoAACqKAAArSgAALEoAAC+KAAAySgAANYoAADjKAAA7igAAPcoAAD+KAAACCkAABApAAAZKQAAKCkAADYpAABDKQAA' +
    'SykAAFYpAABqKQAAdSkAAH8pAACGKQAAjikAAKApAACkKQAArikAALYpAAD4KQAA/SkAAAAqAAAEKgAADioAACAqAAA0KgAARyoAAEoqAABOKgAAUyoAAFcq' +
    'AABcKgAAXyoAAGQqAABnKgAAayoAAHAqAAB0KgAAeSoAAH0qAACBKgAAhioAAIwqAACQKgAAsSoAAM0qAADoKgAA/SoAABMrAAAoKwAAPisAAFwrAABxKwAA' +
    'lSsAALorAADaKwAA/SsAABksAAAnLAAAQSwAAFEsAABsLAAAiCwAAJ8sAAC8LAAA1CwAAPIsAAAJLQAAJS0AADctAABJLQAAXi0AAHgtAACLLQAApC0AALst' +
    'AADhLQAABC4AABkuAAArLgAAPy4AAFQuAABoLgAAgy4AAJcuAACrLgAAwi4AAOkuAAAFLwAAIC8AADwvAABTLwAAZS8AAHsvAACcLwAAsC8AALgvAADSLwAA' +
    '5i8AAPEvAAALMAAAETAAABgwAAAeMAAAITAAACUwAAApMAAALTAAADUwAAA6MAAAQDAAAEUwAABJMAAATDAAAFMwAABXMAAAWzAAAF8wAABjMAAAdzAAAIww' +
    'AAChMAAApTAAAKkwAACtMAAAsTAAALUwAAC5MAAAxTAAANEwAADeMAAA4zAAAAIxAAAeMQAAPzEAAG4xAACJMQAAkTEAAKAxAACrMQAAtTEAAMIxAADQMQAA' +
    '2DEAAOYxAADuMQAA+TEAABYyAAAdMgAAKzIAAD4yAABRMgAAYTIAAGkyAABxMgAAeDIAAIwyAACTMgAAnDIAAKEyAACyMgAAvDIAAMwyAADfMgAA6jIAAPgy' +
    'AAAEMwAADzMAABgzAAAnMwAANzMAAEMzAABPMwAAWDMAAF4zAABuMwAAdDMAAIAzAACJMwAAlTMAAJ0zAACoMwAAuTMAAMYzAADXMwAA5DMAAOwzAAD3MwAA' +
    'CTQAAA80AAAdNAAALjQAAD80AABQNAAAVjQAAFs0AABgNAAAeDQAAIA0AACHNAAAjjQAAJQ0AACiNAAAtDQAALo0AADGNAAA1TQAAN80AADkNAAA7jQAAPc0' +
    'AAD+NAAAATUAAAc1AAASNQAAHDUAACY1AAA0NQAAPTUAAEI1AABFNQAASzUAAFo1AABqNQAAcjUAAHo1AACANQAAhzUAAI81AACVNQAAoDUAAK01AAC3NQAA' +
    'vTUAAMo1AADTNQAA4jUAAO81AAD9NQAACTYAABA2AAAZNgAAIDYAACc2AAAyNgAAQTYAAEk2AACINgAAnjYAALI2AADVNgAA3DYAAN82AADjNgAAHQAAACMA' +
    'AAAoAAAANAAAADUAAAA2AAAANwAAADgAAAA5AAAAOgAAADsAAAA8AAAAPQAAAD4AAAA/AAAAQAAAAEEAAABDAAAARAAAAEUAAABGAAAARwAAAEgAAABJAAAA' +
    'SgAAAEsAAABMAAAATQAAAE4AAABPAAAAUAAAAFEAAABSAAAAUwAAAFQAAABVAAAAVgAAAFcAAABYAAAAWQAAAFoAAABbAAAAXAAAAF0AAABeAAAAXwAAAGAA' +
    'AABhAAAAYgAAAGMAAABkAAAAZQAAAGYAAABnAAAAcAAAAHkAAAB8AAAAfQAAAH4AAAB/AAAAgAAAAIEAAAAeAAAAAAAAAIgnAAAjAAAAAQAAAAAAAAAkAAAA' +
    'AQAAAJAnAAAlAAAAAQAAAJgnAAAmAAAAAQAAAKAnAAAnAAAAAQAAAKgnAAAoAAAAAgAAAAAAAAApAAAAAgAAALAnAAAtAAAAAwAAAIgnAAAxAAAABAAAALgn' +
    'AAAqAAAAEgAAAAAAAAAzAAAAHQAAAMAnAAAqAAAAHgAAAAAAAAAwAAAAHgAAAMgnAAAqAAAAHwAAAAAAAAAwAAAAHwAAAKAnAAAqAAAAIAAAAAAAAAAtAAAA' +
    'JAAAAIgnAAAtAAAAJgAAAIgnAAAyAAAAJgAAANAnAAAyAAAAJgAAANwnAAAxAAAAJgAAAOgnAAAqAAAAJwAAAAAAAAAqAAAAKAAAAAAAAAAsAAAAKAAAAPAn' +
    'AAAtAAAAKAAAAIgnAAAuAAAAKAAAAJgnAAAwAAAAKAAAAPgnAAAwAAAAKAAAAKAnAAAxAAAAKAAAAAAoAAAxAAAAKAAAAAgoAAAxAAAAKAAAABAoAAArAAAA' +
    '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' +
    'Dy39iQJyHQBeAQAOpkseLVghPdIeHh+WTRtLASYQWrSl4aX//y3TLdM8WiClS9Lw/D4giWotlks9LmkBEBAftD1LARkP4cP7PyClaUstARAQHy21hyCHS8Me' +
    'LjwgKiEBJA8gASMQAJwEAQAOtB9aARESaU08HrRaeO4+tQJ3HUskHwDJAgEADodcadIBEg09WiRLhx4taaU9XBwgAh9ZaR7QTgEXEAEbD+EBFgw+XQCCAgEA' +
    'DgEVD3Y9AMwEAgAADh9pS4c90jw+H0ZMLj0cMAAAAAABAAAALQAAAAEAAAABAAAAAQAAAAAAAAACAAAAAQABAAEAAAAoAAAAAgAAACgAAQACAAAAAgACAAIA' +
    'AAAeAB4AAQAAADcAAAABAAAABQAAAAMAAAAgADsALQAAAAMAAAAmAC4APAAAAAIAAAAmADwAAgAAAAAAAAABAAAAEgAAAAIAAAAoACgAAgAAACgALAACAAAA' +
    'PQAoAAEAAAACAAAAAgAAACgAOwABAAAABgAAAAIAAAASACgAAgAAABIANwACAAAAFQAwAAIAAAAXADAAAQAAABsAAAABAAAAJgAAAAUAAAAmAAEAJgABAAEA' +
    'AAABAAAAOAAAAAIAAAA4ADAAAQAAADkAAAABAAAAPQAAAAMAAAA9ADoAEgAAAAQAAAABAAgACAABAAAAASIAAiI6AAssImRyb3BwZWQiOgAJLCJlcnJvciI6' +
    'AAssImhhc0NsaXAiOgALLCJoaXN0b3J5IjoACSwib3BQa2ciOgAHLCJwaWQiOgAFLCJzIjoACCwidGV4dCI6AAYsInRzIjoABywidWlkIjoADSwidWlkQmVm' +
    'b3JlIjoADCwidmVyaWZpZWQiOgALLCJ3cml0dGVuIjoABi0tZmlsZQAJLS1oaXN0b3J5ABItLWhpc3RvcnkgcmVxdWlyZWQACS0tcGlkZmlsZQAIL2NtZGxp' +
    'bmUABS9wcm9jAAYvcHJvYy8AEDAxMjM0NTY3ODlhYmNkZWYAAjogAAg8Y2xpbml0PgAGPGluaXQ+AEBBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWmFiY2Rl' +
    'ZmdoaWprbG1ub3BxcnN0dXZ3eHl6MDEyMzQ1Njc4OSsvAANCNjQAAUMAAkNJAAhDbGkuamF2YQAQREVEVVBFX1dJTkRPV19NUwASSElTVE9SWV9LRUVQX0xJ' +
    'TkVTABFISVNUT1JZX01BWF9CWVRFUwABSQACSUMAA0lJSQACSUwAA0lMSQABSgADSkpKAAFMAAJMQwADTENDAAJMSQADTElJAAJMSgACTEwAA0xMTAAETExM' +
    'TAACTFoAH0xhbmRyb2lkL2NvbnRlbnQvQ2xpcERhdGEkSXRlbTsAGkxhbmRyb2lkL2NvbnRlbnQvQ2xpcERhdGE7ABlMYW5kcm9pZC9jb250ZW50L0NvbnRl' +
    'eHQ7ABNMYW5kcm9pZC9vcy9CaW5kZXI7ABRMYW5kcm9pZC9vcy9JQmluZGVyOwATTGFuZHJvaWQvb3MvUGFyY2VsOwAUTGFuZHJvaWQvb3MvUHJvY2VzczsA' +
    'HExhbmRyb2lkL29zL1JlbW90ZUV4Y2VwdGlvbjsAE0xhbmRyb2lkL3N5c3RlbS9PczsAIkxkYWx2aWsvYW5ub3RhdGlvbi9FbmNsb3NpbmdDbGFzczsAI0xk' +
    'YWx2aWsvYW5ub3RhdGlvbi9FbmNsb3NpbmdNZXRob2Q7AB5MZGFsdmlrL2Fubm90YXRpb24vSW5uZXJDbGFzczsAIUxkYWx2aWsvYW5ub3RhdGlvbi9NZW1i' +
    'ZXJDbGFzc2VzOwAaTGRhbHZpay9hbm5vdGF0aW9uL1Rocm93czsADExpc3RlbmVyU3R1YgAYTGphdmEvaW8vQnVmZmVyZWRSZWFkZXI7AA5MamF2YS9pby9G' +
    'aWxlOwAZTGphdmEvaW8vRmlsZUlucHV0U3RyZWFtOwAaTGphdmEvaW8vRmlsZU91dHB1dFN0cmVhbTsAFUxqYXZhL2lvL0lucHV0U3RyZWFtOwAbTGphdmEv' +
    'aW8vSW5wdXRTdHJlYW1SZWFkZXI7ABZMamF2YS9pby9PdXRwdXRTdHJlYW07ABxMamF2YS9pby9PdXRwdXRTdHJlYW1Xcml0ZXI7ABVMamF2YS9pby9Qcmlu' +
    'dFN0cmVhbTsAGkxqYXZhL2lvL1JhbmRvbUFjY2Vzc0ZpbGU7ABBMamF2YS9pby9SZWFkZXI7ABBMamF2YS9pby9Xcml0ZXI7ABNMamF2YS9sYW5nL0Jvb2xl' +
    'YW47ABhMamF2YS9sYW5nL0NoYXJTZXF1ZW5jZTsAEUxqYXZhL2xhbmcvQ2xhc3M7ABdMamF2YS9sYW5nL0NsYXNzTG9hZGVyOwAVTGphdmEvbGFuZy9FeGNl' +
    'cHRpb247ACRMamF2YS9sYW5nL0lsbGVnYWxBcmd1bWVudEV4Y2VwdGlvbjsAIUxqYXZhL2xhbmcvSWxsZWdhbFN0YXRlRXhjZXB0aW9uOwATTGphdmEvbGFu' +
    'Zy9JbnRlZ2VyOwAQTGphdmEvbGFuZy9NYXRoOwASTGphdmEvbGFuZy9PYmplY3Q7ABNMamF2YS9sYW5nL1J1bnRpbWU7ABJMamF2YS9sYW5nL1N0cmluZzsA' +
    'GUxqYXZhL2xhbmcvU3RyaW5nQnVpbGRlcjsAEkxqYXZhL2xhbmcvU3lzdGVtOwASTGphdmEvbGFuZy9UaHJlYWQ7ABVMamF2YS9sYW5nL1Rocm93YWJsZTsA' +
    'JUxqYXZhL2xhbmcvcmVmbGVjdC9JbnZvY2F0aW9uSGFuZGxlcjsAGkxqYXZhL2xhbmcvcmVmbGVjdC9NZXRob2Q7ABlMamF2YS9sYW5nL3JlZmxlY3QvUHJv' +
    'eHk7ABpMamF2YS9uaW8vY2hhcnNldC9DaGFyc2V0OwAVTGphdmEvdXRpbC9BcnJheUxpc3Q7ABBMamF2YS91dGlsL0xpc3Q7ABRMbGluby9jbGlwY3RsL0Ns' +
    'aSQxOwAfTGxpbm8vY2xpcGN0bC9DbGkkTGlzdGVuZXJTdHViOwASTGxpbm8vY2xpcGN0bC9DbGk7AAZPUF9QS0cAGFNFUlZJQ0VfV0FJVF9JTlRFUlZBTF9N' +
    'UwASU0VSVklDRV9XQUlUX1RSSUVTAAlTSEVMTF9VSUQAGFRYX0RJU1BBVENIX0NMSVBfQ0hBTkdFRAAEVFlQRQAFVVRGLTgABFVURjgAAVYAAlZJAAJWSgAC' +
    'VkwABlZMSUxJSQADVkxMAARWTExMAANWTFoAAlZaAAFaAAVaSUxMSQACWkwAAltCAAJbQwACW0oAEltMamF2YS9sYW5nL0NsYXNzOwATW0xqYXZhL2xhbmcv' +
    'T2JqZWN0OwATW0xqYXZhL2xhbmcvU3RyaW5nOwACXCIAAlxcAAJcbgACXHIAAlx0AAJcdQAKYWNjZXNzJDAwMAAKYWNjZXNzJDEwMAALYWNjZXNzRmxhZ3MA' +
    'A2FkZAAdYWRkUHJpbWFyeUNsaXBDaGFuZ2VkTGlzdGVuZXIAGmFuZHJvaWQuY29udGVudC5JQ2xpcGJvYXJkAB9hbmRyb2lkLmNvbnRlbnQuSUNsaXBib2Fy' +
    'ZCRTdHViAC1hbmRyb2lkLmNvbnRlbnQuSU9uUHJpbWFyeUNsaXBDaGFuZ2VkTGlzdGVuZXIAGWFuZHJvaWQub3MuU2VydmljZU1hbmFnZXIABmFwcGVuZAAN' +
    'YXBwZW5kSGlzdG9yeQAJYXJyYXljb3B5AAhhc0JpbmRlcgALYXNJbnRlcmZhY2UADGJhc2U2NERlY29kZQAGYmluZGVyAAxib29sZWFuVmFsdWUABmNoYXJB' +
    'dAAJY2xpcGJvYXJkABtjbGlwYm9hcmQgc2VydmljZSBub3QgZm91bmQABWNsb3NlAAxjb2VyY2VUb1RleHQAEWNvbS5hbmRyb2lkLnNoZWxsABFjdXJyZW50' +
    'VGltZU1pbGxpcwAOZHJvcFRvU2hlbGxVaWQABmVxdWFscwAGZXhpc3RzAAVmYXRhbAASZmluZE90aGVyV2F0Y2hQaWRzAAVmbHVzaAAHZm9yTmFtZQADZ2V0' +
    'AA9nZXRBYnNvbHV0ZVBhdGgACGdldENsYXNzAA5nZXRDbGFzc0xvYWRlcgARZ2V0RGVjbGFyZWRNZXRob2QACWdldEl0ZW1BdAAMZ2V0SXRlbUNvdW50AApn' +
    'ZXRNZXNzYWdlAAlnZXRNZXRob2QAB2dldE5hbWUADWdldFBhcmVudEZpbGUADmdldFByaW1hcnlDbGlwAApnZXRSdW50aW1lAApnZXRTZXJ2aWNlAAdnZXRU' +
    'ZXh0AARoYWx0AA5oYXNQcmltYXJ5Q2xpcAAEaGV4NAAKaUNsaXBib2FyZAAHaW5kZXhPZgAKaW5kZXhPZkI2NAAGaW52b2tlAAlqc29uRXJyb3IAD2pzb25T' +
    'dHJpbmdGaWVsZAALa2lsbFByb2Nlc3MAD2xhc3RIaXN0b3J5VGV4dAALbGFzdEluZGV4T2YABmxlbmd0aAAJbGluby1jbGlwABBsaW5vLmNsaXBjdGwuQ2xp' +
    'AARsaXN0AAxtQWRkTGlzdGVuZXIAD21HZXRQcmltYXJ5Q2xpcAAPbUhhc1ByaW1hcnlDbGlwAA9tU2V0UHJpbWFyeUNsaXAABG1haW4AA21heAADbWluABZt' +
    'aXNzaW5nIGJhc2U2NCBwYXlsb2FkAAZta2RpcnMABW15UGlkAAVteVVpZAAEbmFtZQAMbmV3UGxhaW5UZXh0ABBuZXdQcm94eUluc3RhbmNlAARudWxsAApv' +
    'blRyYW5zYWN0AA1vcGVuQ2xpcGJvYXJkAAhvcHRWYWx1ZQADb3V0AAhwYXJzZUludAAHcHJpbnRsbgAFcXVvdGUAAXIABHJlYWQACXJlYWRGdWxseQAIcmVh' +
    'ZExpbmUACHJlYWRUZXh0AAxyZWFkVGV4dEZpbGUAB3JlcGxhY2UAA3J1bgABcwAEc2VlawANc2V0QWNjZXNzaWJsZQAOc2V0UHJpbWFyeUNsaXAABnNldGdp' +
    'ZAAGc2V0dWlkAARzaXplAAVzbGVlcAAGc3RhdHVzAARzdG9wAAlzdWJzdHJpbmcAC3RvQ2hhckFycmF5AAh0b1N0cmluZwAEdHJpbQALdHJpbUhpc3RvcnkA' +
    'B3Vua25vd24ADXVua25vd24gY21kOiAAC3ZhbCRoaXN0b3J5AAx2YWwkbGFzdFRleHQACnZhbCRsYXN0VHMABXZhbHVlAAd2YWx1ZU9mAAV3YXRjaAAFd3Jp' +
    'dGUACXdyaXRlVGV4dAANd3JpdGVUZXh0RmlsZQAGeyJvayI6AD17Im9rIjpmYWxzZSwiZXJyb3IiOiJhbm90aGVyIHdhdGNoIGlzIGFscmVhZHkgcnVubmlu' +
    'ZyIsInBpZCI6ABR7Im9rIjpmYWxzZSwid2hlcmUiOgASeyJvayI6dHJ1ZSwidGV4dCI6ACF7Im9rIjp0cnVlLCJ3YXRjaGluZyI6dHJ1ZSwidWlkIjoABXsi' +
    'dCI6AAF9AAJ9CgCcAX5+RDh7ImJhY2tlbmQiOiJkZXgiLCJjb21waWxhdGlvbi1tb2RlIjoiZGVidWciLCJoYXMtY2hlY2tzdW1zIjpmYWxzZSwibWluLWFw' +
    'aSI6MjEsInNoYS0xIjoiZmFjZWRmNDFiYmQyOGI1NjNkMWU5ZTA5YzVmNzJkN2M1Y2E1OThkNSIsInZlcnNpb24iOiI4LjIuMi1kZXYifQACEAH4ARwBGAoC' +
    'DQH4ARp4Ag4CigEEANEBHgIMAfgBGDUCDgKKAQQa0QEXQgIQAfgBHAEYIQIPAfgBHAEYNAADAQECkCABkCABkCBdgIAEuBxeBPAaAAEBAQUSX4CABJAdYAHc' +
    'HA8AGgAGGgEaARoBGgEaARoBGgEaARoBGgEKAQoBCgEKAQphiIAEgDEBgYAEtDEBiCCMJAGIIMwxAYqACOQxAQrcHgEKrB0BCoggAQqAHgEKqCQBCqgjAQqc' +
    'JQEKzCYBCtgpAQmENAEK4DQBCpgsAQrYIwEK2CwBCswuAQrcLwEKgDgBCthBAQrgQwEK3EcBCqxICR4m3AUkkAFGAAAIF54m3AUEFCTQBwQBAAAAAQAAAII3' +
    'AAACAAAAizcAAJI3AAACAAAAnDcAAKM3AAABAAAArjcAAAEAAAC3NwAAnDgAAAAAAAABAAAAAAAAAF4AAACUOAAAqDgAAAAAAAAAAAAAAAAAALw4AAAAAAAA' +
    'BwAAAAAAAABjAAAAtDgAAGkAAAC0OAAAcAAAALQ4AAB0AAAAtDgAAHYAAAC0OAAAeAAAALQ4AAB5AAAAtDgAABEAAAAAAAAAAQAAAAAAAAABAAAABwEAAHAA' +
    'AAACAAAAPgAAAIwEAAADAAAAQQAAAIQFAAAEAAAAFQAAAJAIAAAFAAAAewAAADgJAAAGAAAAAwAAABANAAABIAAAHgAAAHANAAADIAAAHQAAANMkAAABEAAA' +
    'IgAAAIAnAAACIAAABwEAAKgoAAAEIAAABwAAAII3AAAAIAAAAwAAAMA3AAAFIAAAAQAAAHk4AAADEAAABQAAAJQ4AAAGIAAAAwAAAMQ4AAAAEAAAAQAAADQ5' +
    'AAA=';

  /**
   * 把内嵌 dex 写到设备。用「base64 落盘 → 解码 → 校验大小」三步，
   * 且只在文件不存在或大小不符时才重写，避免每次开面板都做一次大 IO。
   */
  /**
   * 安装过程中的即时反馈。
   *
   * 面板上原来的状态徽标已移除，安装状态统一由「安装设备端工具」按钮本身表达，
   * 所以这里只更新该按钮的文案。
   */
  const setInstallChip = (state) => {
    const btn = document.getElementById('kc_btn_install');
    if (!btn) return;
    const m = {
      installing: '安装中…',
      installed: '已安装',
      missing: '安装设备端工具',
    }[state];
    if (m) btn.textContent = m;
  };

  /**
   * 查询设备端工具是否已安装：installed / missing / noshell
   *
   * 只判断文件在不在，不做版本校验 —— 需要更新时直接点「安装设备端工具」覆盖即可。
   */
  const getInstallState = async () => {
    const res = await runShell(
      `if [ -f ${DEVICE_DEX} ]; then echo __KC_YES__; else echo __KC_NO__; fi`,
      10000);
    if (res == null || res.success === false) return { state: 'noshell' };
    return { state: outOf(res).indexOf('__KC_YES__') !== -1 ? 'installed' : 'missing' };
  };

  /**
   * 写入设备端工具（点安装按钮时调用）。
   *
   * 总是覆盖写入，不做版本比对：设备上那份是什么版本不重要，点了就以插件内置的为准。
   * 写完只校验「文件存在且非空」，用于发现写失败（例如空间不足、base64 被截断）。
   */
  const ensureDeployed = async () => {
    const b64 = CLIPCTL_DEX_B64.replace(/\s+/g, '');
    setInstallChip('installing');
    const res = await runShell(
      `mkdir -p ${DEVICE_DIR} && ` +
      `printf '%s' '${b64}' | base64 -d > ${DEVICE_DEX}.tmp && ` +
      `mv ${DEVICE_DEX}.tmp ${DEVICE_DEX} && chmod 644 ${DEVICE_DEX} && ` +
      `stat -c %s ${DEVICE_DEX} 2>/dev/null`,
      20000);
    const size = parseInt(String(outOf(res)).trim().replace(/[^0-9]/g, ''), 10) || 0;
    if (size <= 0) {
      setInstallChip('missing');
      return false;
    }
    setInstallChip('installed');
    return true;
  };

  const cli = (sub, timeout) =>
    runShell(`CLASSPATH=${DEVICE_DEX} app_process /system/bin lino.clipctl.Cli ${sub}`,
      timeout || 15000);

  /** 解析设备端返回的单行 JSON（可能有 login banner 之类的前缀噪声，取最后一个 { 起的部分） */
  const parseJson = (raw) => {
    const s = String(raw || '');
    const i = s.lastIndexOf('{');
    if (i < 0) return null;
    const j = s.indexOf('}', i);
    if (j < 0) return null;
    try { return JSON.parse(s.slice(i, j + 1)); } catch (e) { return null; }
  };

  /* ================= 设备剪贴板读写 ================= */

  /** 只判断高级功能（shell）是否可用，不碰设备端工具 */
  const checkShell = async () => {
    // 判定「高级功能是否开启」必须看输出的实际内容：
    // runShellWithRoot 失败时返回 {success:false, content:<错误文本>}，不是 null；
    // 而错误文本里常带 "root" 字样（如 "root required"），
    // 所以拿 whoami 做子串匹配会误判成功。
    //
    // 这里用 `id -u` 并要求输出是纯数字：拿到任何有效 uid 就说明命令真的执行了。
    // 不要求必须是 0 —— 设备端工具本身以 uid 2000（com.android.shell）读写剪贴板即可，
    // 强求 root 只会把本来能用的环境判成不可用。
    const uidRes = await runShell('id -u 2>/dev/null || echo -1', 8000);
    if (uidRes == null) {
      state.shellAvailable = false;
      return { ok: false, reason: '未开启高级功能' };
    }
    const uidText = outOf(uidRes).trim();
    const firstToken = uidText.split(/\s+/)[0] || '';
    if (uidRes.success === false || !/^\d+$/.test(firstToken)) {
      state.shellAvailable = false;
      return { ok: false, reason: '未开启高级功能', detail: uidText.slice(0, 100) };
    }
    state.shellAvailable = true;
    return { ok: true, uid: firstToken };
  };

  /**
   * 完整自检：高级功能可用 + 设备端工具已安装 + 确实能读到剪贴板。
   *
   * 不做版本校验 —— 需要更新时点一次「安装设备端工具」覆盖即可。
   * 但仍然检查「是否已安装」和「能不能真的读到」：
   * 少了这两步，未安装时会让用户看到一堆无意义的失败，而不是明确的指引。
   */
  const checkEnv = async () => {
    const shell = await checkShell();
    if (!shell.ok) return shell;

    const inst = await getInstallState();
    state.installState = inst.state;
    if (inst.state !== 'installed') {
      return {
        ok: false,
        needInstall: true,
        installState: inst.state,
        reason: inst.state === 'noshell' ? '未开启高级功能' : '未安装设备端工具',
      };
    }

    const st = parseJson(outOf(await cli('status')));
    if (!st) return { ok: false, reason: '设备端工具无响应' };
    if (!st.ok) return { ok: false, reason: '读剪贴板权限不足', detail: st.error || '' };
    return { ok: true, status: st };
  };

  const deviceRead = async () => {
    const r = parseJson(outOf(await cli('read')));
    if (!r || !r.ok) return null;
    return r.text == null ? '' : r.text;
  };

  /**
   * 写设备剪贴板。
   * 长文本走 --file：把 base64 先落盘再让设备端读取，
   * 避免几 MB 的 base64 直接进 argv（内核与 mksh 对单参数都有上限）。
   */
  const deviceWrite = async (text) => {
    const b64 = b64encode(text);
    let res;
    if (b64.length > 4000) {
      await runShell(
        `mkdir -p ${DEVICE_DIR} && printf '%s' '${b64}' > ${DEVICE_PAYLOAD} && chmod 644 ${DEVICE_PAYLOAD}`,
        15000);
      res = await cli(`write --file ${DEVICE_PAYLOAD}`, 20000);
      runShell(`rm -f ${DEVICE_PAYLOAD}`, 8000);
    } else {
      res = await cli(`write ${b64}`, 20000);
    }
    const r = parseJson(outOf(res));
    return !!(r && r.ok && r.verified);
  };

  /** 历史：从设备文件读，降级读本地缓存 */
  const loadHistory = async () => {
    if (state.shellAvailable !== false) {
      const res = await runShell(
        `test -f ${DEVICE_HISTORY} && timeout 2s awk '{print}' ${DEVICE_HISTORY} || echo __KC_ABSENT__`,
        12000);
      const raw = outOf(res);
      if (raw && raw.indexOf('__KC_ABSENT__') === -1) {
        const items = [];
        raw.split('\n').forEach((line) => {
          line = line.trim();
          if (!line) return;
          try {
            const o = JSON.parse(line);
            if (o && typeof o.s === 'string' && o.s.length > 0) {
              items.push({ t: Number(o.t) || 0, s: o.s });
            }
          } catch (e) { /* 跳过被裁剪打断的半行 */ }
        });
        if (items.length) {
          state.history = dedupeHistory(items);
          saveLocalCache();
          return state.history;
        }
      }
    }
    state.history = loadLocalCache();
    return state.history;
  };

  /** 同内容只保留最近一次，按时间倒序 */
  const dedupeHistory = (items) => {
    const seen = new Map();
    items.forEach((it) => {
      const prev = seen.get(it.s);
      if (!prev || (Number(it.t) || 0) >= (Number(prev.t) || 0)) seen.set(it.s, it);
    });
    return Array.from(seen.values()).sort((a, b) => (Number(b.t) || 0) - (Number(a.t) || 0));
  };

  const saveLocalCache = () => {
    try {
      localStorage.setItem(LOCAL_CACHE_KEY,
        JSON.stringify(state.history.slice(0, LOCAL_CACHE_LIMIT)));
    } catch (e) { /* 配额满时放弃缓存，不影响主流程 */ }
  };

  const loadLocalCache = () => {
    try {
      const raw = localStorage.getItem(LOCAL_CACHE_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return dedupeHistory(arr.filter((x) => x && typeof x.s === 'string'));
    } catch (e) { return []; }
  };

  /* ================= 历史监听（设备端 watch 进程） ================= */

  const isWatchAlive = async () => {
    const res = await runShell(
      `P=$(timeout 2s awk '{print}' ${DEVICE_PID} 2>/dev/null); ` +
      `if [ -n "$P" ] && kill -0 "$P" 2>/dev/null; then echo __KC_ALIVE__; else echo __KC_DEAD__; fi`,
      10000);
    return outOf(res).indexOf('__KC_ALIVE__') !== -1;
  };

  const startWatch = async () => {
    // 不自动安装：没装就不启动，交给调用方提示用户去点安装按钮
    const inst = await getInstallState();
    if (inst.state !== 'installed') {
      state.installState = inst.state;
      setInstallChip(inst.state);
      return false;
    }
    // setsid: 脱离当前会话，插件请求结束后不被回收
    await runShell(
      `mkdir -p ${DEVICE_DIR} && chmod 777 ${DEVICE_DIR} && ` +
      `CLASSPATH=${DEVICE_DEX} setsid app_process /system/bin lino.clipctl.Cli ` +
      `watch --history ${DEVICE_HISTORY} --pidfile ${DEVICE_PID} > ${DEVICE_LOG} 2>&1 &`,
      15000);
    // 等它把 pidfile 写出来
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 350));
      if (await isWatchAlive()) { state.watchOn = true; return true; }
    }
    state.watchOn = false;
    return false;
  };

  const stopWatch = async () => {
    // 先让工具自己收尾，再由 root 兜底 kill（跨 uid 时 SELinux 可能不放行）
    await cli(`stop --pidfile ${DEVICE_PID}`, 12000);
    await runShell(
      `P=$(timeout 2s awk '{print}' ${DEVICE_PID} 2>/dev/null); ` +
      `[ -n "$P" ] && kill -9 "$P" 2>/dev/null; rm -f ${DEVICE_PID}`,
      12000);
    state.watchOn = false;
    return true;
  };

  /* ================= 开机自启 ================= */

  /** 自启落地脚本（base64 内嵌）：避免多层 shell 引号转义地狱，写入后校验长度 */
  const BOOT_SH_B64 =
    'IyEvc3lzdGVtL2Jpbi9zaAojIGthbm8tY2xpcGJvYXJkIOW8gOacuuiHquWQr+iEmuacrAojIOeUsSAvc2RjYXJkL3VmaV90b29s' +
    'c19ib290LnNoIOiwg+eUqO+8iFVGSS1UT09MUyDlubPlj7DlnKjlvIDmnLrnqpflj6PlhoXku6Ugcm9vdCDmiafooYzvvInjgIIK' +
    'IwojIOazqOaEj++8muacrOiEmuacrOmAmuW4uOS7pSByb290IOi6q+S7vei/kOihjO+8jOiAjCBrYW5vLWNsaXBjdGwg5YaF6YOo' +
    '5Lya6Ieq6KGMIHNldHVpZCDliLAKIyB1aWQgMjAwMChjb20uYW5kcm9pZC5zaGVsbCkg5YaN5Y676K+75YaZ5Ymq6LS05p2/IOKA' +
    'lOKAlCDov5nmmK8gQW5kcm9pZCAxMCsg5ZCO5Y+w6K+75Y+WCiMg5Ymq6LS05p2/55qE5YmN5o+Q5p2h5Lu244CC5omA5Lul6L+Z' +
    '6YeM5Yi75oSP5LiN5YGa5Lu75L2VIHNldHVpZO+8jOS6pOe7meW3peWFt+iHquW3seWkhOeQhuOAggoKRElSPS9kYXRhL2xvY2Fs' +
    'L3RtcC9rYW5vX2NsaXBib2FyZApERVg9JERJUi9jbGlwY3RsLmRleApMT0c9JERJUi93YXRjaC5sb2cKUElERj0kRElSL2NsaXAu' +
    'cGlkCgpbIC1mICIkREVYIiBdIHx8IGV4aXQgMApta2RpciAtcCAiJERJUiIgMj4vZGV2L251bGwKCiMgMSkg562J57O757uf5ZCv' +
    '5Yqo5a6M5oiQ77ya5byA5py656qX5Y+j5YaF5b6I5pep5bCx6KKr6LCD55So77yM5q2k5pe2IGNsaXBib2FyZCDmnI3liqHlj6/o' +
    'g73ov5jmsqHlsLHnu6oKaT0wCndoaWxlIFsgIiRpIiAtbHQgNjAgXTsgZG8KICAgIFsgIiQoZ2V0cHJvcCBzeXMuYm9vdF9jb21w' +
    'bGV0ZWQpIiA9ICIxIiBdICYmIGJyZWFrCiAgICBpPSQoKGkgKyAxKSkKICAgIHNsZWVwIDMKZG9uZQpzbGVlcCA1CgojIDIpIOW3' +
    'suWcqOi/kOihjOWwseWIq+mHjeWkjeaLiei1t++8iOmBv+WFjeWkmuasoeinpuWPkeWPoOWKoOWkmuS4quebkeWQrOi/m+eoi++8' +
    'iQppZiBbIC1mICIkUElERiIgXTsgdGhlbgogICAgT0xEPSQoY2F0ICIkUElERiIgMj4vZGV2L251bGwpCiAgICBpZiBbIC1uICIk' +
    'T0xEIiBdICYmIGtpbGwgLTAgIiRPTEQiIDI+L2Rldi9udWxsOyB0aGVuCiAgICAgICAgZWNobyAiWyQoZGF0ZSldIFvoh6rlkK9d' +
    'IOebkeWQrOW3suWcqOi/kOihjCBwaWQ9JE9MRO+8jOi3s+i/hyIgPj4gIiRMT0ciCiAgICAgICAgZXhpdCAwCiAgICBmaQpmaQoK' +
    'IyAzKSDmi4notbfnm5HlkKzjgIJzZXRzaWQg6K6p5a6D6ISx56a75pys6ISa5pys55qE5Lya6K+d77yM6ISa5pys6YCA5Ye65ZCO' +
    '5LiN6KKr5Zue5pS2CmVjaG8gIlskKGRhdGUpXSBb6Ieq5ZCvXSDlkK/liqjliarotLTmnb/nm5HlkKwiID4+ICIkTE9HIgpDTEFT' +
    'U1BBVEg9IiRERVgiIHNldHNpZCBhcHBfcHJvY2VzcyAvc3lzdGVtL2JpbiBrYW5vLmNsaXBjdGwuQ2xpIFwKICAgIHdhdGNoIC0t' +
    'aGlzdG9yeSAiJERJUi9oaXN0b3J5Lmpzb25sIiAtLXBpZGZpbGUgIiRQSURGIiA+PiAiJExPRyIgMj4mMSAmCg==';

  /**
   * 读取自启状态。
   * 判定依据是「启动脚本里有没有我们的标记行」+「落地脚本在不在」，两者都满足才算启用。
   */
  const getBootState = async () => {
    const res = await runShell(
      `if grep -qF 'lino_clipboard_autostart' ${BOOT_SH} 2>/dev/null; then echo __KC_LINE_ON__; else echo __KC_LINE_OFF__; fi; ` +
      `if [ -s ${DEVICE_BOOT_SH} ]; then echo __KC_SH_YES__; else echo __KC_SH_NO__; fi`,
      10000);
    const raw = outOf(res);
    const lineOn = raw.indexOf('__KC_LINE_ON__') !== -1;
    const shExists = raw.indexOf('__KC_SH_YES__') !== -1;
    return { enabled: lineOn && shExists, lineOn, shExists };
  };

  /**
   * 从启动脚本里摘掉本插件的行。
   *
   * 用 grep -vF 重写而非 sed 地址匹配，避免路径里的斜杠当定界符。
   * 只有 grep 正常返回（0=有输出 / 1=全被过滤）才覆盖原文件 ——
   * 否则读失败时会把别人的启动脚本清空。
   */
  const stripBootLine = async () => {
    await runShell(
      `if [ -f ${BOOT_SH} ]; then ` +
      `  grep -vF 'lino_clipboard_autostart' ${BOOT_SH} > ${BOOT_SH}.kc.tmp 2>/dev/null; ` +
      `  _rc=$?; ` +
      `  if [ "$_rc" = "0" ] || [ "$_rc" = "1" ]; then ` +
      `    mv ${BOOT_SH}.kc.tmp ${BOOT_SH}; chmod 666 ${BOOT_SH}; ` +
      `  else rm -f ${BOOT_SH}.kc.tmp; fi; ` +
      `fi`,
      15000);
  };

  /** 开启开机自启：先摘旧行（幂等），再落脚本 + 追加调用行 */
  const enableBoot = async () => {
    const b64 = BOOT_SH_B64.replace(/\s+/g, '');
    await stripBootLine();
    const res = await runShell(
      `mkdir -p ${DEVICE_DIR} && chmod 777 ${DEVICE_DIR} && ` +
      `printf '%s' '${b64}' | base64 -d > ${DEVICE_BOOT_SH} && ` +
      `chmod 755 ${DEVICE_BOOT_SH} && ` +
      `touch ${BOOT_SH} && chmod 666 ${BOOT_SH} && ` +
      `grep -qF 'lino_clipboard_autostart' ${BOOT_SH} || printf '%s\n' '${BOOT_LINE}' >> ${BOOT_SH}; ` +
      `grep -qF 'lino_clipboard_autostart' ${BOOT_SH} && echo __KC_BOOT_ON__`,
      20000);
    return outOf(res).indexOf('__KC_BOOT_ON__') !== -1;
  };

  /** 关闭开机自启：摘除调用行 + 删落地脚本（不删除历史与工具本身） */
  const disableBoot = async () => {
    await stripBootLine();
    const res = await runShell(
      `rm -f ${DEVICE_BOOT_SH}; ` +
      `if grep -qF 'lino_clipboard_autostart' ${BOOT_SH} 2>/dev/null; then echo __KC_STILL_ON__; else echo __KC_BOOT_OFF__; fi`,
      15000);
    return outOf(res).indexOf('__KC_BOOT_OFF__') !== -1;
  };

  /* ================= 卸载 ================= */

  /**
   * 彻底卸载：停监听 → 关自启 → 删整个设备端目录（工具 + 历史）。
   *
   * 只保留这一种卸载方式：之前「保留历史」那档容易让人以为历史还在同步，
   * 实际工具没了就读不到设备历史，留着只会造成误解。
   */
  const uninstallDevice = async () => {
    await stopWatch();
    await disableBoot();

    // 只删本插件自己的目录，且目录名是写死的常量，不会误伤别的插件
    const res = await runShell(
      `rm -rf ${DEVICE_DIR}; ` +
      `if [ -d ${DEVICE_DIR} ] && [ -f ${DEVICE_DIR}/clipctl.dex ]; then echo __KC_LEFT__; else echo __KC_GONE__; fi`,
      20000);
    return outOf(res).indexOf('__KC_GONE__') !== -1;
  };

  /* ================= 面板 ================= */

  // 内容分区风格对齐 CloudFlare 插件：每块一张小卡片
  // （半透明底 + 左侧彩色竖条 + 12px 小标题），比纯文字堆叠更好扫读。
  const KC_CARD = 'margin-bottom:16px;padding:12px;background:rgba(255,255,255,0.05);border-radius:6px;';
  const KC_CARD_T = 'font-size:12px;color:#ccc;margin-bottom:8px;font-weight:500;';

  const buildContent = () => `
    <div class="kc-wrap">
      <div class="kc-status" id="kc_status"></div>

      <div style="${KC_CARD}border-left:3px solid #0ea5e9;">
        <div style="${KC_CARD_T}">📝 写入设备剪贴板</div>
        <textarea class="kc-textarea" id="kc_input"
          placeholder="在此输入要写入 ufi 设备剪贴板的内容"></textarea>
        <div class="kc-actions" style="margin-top:8px;">
          <button type="button" id="kc_btn_write">写入设备剪贴板</button>
          <button type="button" id="kc_btn_pull">读取当前剪贴板</button>
          <button type="button" id="kc_btn_watch">开启后台监听</button>
        </div>
      </div>

      <div style="${KC_CARD}border-left:3px solid #8b5cf6;">
        <div style="${KC_CARD_T}">📋 剪贴板历史</div>
        <div class="kc-actions" style="margin-bottom:8px;">
          <button type="button" id="kc_btn_refresh">刷新历史</button>
          <button type="button" id="kc_btn_clear" class="kc-danger">清空历史</button>
          <span class="kc-chip" id="kc_hist_count"></span>
        </div>
        <div class="kc-list" id="kc_list"></div>
      </div>

      <div style="${KC_CARD}border-left:3px solid #f59e0b;">
        <div style="${KC_CARD_T}">🧩 设备端工具与插件设置</div>
        <div class="kc-actions">
          <button type="button" id="kc_btn_install">安装设备端工具</button>
          <button type="button" id="kc_btn_boot">开启开机自启</button>
          <button type="button" id="kc_btn_uninstall" class="kc-danger">卸载</button>
          <button type="button" id="kc_btn_help">使用说明</button>
        </div>
      </div>
    </div>
  `;

  const setStatus = (html) => {
    const el = document.getElementById('kc_status');
    if (el) el.innerHTML = html;
  };

  const renderStatus = async (envOk, reason) => {
    let chips = '';
    if (state.shellAvailable === false) {
      chips += `<span class="kc-chip kc-bad">未开启高级功能</span>`;
    } else if (!envOk) {
      chips += `<span class="kc-chip kc-bad">设备端不可用${reason ? '：' + reason : ''}</span>`;
    } else {
      chips += `<span class="kc-chip kc-ok">设备剪贴板可读写</span>`;
    }
    chips += state.watchOn
      ? `<span class="kc-chip kc-ok">后台监听中</span>`
      : `<span class="kc-chip kc-warn">后台监听未开启</span>`;
    if (state.bootOn) {
      chips += `<span class="kc-chip kc-ok">开机自启</span>`;
    }
    chips += `<span class="kc-chip">${VERSION}</span>`;
    setStatus(chips);
  };

  /**
   * 复制到「当前浏览器所在设备」的剪贴板（PC 浏览器等），
   * 与「写入设备剪贴板」（安卓 UFI 本机）是两回事。
   *
   * navigator.clipboard 只在安全上下文（https / localhost）可用，
   * 高级后台常用 http 访问，所以必须有 execCommand 兜底。
   */
  const copyToBrowser = async (text) => {
    const val = String(text == null ? '' : text);
    if (!val.length) { toast('内容为空，没有可复制的文本', 'pink'); return false; }

    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(val);
        toast('已复制到本机剪贴板', 'green');
        return true;
      }
    } catch (e) {
      // 权限被拒或非安全上下文，落到下面的兜底
    }

    // 兜底：临时 textarea + execCommand
    try {
      const ta = document.createElement('textarea');
      ta.value = val;
      ta.style.position = 'absolute';
      ta.style.opacity = '0';
      ta.style.left = '-999999px';
      ta.style.top = '-999999px';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      toast(ok ? '已复制到本机剪贴板' : '复制失败，请手动选中文本复制', ok ? 'green' : 'pink');
      return ok;
    } catch (e) {
      toast('复制失败，请手动选中文本复制', 'pink');
      return false;
    }
  };

  const renderHistory = () => {
    const list = document.getElementById('kc_list');
    if (!list) return;

    // 条数徽标：真实总数（可能多于展示条数）
    const counter = document.getElementById('kc_hist_count');
    if (counter) {
      counter.textContent = state.history.length
        ? `${state.history.length} 条`
        : '';
    }

    const items = state.history.slice(0, UI_HISTORY_LIMIT);
    if (!items.length) {
      list.innerHTML = `<div class="kc-empty">暂无历史记录</div>`;
      return;
    }
    list.innerHTML = '';
    items.forEach((it, idx) => {
      const row = document.createElement('div');
      row.className = 'kc-item';

      const main = document.createElement('div');
      main.className = 'kc-item-main';

      const txt = document.createElement('div');
      txt.className = 'kc-item-text';
      txt.textContent = it.s;
      txt.title = it.s;

      const meta = document.createElement('div');
      meta.className = 'kc-item-meta';
      meta.textContent = `${fmtTime(it.t)} · ${String(it.s).length} 字符`;

      main.appendChild(txt);
      main.appendChild(meta);

      const ops = document.createElement('div');
      ops.className = 'kc-item-ops';

      const bUse = document.createElement('button');
      bUse.type = 'button';
      bUse.textContent = '写入';
      bUse.onclick = () => doWrite(it.s);

      const bCopy = document.createElement('button');
      bCopy.type = 'button';
      bCopy.textContent = '复制';
      bCopy.title = '复制到本机（浏览器所在设备）剪贴板';
      bCopy.onclick = () => copyToBrowser(it.s);

      const bDel = document.createElement('button');
      bDel.type = 'button';
      bDel.textContent = '删除';
      bDel.className = 'kc-danger';
      bDel.title = '只删除这一条';
      bDel.onclick = () => deleteHistoryItem(it);

      ops.appendChild(bUse);
      ops.appendChild(bCopy);
      ops.appendChild(bDel);

      row.appendChild(main);
      row.appendChild(ops);
      list.appendChild(row);
    });
  };

  /** 把 checkEnv 的失败原因翻译成给用户看的一句话 */
  const envFailText = (env) => {
    if (!env) return '设备端不可用';
    if (env.needInstall) return '请点击安装「安装设备端工具」';
    if (env.reason === '未开启高级功能') return '请先开启高级功能';
    return '设备端不可用：' + (env.reason || '未知原因');
  };

  const withBusy = async (label, fn) => {
    if (state.busy) { toast('上一个操作还没完成，请稍候', 'pink'); return; }
    state.busy = true;
    try {
      return await fn();
    } catch (e) {
      console.error('[LinoClip]', label, e);
      toast(`${label}失败：${e && e.message ? e.message : e}`, 'pink');
    } finally {
      state.busy = false;
    }
  };

  /** 写入设备剪贴板（含回读校验 + 记入历史） */
  const doWrite = (text) => withBusy('写入剪贴板', async () => {
    const val = String(text == null ? '' : text);
    if (!val.length) return toast('内容为空，没有可写入的文本', 'pink');

    const env = await checkEnv();
    await renderStatus(env.ok, env.reason);
    if (!env.ok) return toast(envFailText(env), 'pink');

    const ok = await deviceWrite(val);
    if (!ok) return toast('写入失败（设备端回读校验不通过）', 'pink');

    state.lastDeviceText = val;
    // 本地立刻落一条，历史面板不用等设备端回写
    state.history = dedupeHistory(
      [{ t: Date.now(), s: val }].concat(state.history));
    saveLocalCache();
    renderHistory();
    toast('已写入设备剪贴板', 'green');

    if (!state.watchOn) {
      // 没开监听的话，手动把这条补进设备历史，保证跨端能读到
      await appendDeviceHistory(val);
    }
  });

  /** 未开监听时手动把一条记进设备历史文件（保持与 watch 相同的行格式） */
  const appendDeviceHistory = async (text) => {
    // 必须带行尾 \n：watch 进程是按行追加的，缺了换行会和上一条粘成同一行，
    // 结果既有记录被污染、解析时又被当成坏行丢掉。
    const line = JSON.stringify({ t: Date.now(), s: text }) + '\n';
    const b64 = b64encode(line);
    await runShell(
      `mkdir -p ${DEVICE_DIR} && printf '%s' '${b64}' | base64 -d >> ${DEVICE_HISTORY} && ` +
      `chmod 666 ${DEVICE_HISTORY}`,
      12000);
  };

  /**
   * 历史文件整份重写（按行）。
   *
   * 用「base64 分块追加」而不是一次 echo 整个文件：
   * 内核 MAX_ARG_STRLEN 限制单参数字节数，历史攒多了会被 E2BIG 截断。
   * 每块约 1200 字符，远低于限制。
   */
  const rewriteDeviceHistory = async (items) => {
    const mkdir = await runShell(`mkdir -p ${DEVICE_DIR} && chmod 777 ${DEVICE_DIR}`, 10000);
    if (mkdir == null || mkdir.success === false) return false;

    // 先清空，再分块追加；任何一块失败都直接返回，避免写出半截文件
    const trunc = await runShell(`: > ${DEVICE_HISTORY} && chmod 666 ${DEVICE_HISTORY}`, 10000);
    if (trunc == null || trunc.success === false) return false;

    const lines = items.map((it) => JSON.stringify({ t: Number(it.t) || 0, s: String(it.s) }));
    const blob = lines.length ? lines.join('\n') + '\n' : '';
    if (!blob) return true;

    const b64 = b64encode(blob);
    const CHUNK = 1200;
    for (let i = 0; i < b64.length; i += CHUNK) {
      const part = b64.slice(i, i + CHUNK);
      const r = await runShell(
        `printf '%s' '${part}' | base64 -d >> ${DEVICE_HISTORY}`,
        15000);
      if (r == null || r.success === false) return false;
    }
    return true;
  };

  /** 删除单条历史（按「内容 + 时间戳」双重匹配，避免误删同名的另一条） */
  const deleteHistoryItem = (item) => withBusy('删除该条历史', async () => {
    const env = await checkEnv();
    if (!env.ok) { await renderStatus(env.ok, env.reason); return toast(envFailText(env), 'pink'); }

    const before = state.history.length;
    // 只从本地列表里摘掉这一个对象引用，其余原样保留
    const kept = state.history.filter((it) => it !== item);
    if (kept.length === before) return toast('该条已不存在，请刷新', 'pink');

    const ok = await rewriteDeviceHistory(kept);
    if (!ok) return toast('删除失败（写设备文件出错）', 'pink');

    state.history = kept;
    saveLocalCache();
    renderHistory();
    toast('已删除该条历史', 'green');
  });

  /** 清空全部历史（需连点确认，避免误触把跨端共享的历史全删） */
  const doClearHistory = () => withBusy('清空历史', async () => {
    const env = await checkEnv();
    if (!env.ok) { await renderStatus(env.ok, env.reason); return toast(envFailText(env), 'pink'); }

    const ok = await runShell(
      `mkdir -p ${DEVICE_DIR} && : > ${DEVICE_HISTORY} && chmod 666 ${DEVICE_HISTORY} && echo __KC_CLEARED__`,
      15000);
    if (outOf(ok).indexOf('__KC_CLEARED__') === -1) return toast('清空失败（写设备文件出错）', 'pink');

    state.history = [];
    saveLocalCache();
    renderHistory();
    toast('已清空全部历史', 'green');
  });

  const doPull = () => withBusy('读取剪贴板', async () => {
    const env = await checkEnv();
    await renderStatus(env.ok, env.reason);
    if (!env.ok) return toast(envFailText(env), 'pink');

    const text = await deviceRead();
    if (text == null) return toast('读取失败', 'pink');
    if (!text.length) return toast('设备剪贴板当前为空', 'pink');

    state.lastDeviceText = text;
    const inp = document.getElementById('kc_input');
    if (inp) inp.value = text;

    state.history = dedupeHistory(
      [{ t: Date.now(), s: text }].concat(state.history));
    saveLocalCache();
    renderHistory();
    toast('已读取设备剪贴板', 'green');
  });

  const doRefresh = () => withBusy('刷新历史', async () => {
    const env = await checkEnv();
    await renderStatus(env.ok, env.reason);
    if (!env.ok) return toast(envFailText(env), 'pink');
    state.watchOn = await isWatchAlive();
    await loadHistory();
    renderHistory();
    await renderStatus(env.ok, env.reason);
    toast(`历史已刷新（${state.history.length} 条）`, 'green');
  });

  const doToggleWatch = () => withBusy('切换后台监听', async () => {
    const env = await checkEnv();
    await renderStatus(env.ok, env.reason);
    if (!env.ok) return toast(envFailText(env), 'pink');

    const btn = document.getElementById('kc_btn_watch');
    if (state.watchOn) {
      await stopWatch();
      toast('已停止后台监听', 'green');
    } else {
      if (btn) { btn.disabled = true; btn.textContent = '启动中…'; }
      const ok = await startWatch();
      if (btn) { btn.disabled = false; }
      toast(ok ? '后台监听已开启' : '后台监听启动失败', ok ? 'green' : 'pink');
    }
    await renderStatus(env.ok, env.reason);
    syncWatchBtn();
  });

  /**
   * 把安装状态渲染到面板上。
   *
   * 面板上没有独立的状态徽标 —— 安装状态完全由「安装设备端工具」按钮的文字体现：
   *   未安装 / 未开高级功能 → 「安装设备端工具」
   *   已安装                → 「已安装」（高亮，可再点覆盖重装）
   */
  const renderInstallState = (st) => {
    const btn = document.getElementById('kc_btn_install');
    if (!btn) return;

    const map = {
      installed: { btn: '已安装', disabled: false, on: true },
      missing: { btn: '安装设备端工具', disabled: false, on: false },
      noshell: { btn: '安装设备端工具', disabled: true, on: false },
    };
    const m = map[st.state] || map.missing;
    btn.textContent = m.btn;
    btn.disabled = !!m.disabled;
    btn.classList.toggle('kc-on', !!m.on);
  };

  /** 手动安装设备端工具（总是覆盖写入，不做版本比对） */
  const doInstall = () => withBusy('安装设备端工具', async () => {
    const shell = await checkShell();
    if (!shell.ok) {
      renderInstallState({ state: 'noshell' });
      await renderStatus(false, shell.reason);
      return toast('请先开启高级功能', 'pink');
    }

    // 覆盖安装前先停掉监听：正在运行的进程持有旧 dex，
    // 覆盖后它仍是旧代码，必须重启才能生效，否则会出现「显示已安装但行为还是旧的」。
    const alive = await isWatchAlive();
    if (alive) {
      await stopWatch();
    }

    const ok = await ensureDeployed();
    const st = await getInstallState();
    renderInstallState(st);

    if (!ok) {
      toast('安装失败（写入后校验不通过），请检查高级功能是否正常', 'pink');
      return;
    }

    // 之前开着监听的，装完自动恢复，避免用户以为监听还在
    if (alive) {
      const restarted = await startWatch();
      toast(restarted ? '已安装并恢复后台监听' : '已安装，但监听恢复失败，请手动开启', restarted ? 'green' : 'pink');
    } else {
      toast('设备端工具已安装', 'green');
    }

    const env = await checkEnv();
    await renderStatus(env.ok, env.reason);
    syncWatchBtn();
  });

  /** 开关开机自启 */
  const doToggleBoot = () => withBusy('切换开机自启', async () => {
    const env = await checkEnv();
    await renderStatus(env.ok, env.reason);
    if (!env.ok) return toast(envFailText(env), 'pink');

    const btn = document.getElementById('kc_btn_boot');
    if (btn) btn.disabled = true;
    try {
      if (state.bootOn) {
        const ok = await disableBoot();
        if (!ok) return toast('关闭开机自启失败', 'pink');
        state.bootOn = false;
        toast('已关闭开机自启', 'green');
      } else {
        // 自启要在重启后恢复监听，所以必须先装好工具（这里只检查，不代为安装）
        const inst = await getInstallState();
        if (inst.state !== 'installed') {
          renderInstallState(inst);
          return toast('请先安装设备端工具，再开启开机自启', 'pink');
        }
        const ok = await enableBoot();
        if (!ok) return toast('开启开机自启失败', 'pink');
        state.bootOn = true;
        toast('已开启开机自启，重启后自动恢复', 'green');
      }
    } finally {
      if (btn) btn.disabled = false;
    }
    const st = await getBootState();
    state.bootOn = st.enabled;
    await renderStatus(true);
    syncWatchBtn();
  });

  /**
   * 清空历史确认：连点 3 次（6 秒内）。与卸载分开计数，互不干扰。
   */
  let clearArm = { count: 0, ts: 0 };
  const confirmClear = (actionName, run) => {
    const now = Date.now();
    if (clearArm.ts && now - clearArm.ts > 6000) clearArm.count = 0;
    clearArm.count += 1;
    clearArm.ts = now;
    const left = 3 - clearArm.count;
    if (left > 0) {
      toast(`【${actionName}】还需再点 ${left} 次确认`, 'pink');
      return;
    }
    clearArm = { count: 0, ts: 0 };
    run();
  };

  /**
   * 卸载。危险操作，用「连点 3 次」确认，避免误触把设备端清掉。
   * 这里不复用宿主的 createModal（嵌套 modal 会互相干扰），
   * 改成二次确认按钮 + 冷却窗口。
   */
  let uninstallArm = { key: null, count: 0, timer: null };
  const confirmUninstall = (key, actionName, run) => {
    const now = Date.now();
    if (uninstallArm.key !== key || (uninstallArm.timer && now - uninstallArm.timer > 6000)) {
      uninstallArm = { key, count: 0, timer: now };
    }
    uninstallArm.count += 1;
    const left = 3 - uninstallArm.count;
    if (left > 0) {
      uninstallArm.timer = now;
      toast(`【${actionName}】危险操作！还需再点 ${left} 次确认`, 'pink');
      return;
    }
    uninstallArm = { key: null, count: 0, timer: null };
    run();
  };

  const doUninstall = () => withBusy('卸载', async () => {
    // 只用 checkShell，不用 checkEnv：
    // 卸载的作用就是清掉设备端文件，工具本来就不在时更应该允许清理残留，
    // 用 checkEnv 会因为「未安装」被拦住，反而没法清。
    const shell = await checkShell();
    if (!shell.ok) {
      await renderStatus(false, shell.reason);
      return toast(envFailText(shell), 'pink');
    }

    const ok = await uninstallDevice();
    state.watchOn = false;
    state.bootOn = false;
    state.history = [];
    saveLocalCache();
    toast(ok ? '已卸载（工具与历史均已删除）' : '卸载未完成，请重试', ok ? 'green' : 'pink');
    await renderStatus(false);
    renderInstallState({ state: 'missing' });
    syncWatchBtn();
    renderHistory();
  });

  const syncWatchBtn = () => {
    const btn = document.getElementById('kc_btn_watch');
    if (btn) btn.textContent = state.watchOn ? '停止后台监听' : '开启后台监听';

    const b = document.getElementById('kc_btn_boot');
    if (b) {
      b.textContent = state.bootOn ? '关闭开机自启' : '开启开机自启';
      b.classList.toggle('kc-on', state.bootOn);
    }
  };

  /* ================= 入口（折叠栏） ================= */
  //
  // 用宿主自带的折叠栏（.collapse + .collapse_box + collapseGen），
  // 与「功能列表」和「插件收纳箱」同一套机制，而不是自建弹窗：
  // 弹窗会盖住页面、和别的插件弹窗抢层级，折叠栏则是就地展开，符合宿主习惯。

  const COLLAPSE_ID = 'lino_clipboard_collapse';       // 与 CloudFlare 一致：开关/面板/记忆key 同名
  const COLLAPSE_SWITCH_ID = 'lino_clipboard_collapse_switch';
  const PANEL_HOST_ID = 'lino_clipboard_host';

  // 结构对齐 CloudFlare 插件：
  //   挂到 .functions-container 之后（就地成为功能列表里的一个折叠分区），
  //   标题行 = <strong>插件名</strong> + 状态 span + 折叠开关，
  //   内容 = .collapse > .collapse_box > ul.deviceList > li（宿主自带的卡片样式）。
  const ensurePanel = () => {
    const container = document.querySelector('.functions-container');
    if (!container) return null;

    let host = document.getElementById(PANEL_HOST_ID);
    if (host) return document.getElementById(COLLAPSE_ID);

    container.insertAdjacentHTML('afterend', `
<div id="${PANEL_HOST_ID}" style="width:100%; margin-top:10px;">
  <div class="title" style="margin:6px 0; color:#fff; display:flex; align-items:center; gap:15px;">
    <strong style="color:#fff;">${TITLE}</strong>
    <span id="kc_title_status" style="font-size:12px;font-weight:600;color:#9ca3af;"></span>
    <div style="display:inline-block;" id="${COLLAPSE_SWITCH_ID}"></div>
  </div>
  <div class="collapse" id="${COLLAPSE_ID}" data-name="close" style="height:0px; overflow:hidden;">
    <div class="collapse_box">
      <ul class="deviceList" style="margin:0;padding:0;list-style:none;">
        <li style="padding:15px;">
          ${buildContent()}
        </li>
      </ul>
    </div>
  </div>
</div>
`);

    // 初始化折叠（第二个参数是记忆用的 key，与 CloudFlare 一致）
    if (typeof collapseGen === 'function') {
      collapseGen('#' + COLLAPSE_SWITCH_ID, '#' + COLLAPSE_ID, '#' + COLLAPSE_ID, () => {});
    } else {
      // 宿主 utils 未就绪时退化为手动切换，保证至少能用
      const el = document.getElementById(COLLAPSE_ID);
      const sw = document.getElementById(COLLAPSE_SWITCH_ID);
      if (sw && el) {
        const b = document.createElement('button');
        b.className = 'btn';
        b.textContent = '展开/收起';
        b.onclick = () => {
          const open = el.dataset.name === 'open';
          el.dataset.name = open ? 'close' : 'open';
          el.style.height = open ? '0px' : 'auto';
        };
        sw.appendChild(b);
      }
    }

    const el = document.getElementById(COLLAPSE_ID);
    if (el) bindPanelEvents(el);
    return el;
  };

  const openPanel = async () => {
    ensureStyle();
    const el = ensurePanel();
    if (!el) return;
    state.modalEl = el;
    // 展开
    el.dataset.name = 'open';
    el.style.height = 'auto';
    await refreshPanelState();
  };

  /** 绑定面板内全部交互（只在首次创建时绑定一次） */
  /* ================= 使用说明 ================= */

  const HELP_ID = 'lino_clipboard_help';

  const HELP_HTML = `
    <div style="font-size:.78rem;line-height:1.75;max-height:60vh;overflow-y:auto;padding-right:4px;">

      <div style="font-weight:600;color:#7dd3fc;margin-bottom:4px;">📝 写入设备剪贴板</div>
      <div style="margin-bottom:6px;opacity:.9;">
        <b>写入设备剪贴板</b>：把输入框里的内容写到 ufi 设备的系统剪贴板，
        之后在设备上任何能粘贴的地方都能直接粘贴（例如短信、浏览器地址栏）。<br>
        <b>读取当前剪贴板</b>：把 ufi 设备当前剪贴板里的文字读出来，填进输入框。<br>
        <b>开启后台监听</b>：见下方「后台监听」一节。
      </div>

      <div style="font-weight:600;color:#c4b5fd;margin-bottom:4px;">📋 剪贴板历史</div>
      <div style="margin-bottom:6px;opacity:.9;">
        历史保存在 ufi 设备文件 <code style="font-size:.72rem;">${DEVICE_HISTORY}</code>，
        任何浏览器打开高级后台看到的都是同一份，换设备也能看到。<br>
        <b>刷新历史</b>：重新从设备读取历史。<br>
        <b>清空历史</b>：删除全部历史，需连点 3 次确认。<br>
        每条历史右侧三个按钮：<br>
        &nbsp;&nbsp;<b>写入</b> = 写到 ufi 设备剪贴板<br>
        &nbsp;&nbsp;<b>复制</b> = 复制到当前浏览器的剪贴板（即你正在用的电脑/手机）<br>
        &nbsp;&nbsp;<b>删除</b> = 只删这一条<br>
        相同内容只保留最近一次。
      </div>

      <div style="font-weight:600;color:#fcd34d;margin-bottom:4px;">🧩 设备端工具与插件设置</div>
      <div style="margin-bottom:6px;opacity:.9;">
        <b>安装设备端工具</b>：本插件不装 APK、不加模块。设备端工具只是放在设备上的一个文件，
        必须先点此按钮安装才能使用，插件不会自动安装。安装后按钮显示「已安装」，
        再点一次即覆盖重装。<br>
        <b>开启开机自启</b>：把自启项写进 ufi 平台的启动脚本，
        重启设备后自动恢复后台监听，无需手动开启。<br>
        <b>卸载</b>：彻底卸载 —— 停止后台监听、移除开机自启、删除设备端工具与历史记录，需连点 3 次确认。
      </div>

      <div style="font-weight:600;color:#7dd3fc;margin-bottom:4px;">🔍 关于「后台监听」</div>
      <div style="opacity:.9;">
        它是一个常驻在 ufi 设备上的进程，向系统剪贴板服务注册变化回调。
        开启后，<b>你在设备上任何应用里复制的内容都会被记录下来</b>，历史里就能看到。<br>
        不开启时，历史只包含你在本插件里点「写入设备剪贴板」产生的记录。<br>
        注意：只记录<b>文本</b>，复制图片或文件不会记录；重启设备后需重新开启
        （除非已开启开机自启）。
      </div>
    </div>
  `;

  /** 打开使用说明弹窗（复用宿主 createModal，与平台上其它插件一致） */
  const openHelp = () => {
    ensureStyle();
    // 已存在就只重新显示，避免重复叠加
    const old = document.getElementById(HELP_ID);
    if (old) { showModal('#' + HELP_ID); return; }

    const res = createModal({
      name: HELP_ID,
      title: '使用说明',
      maxWidth: '520px',
      showConfirm: false,
      onClose: () => true,
      content: HELP_HTML,
    });
    if (!res || !res.id) return toast('使用说明打开失败', 'pink');
    showModal(res.id);
  };

  const bindPanelEvents = (el) => {
    if (!el || el.dataset.kcBound === '1') return;
    el.dataset.kcBound = '1';
    el.querySelector('#kc_btn_write').onclick = () => {
      const inp = el.querySelector('#kc_input');
      doWrite(inp ? inp.value : '');
    };
    el.querySelector('#kc_btn_pull').onclick = () => doPull();
    el.querySelector('#kc_btn_refresh').onclick = () => doRefresh();
    el.querySelector('#kc_btn_clear').onclick = () =>
      confirmClear('清空历史', () => doClearHistory());
    el.querySelector('#kc_btn_watch').onclick = () => doToggleWatch();
    el.querySelector('#kc_btn_install').onclick = () => doInstall();
    el.querySelector('#kc_btn_boot').onclick = () => doToggleBoot();
    el.querySelector('#kc_btn_uninstall').onclick = () =>
      confirmUninstall('uninstall', '卸载', () => doUninstall());
    el.querySelector('#kc_btn_help').onclick = () => openHelp();
  };

  /** 拉取并渲染面板状态（展开时、操作后都可调用） */
  const refreshPanelState = async () => {
    // 先渲染本地缓存（秒开），再拉设备端真实状态
    state.history = loadLocalCache();
    renderHistory();
    setStatus(`<span class="kc-chip">正在连接设备…</span>`);
    renderInstallState({ state: 'missing' });

    // 安装状态单独查一次：即使自检失败，也要让按钮显示「未安装」而不是保持初始文案
    const shell = await checkShell();
    if (!shell.ok) {
      renderInstallState({ state: 'noshell' });
      await renderStatus(false, shell.reason);
      syncWatchBtn();
      return;
    }
    // 首屏只「检测」不「安装」：如果这里顺手部署了，安装按钮永远显示已安装，
    // 就失去了「手动补装」的意义。装不装由用户点按钮决定。
    const inst = await getInstallState();
    state.installState = inst.state;
    renderInstallState(inst);
    await renderStatus(inst.state === 'installed');

    // 已安装才去读监听/自启/历史；未安装时保持空态，避免发出必然失败的命令
    if (inst.state === 'installed') {
      state.watchOn = await isWatchAlive();
      const bs = await getBootState();
      state.bootOn = bs.enabled;
      await loadHistory();
      renderHistory();
      await renderStatus(true);
    }
    syncWatchBtn();
  };

  /* ================= 启动 ================= */

  const boot = () => {
    ensureStyle();
    // 注入折叠栏并把状态拉起来。
    // 宿主按钮区可能还没渲染完，退化为短轮询（最多 ~20s）。
    let tries = 0;
    const tryInit = () => {
      // ensurePanel 内部已完成「建结构 + 绑事件（只绑一次）」
      const el = ensurePanel();
      if (el) {
        refreshPanelState();
        return true;
      }
      return false;
    };
    if (!tryInit()) {
      const timer = setInterval(() => {
        if (tryInit() || ++tries > 40) clearInterval(timer);
      }, 500);
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
//</script>
<!-- [KANO_PLUGIN_END] Lino剪贴板同步-设备端.js -->
