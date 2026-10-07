#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""在 VS Code 右侧的 Codex 聊天面板里，按顺序给多条对话发送「继续」。

面板有两套布局，输入框位置不一样，必须分别用不同坐标：

* **列表视图**（聊天首页）：顶部是对话列表，每条前面有一个橙色感叹号图标；
  底部输入框占位文字是「随心输入」，没有「本地模式」那一行，输入框偏下。
* **对话视图**（点开某条对话后）：左上角有 ← 返回箭头；底部输入框占位文字是
  「提出后续变更要求」，下面多一行「本地模式」，因此输入框整体上移约 60px。

用法::

    # 依次处理列表前 3 条：打开 → 输入「继续」→ 发送 → 返回 → 下一条
    python scripts/codex-auto-continue.py --mode all --count 3 --send

    # 只输入不发送（自检导航与输入）
    python scripts/codex-auto-continue.py --mode all --count 3

    # 只操作当前已打开的那个输入框
    python scripts/codex-auto-continue.py --mode type|send|clear

实现要点
--------
* 文字用 SendInput 的 KEYEVENTF_UNICODE 直接注入，不依赖剪贴板
  （实测 Chromium 里 Ctrl+V 对合成按键不生效，SendInput 可靠）。
* 每一步都截图自检：对比「输入框区域」「面板主体」「代码编辑区」的像素变化，
  确认操作落在预期位置，避免把文字打进代码里或误触其他控件。
* 发送优先点 ↑ 按钮，若输入框没清空再退回回车重试。
* 所有坐标以窗口矩形为参照换算成比例，按 3200x2000 / 200% 缩放 / 窗口最大化
  实测得到。若拖过面板分隔条、改过缩放或 Codex 面板改版，需要重新标定。
"""

from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes as wt
import sys
import time
from pathlib import Path

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
gdi32 = ctypes.windll.gdi32

try:
    user32.SetProcessDPIAware()
except Exception:
    pass

# ---------------------------------------------------------------- ctypes 签名
user32.EnumWindows.argtypes = [ctypes.c_void_p, wt.LPARAM]
user32.IsWindowVisible.argtypes = [wt.HWND]
user32.GetWindowTextLengthW.argtypes = [wt.HWND]
user32.GetWindowTextW.argtypes = [wt.HWND, wt.LPWSTR, ctypes.c_int]
user32.GetWindowRect.argtypes = [wt.HWND, ctypes.POINTER(wt.RECT)]
user32.GetWindowThreadProcessId.argtypes = [wt.HWND, ctypes.POINTER(wt.DWORD)]
user32.GetForegroundWindow.restype = wt.HWND
user32.IsIconic.argtypes = [wt.HWND]
user32.ShowWindow.argtypes = [wt.HWND, ctypes.c_int]
user32.SetForegroundWindow.argtypes = [wt.HWND]
user32.BringWindowToTop.argtypes = [wt.HWND]
user32.AttachThreadInput.argtypes = [wt.DWORD, wt.DWORD, wt.BOOL]
user32.SetCursorPos.argtypes = [ctypes.c_int, ctypes.c_int]
user32.mouse_event.argtypes = [wt.DWORD, wt.DWORD, wt.DWORD, wt.DWORD, ctypes.c_void_p]
user32.GetWindowDC.argtypes = [wt.HWND]
user32.GetWindowDC.restype = ctypes.c_void_p
user32.PrintWindow.argtypes = [wt.HWND, ctypes.c_void_p, wt.UINT]
user32.ReleaseDC.argtypes = [wt.HWND, ctypes.c_void_p]

kernel32.OpenProcess.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
kernel32.OpenProcess.restype = wt.HANDLE
kernel32.QueryFullProcessImageNameW.argtypes = [wt.HANDLE, wt.DWORD, wt.LPWSTR,
                                               ctypes.POINTER(wt.DWORD)]
kernel32.CloseHandle.argtypes = [wt.HANDLE]
kernel32.GetCurrentThreadId.restype = wt.DWORD

gdi32.CreateCompatibleDC.argtypes = [ctypes.c_void_p]
gdi32.CreateCompatibleDC.restype = ctypes.c_void_p
gdi32.CreateCompatibleBitmap.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int]
gdi32.CreateCompatibleBitmap.restype = ctypes.c_void_p
gdi32.SelectObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
gdi32.SelectObject.restype = ctypes.c_void_p
gdi32.GetDIBits.argtypes = [ctypes.c_void_p, ctypes.c_void_p, wt.UINT, wt.UINT,
                            ctypes.c_void_p, ctypes.c_void_p, wt.UINT]
gdi32.DeleteObject.argtypes = [ctypes.c_void_p]
gdi32.DeleteDC.argtypes = [ctypes.c_void_p]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wt.WORD), ("wScan", wt.WORD), ("dwFlags", wt.DWORD),
                ("time", wt.DWORD), ("dwExtraInfo", ctypes.c_void_p)]


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", ctypes.c_long), ("dy", ctypes.c_long), ("mouseData", wt.DWORD),
                ("dwFlags", wt.DWORD), ("time", wt.DWORD), ("dwExtraInfo", ctypes.c_void_p)]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [("uMsg", wt.DWORD), ("wParamL", wt.WORD), ("wParamH", wt.WORD)]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("ki", KEYBDINPUT), ("mi", MOUSEINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _fields_ = [("type", wt.DWORD), ("u", _INPUTUNION)]


user32.SendInput.argtypes = [wt.UINT, ctypes.POINTER(INPUT), ctypes.c_int]

INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004

(VK_CONTROL, VK_A, VK_Z, VK_DELETE, VK_RETURN, VK_ESCAPE) = (0x11, 0x41, 0x5A, 0x2E, 0x0D, 0x1B)

# --------------------------------------------------------------- 布局比例
# 列表视图
LIST_ITEM_X = 0.8060                                  # 列表项点击横坐标
LIST_ITEM_Y = [0.1256, 0.1561, 0.1859]                # 第 1/2/3 条列表项纵坐标
BACK_ARROW = (0.6627, 0.0927)                         # 对话视图左上角 ←

# 两套 composer 布局：click=输入框内一点, box=输入框区域, send=↑ 发送按钮
HOME_COMPOSER = {
    "click": (0.8214, 0.8575),
    "box": (0.6587, 0.8394, 0.9888, 0.8808),
    "send": (0.9755, 0.9114),
}
CONV_COMPOSER = {
    "click": (0.8214, 0.8290),
    "box": (0.6587, 0.8031, 0.9888, 0.8549),
    "send": (0.9727, 0.8720),
}

PANEL_FRAC = (0.6540, 0.0466, 1.0, 0.80)              # 面板主体：区分「列表 / 对话」
EDITOR_FRAC = (0.18, 0.10, 0.58, 0.78)                # 代码编辑区（避开左侧文件树）

TYPED_THRESHOLD = 0.30     # 输入框出现文字的最小变化量
EDITOR_ALARM = 0.30        # 代码区变化超过它 = 疑似误输入
SENT_THRESHOLD = 0.30      # 发送后输入框相对「已填好内容」的变化量，超过它 = 内容已发出
VIEW_THRESHOLD = 3.0       # 面板主体变化超过它 = 视图切换成功（列表里的时间戳会小幅变动）
SETTLE_WAIT = 0.9          # 切前台后等画面稳定
VIEW_WAIT = 1.5            # 打开对话 / 返回列表后等渲染


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", wt.DWORD), ("biWidth", ctypes.c_long),
                ("biHeight", ctypes.c_long), ("biPlanes", wt.WORD),
                ("biBitCount", wt.WORD), ("biCompression", wt.DWORD),
                ("biSizeImage", wt.DWORD), ("biXPelsPerMeter", ctypes.c_long),
                ("biYPelsPerMeter", ctypes.c_long), ("biClrUsed", wt.DWORD),
                ("biClrImportant", wt.DWORD)]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", wt.DWORD * 3)]


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


# ------------------------------------------------------------------ 输入注入
def send_vk(vk: int, with_ctrl: bool = False) -> None:
    seq = []
    if with_ctrl:
        seq.append(KEYBDINPUT(wVk=VK_CONTROL, wScan=0, dwFlags=0, time=0, dwExtraInfo=None))
    seq.append(KEYBDINPUT(wVk=vk, wScan=0, dwFlags=0, time=0, dwExtraInfo=None))
    seq.append(KEYBDINPUT(wVk=vk, wScan=0, dwFlags=KEYEVENTF_KEYUP, time=0, dwExtraInfo=None))
    if with_ctrl:
        seq.append(KEYBDINPUT(wVk=VK_CONTROL, wScan=0, dwFlags=KEYEVENTF_KEYUP, time=0,
                              dwExtraInfo=None))
    arr = (INPUT * len(seq))()
    for i, ki in enumerate(seq):
        arr[i].type = INPUT_KEYBOARD
        arr[i].u.ki = ki
    user32.SendInput(len(seq), arr, ctypes.sizeof(INPUT))
    time.sleep(0.25)


def send_text(text: str) -> None:
    seq = []
    for ch in text:
        seq.append(KEYBDINPUT(wVk=0, wScan=ord(ch), dwFlags=KEYEVENTF_UNICODE,
                              time=0, dwExtraInfo=None))
        seq.append(KEYBDINPUT(wVk=0, wScan=ord(ch),
                              dwFlags=KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                              time=0, dwExtraInfo=None))
    arr = (INPUT * len(seq))()
    for i, ki in enumerate(seq):
        arr[i].type = INPUT_KEYBOARD
        arr[i].u.ki = ki
    user32.SendInput(len(seq), arr, ctypes.sizeof(INPUT))
    time.sleep(0.45)


# ------------------------------------------------------------------ 窗口操作
def proc_name(pid: int) -> str:
    h = kernel32.OpenProcess(0x1000, False, pid)
    if not h:
        return "?"
    buf = ctypes.create_unicode_buffer(1024)
    size = wt.DWORD(1024)
    ok = kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size))
    kernel32.CloseHandle(h)
    return buf.value.rsplit("\\", 1)[-1] if ok else "?"


def find_vscode_window() -> tuple[int, str]:
    found: list[tuple[int, str]] = []
    EnumProc = ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)

    def cb(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        n = user32.GetWindowTextLengthW(hwnd)
        if n == 0:
            return True
        title = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(hwnd, title, n + 1)
        pid = wt.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if proc_name(pid.value).lower() == "code.exe":
            found.append((hwnd, title.value))
        return True

    user32.EnumWindows(EnumProc(cb), 0)
    if not found:
        raise RuntimeError("没有找到 VS Code 窗口，请先打开 VS Code")
    for hwnd, title in found:
        if "visual studio code" in title.lower():
            return hwnd, title
    return found[0]


def ensure_maximized(hwnd: int) -> None:
    """确保窗口处于最大化状态。

    所有坐标都是按「窗口最大化」时的布局标定的：Codex 面板宽度基本固定，窗口一变
    小，编辑区和面板的比例就变了，比例坐标会整体失效。所以宁可先最大化再操作。
    """
    user32.IsZoomed.argtypes = [wt.HWND]
    if user32.IsZoomed(hwnd):
        return
    log("窗口当前不是最大化，先最大化以保证布局与标定一致")
    user32.ShowWindow(hwnd, 3)  # SW_MAXIMIZE
    time.sleep(0.9)


def force_foreground(hwnd: int) -> bool:
    """把 VS Code 切到前台。

    实测：当别的窗口（例如 WorkBuddy 自己）在前台时，SetForegroundWindow 会被
    系统直接拒绝，AttachThreadInput 也救不回来。因此补一条兜底路径——点击窗口
    标题栏：鼠标点击属于系统级输入，会走正常的「点击激活」逻辑，不受前台锁定
    限制。两条路都失败才返回 False（此时绝不能继续输入，否则文字会打进别的
    程序里）。
    """
    if user32.GetForegroundWindow() == hwnd:
        return True
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, 9)  # SW_RESTORE
        time.sleep(0.6)

    cur = kernel32.GetCurrentThreadId()
    tgt = user32.GetWindowThreadProcessId(hwnd, None)
    user32.AttachThreadInput(cur, tgt, True)
    user32.BringWindowToTop(hwnd)
    user32.SetForegroundWindow(hwnd)
    user32.AttachThreadInput(cur, tgt, False)
    time.sleep(0.4)
    if user32.GetForegroundWindow() == hwnd:
        return True

    r = wt.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    w, h = r.right - r.left, r.bottom - r.top
    # 先点标题栏空白处（最安全），再退而点编辑区
    for fx, fy in ((0.50, 0.012), (0.50, 0.012), (0.35, 0.50)):
        click(r.left + int(fx * w), r.top + int(fy * h))
        time.sleep(0.7)
        if user32.GetForegroundWindow() == hwnd:
            return True
    return False


def click(x: int, y: int) -> None:
    user32.SetCursorPos(int(x), int(y))
    time.sleep(0.2)
    user32.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, None)
    time.sleep(0.08)
    user32.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, None)
    time.sleep(0.3)


def capture_window(hwnd: int):
    from PIL import Image
    rect = wt.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    w, h = rect.right - rect.left, rect.bottom - rect.top
    hdc = user32.GetWindowDC(hwnd)
    memdc = gdi32.CreateCompatibleDC(hdc)
    bmp = gdi32.CreateCompatibleBitmap(hdc, w, h)
    old = gdi32.SelectObject(memdc, bmp)
    user32.PrintWindow(hwnd, memdc, 2)  # PW_RENDERFULLCONTENT
    bmi = BITMAPINFO()
    bmi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bmi.bmiHeader.biWidth = w
    bmi.bmiHeader.biHeight = -h
    bmi.bmiHeader.biPlanes = 1
    bmi.bmiHeader.biBitCount = 32
    buf = ctypes.create_string_buffer(w * h * 4)
    gdi32.GetDIBits(memdc, bmp, 0, h, buf, ctypes.byref(bmi), 0)
    img = Image.frombuffer("RGBA", (w, h), buf, "raw", "BGRA", 0, 1).convert("RGB")
    gdi32.SelectObject(memdc, old)
    gdi32.DeleteObject(bmp)
    gdi32.DeleteDC(memdc)
    user32.ReleaseDC(hwnd, hdc)
    return img, rect


def region_change(a, b, frac) -> float:
    from PIL import ImageChops, ImageStat
    w, h = a.size
    box = (int(frac[0] * w), int(frac[1] * h), int(frac[2] * w), int(frac[3] * h))
    diff = ImageChops.difference(a.crop(box), b.crop(box)).convert("L")
    return ImageStat.Stat(diff).mean[0]


class Session:
    """封装一次操作过程中的窗口句柄、截图与坐标换算。"""

    def __init__(self, shot_dir: str | None):
        self.hwnd, self.title = find_vscode_window()
        log(f"窗口 hwnd={self.hwnd} title={self.title!r}")
        ensure_maximized(self.hwnd)
        if not force_foreground(self.hwnd):
            raise RuntimeError("无法把 VS Code 切到前台，输入不会生效")
        log("VS Code 已置于前台")
        rect = wt.RECT()
        user32.GetWindowRect(self.hwnd, ctypes.byref(rect))
        self.rect = rect
        self.w = rect.right - rect.left
        self.h = rect.bottom - rect.top
        self.shots = Path(shot_dir) if shot_dir else None
        if self.shots:
            self.shots.mkdir(parents=True, exist_ok=True)
        log(f"窗口尺寸 {self.w}x{self.h} @ ({rect.left},{rect.top})")

    def pt(self, frac) -> tuple[int, int]:
        return (self.rect.left + int(frac[0] * self.w),
                self.rect.top + int(frac[1] * self.h))

    def snap(self, tag: str):
        img, _ = capture_window(self.hwnd)
        if self.shots:
            img.save(self.shots / f"{tag}.png")
        return img

    def click_frac(self, frac) -> None:
        x, y = self.pt(frac)
        click(x, y)

    def dismiss_popups(self) -> None:
        """按 Esc 关掉可能已经打开的浮层（例如模型选择器）。"""
        send_vk(VK_ESCAPE)
        time.sleep(0.3)
        send_vk(VK_ESCAPE)
        time.sleep(0.4)

    # ------------------------------------------------------ 单个 composer 操作
    def fill_composer(self, geo, text: str, tag: str):
        """点进输入框并输入文字。返回 (输入框变化, 编辑区变化, 空态截图, 输入后截图)。"""
        self.click_frac(geo["click"])
        time.sleep(0.4)
        empty = self.snap(f"{tag}-focused")
        send_text(text)
        typed = self.snap(f"{tag}-typed")
        return (region_change(empty, typed, geo["box"]),
                region_change(empty, typed, EDITOR_FRAC), empty, typed)

    def send(self, geo, filled, tag: str) -> tuple[bool, float]:
        """先点 ↑ 发送按钮，不行再回车。

        判据：输入框在发送前是「已填好内容」的状态，发送成功后会被清空，
        因此**变化量大**才代表发出去了（不能用空态做基准，因为输入框里
        可能残留上一次没发出去的草稿）。
        """
        self.click_frac(geo["send"])
        time.sleep(1.5)
        shot = self.snap(f"{tag}-after-send-button")
        d = region_change(filled, shot, geo["box"])
        if d > SENT_THRESHOLD:
            return True, d
        log(f"点发送按钮后输入框内容没变化（{d:.2f}），改用回车重试")
        send_vk(VK_RETURN)
        time.sleep(1.5)
        shot = self.snap(f"{tag}-after-enter")
        d = region_change(filled, shot, geo["box"])
        return d > SENT_THRESHOLD, d

    def go_back(self) -> None:
        self.click_frac(BACK_ARROW)
        time.sleep(VIEW_WAIT)


def run_composer(sess: Session, geo, text: str, mode: str, tag: str = "single") -> int:
    d_in, d_ed, empty, _typed = sess.fill_composer(geo, text, tag)
    log(f"输入后变化：输入框 {d_in:.2f} / 编辑区 {d_ed:.2f}")

    if d_in < TYPED_THRESHOLD:
        if d_ed > EDITOR_ALARM:
            log("自检失败：输入框没收到文字而代码区变了，疑似误输入，按 Ctrl+Z 撤销")
            send_vk(VK_Z, with_ctrl=True)
            return 2
        log("自检失败：输入框没有收到文字（点击可能没聚焦）")
        return 2
    if d_ed > EDITOR_ALARM:
        log(f"提示：代码区也有变化（{d_ed:.2f}），但输入框已收到文字，按成功处理")

    # 焦点已确认在输入框内，全选重输可保证内容干净（不会残留上一次的草稿）
    send_vk(VK_A, with_ctrl=True)
    send_text(text)
    filled = sess.snap(f"{tag}-filled")

    if mode == "type":
        log("type 模式：只输入不发送")
        return 0
    if mode == "clear":
        send_vk(VK_A, with_ctrl=True)
        send_vk(VK_DELETE)
        time.sleep(0.4)
        cleared = sess.snap(f"{tag}-cleared")
        d = region_change(filled, cleared, geo["box"])
        log(f"清空后输入框变化 {d:.2f}")
        return 0 if d > SENT_THRESHOLD else 4

    ok, d = sess.send(geo, filled, tag)
    log(f"发送{'成功' if ok else '未确认'}（输入框变化 {d:.2f}）")
    return 0 if ok else 4


def run_all(sess: Session, text: str, count: int, do_send: bool) -> int:
    # 先回到列表视图：Esc 关浮层，再点 ← 返回箭头
    sess.dismiss_popups()
    sess.click_frac(BACK_ARROW)
    time.sleep(VIEW_WAIT)
    list_ref = sess.snap("0-list")

    rc = 0
    for i in range(count):
        if i >= len(LIST_ITEM_Y):
            log(f"第 {i + 1} 条超出已标定的坐标范围，停止")
            break
        tag = f"c{i + 1}"
        log(f"--- 第 {i + 1} 条对话 ---")

        sess.click_frac((LIST_ITEM_X, LIST_ITEM_Y[i]))
        time.sleep(VIEW_WAIT)
        opened = sess.snap(f"{tag}-opened")
        d_view = region_change(list_ref, opened, PANEL_FRAC)
        log(f"打开对话，面板变化 {d_view:.2f}")
        if d_view < VIEW_THRESHOLD:
            log(f"警告：点第 {i + 1} 条后视图没变化，可能没打开成功")
            rc = max(rc, 5)

        r = run_composer(sess, CONV_COMPOSER, text, "send" if do_send else "type", tag)
        rc = max(rc, r)
        log(f"第 {i + 1} 条结果：{'完成' if r == 0 else f'异常({r})'}")

        sess.go_back()
        back = sess.snap(f"{tag}-back")
        d_back = region_change(list_ref, back, PANEL_FRAC)
        if d_back > VIEW_THRESHOLD:
            log(f"警告：点返回箭头后没回到列表视图（变化 {d_back:.2f}）")
            rc = max(rc, 5)
        else:
            log(f"已返回列表（变化 {d_back:.2f}）")
    return rc


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", default="继续")
    ap.add_argument("--mode", choices=["all", "type", "send", "clear"], default="all")
    ap.add_argument("--count", type=int, default=3, help="all 模式下处理前几条对话")
    ap.add_argument("--send", action="store_true", help="all 模式下真正发送（否则只输入）")
    ap.add_argument("--shot-dir", default=None, help="保存过程截图便于人工核对")
    args = ap.parse_args()

    sess = Session(args.shot_dir)

    if args.mode == "all":
        rc = run_all(sess, args.text, args.count, args.send)
    else:
        # 单条模式默认按「对话视图」的布局操作（对话视图是主要使用场景）
        rc = run_composer(sess, CONV_COMPOSER, args.text, args.mode, "single")
    log(f"结束，退出码 {rc}")
    return rc


if __name__ == "__main__":
    sys.exit(main())
