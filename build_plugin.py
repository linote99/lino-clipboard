#!/usr/bin/env python3
"""把设备端产物内嵌进插件模板，生成最终插件。

两个内嵌物：
  CLIPCTL_DEX_B64   设备端工具 dex（base64，按行折开便于 diff）
  BOOT_SH_B64       开机自启脚本（base64）
"""
import hashlib
import pathlib

HERE = pathlib.Path(__file__).parent
DEX = HERE / 'build/dex/classes.dex'
TPL = HERE / 'plugin_template.js'
OUT = HERE / 'lino-clipboard.js'

WRAP = 120


def b64_block(data: bytes) -> str:
    """折成多行 JS 字符串拼接，避免单行 20KB 难以 diff"""
    import base64
    b64 = base64.b64encode(data).decode()
    lines = [b64[i:i + WRAP] for i in range(0, len(b64), WRAP)]
    return '\n'.join("    '%s' +" % ln for ln in lines).rstrip(' +')


def main() -> None:
    dex = DEX.read_bytes()
    text = TPL.read_text(encoding='utf-8')

    text = text.replace('__CLIPCTL_DEX_B64__', b64_block(dex))

    boot_sh = (HERE / 'boot_start.sh').read_bytes()
    text = text.replace('__BOOT_SH_B64__', b64_block(boot_sh))

    for token in ('__CLIPCTL_DEX_B64__', '__BOOT_SH_B64__'):
        assert token not in text, '占位符未替换: ' + token

    OUT.write_text(text, encoding='utf-8')
    print('dex %d bytes sha=%s' % (len(dex), hashlib.sha256(dex).hexdigest()[:16]))
    print('boot_start.sh %d bytes' % len(boot_sh))
    print('plugin %d bytes -> %s' % (len(text.encode('utf-8')), OUT.name))


if __name__ == '__main__':
    main()
