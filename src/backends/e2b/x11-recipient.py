"""Fixed X11 recipient verifier for the E2B screenshot-point path.

The worker accepts only a bounded JSON ``verify`` or ``click`` request.  It
uses ctypes against libX11/libXtst directly; it never executes a shell command,
accepts a model-supplied window grant, or invents screen-sized geometry.

``verify`` proves the exact decimal X11 client window, _NET_WM_PID, WM_CLASS,
visibility, active-window/focus ancestry, translated screen bounds, and the
topmost client at the requested screen point.  ``click`` repeats that proof in
the same request, then uses XTest motion/button events.  Reads never move the
pointer.  A missing proof is a refusal.
"""

import ctypes
import ctypes.util
import json
import os
import re
import sys
import time


MAX_DEPTH = 64
MAX_TREE_NODES = 4096
MAX_WINDOW_ID = 0xFFFFFFFF
MAX_TYPE_TEXT = 4096
MAX_SCROLL_AMOUNT = 20
WINDOW_ID = re.compile(r"^[1-9][0-9]*$")
APPLICATION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.+-]{0,127}$")
ALLOWED_REQUEST_KEYS = {"op", "window_id", "process_id", "application", "point", "text", "direction", "amount"}
VIEWABLE = 2  # IsViewable from Xlib's map_state enum.
ROOT_PARENT = 0
POINTER_ROOT = 1
NONE_WINDOW = 0


class XWindowAttributes(ctypes.Structure):
    _fields_ = [
        ("x", ctypes.c_int),
        ("y", ctypes.c_int),
        ("width", ctypes.c_int),
        ("height", ctypes.c_int),
        ("border_width", ctypes.c_int),
        ("depth", ctypes.c_int),
        ("visual", ctypes.c_void_p),
        ("root", ctypes.c_ulong),
        ("window_class", ctypes.c_int),
        ("bit_gravity", ctypes.c_int),
        ("win_gravity", ctypes.c_int),
        ("backing_store", ctypes.c_int),
        ("backing_planes", ctypes.c_ulong),
        ("backing_pixel", ctypes.c_ulong),
        ("save_under", ctypes.c_int),
        ("colormap", ctypes.c_ulong),
        ("map_installed", ctypes.c_int),
        ("map_state", ctypes.c_int),
        ("all_event_masks", ctypes.c_long),
        ("your_event_mask", ctypes.c_long),
        ("do_not_propagate_mask", ctypes.c_long),
        ("override_redirect", ctypes.c_int),
        ("screen", ctypes.c_void_p),
    ]


class XSelectionRequestEvent(ctypes.Structure):
    _fields_ = [
        ("type", ctypes.c_int),
        ("serial", ctypes.c_ulong),
        ("send_event", ctypes.c_int),
        ("display", ctypes.c_void_p),
        ("owner", ctypes.c_ulong),
        ("requestor", ctypes.c_ulong),
        ("selection", ctypes.c_ulong),
        ("target", ctypes.c_ulong),
        ("property", ctypes.c_ulong),
        ("time", ctypes.c_ulong),
    ]


class XSelectionEvent(ctypes.Structure):
    _fields_ = [
        ("type", ctypes.c_int),
        ("serial", ctypes.c_ulong),
        ("send_event", ctypes.c_int),
        ("display", ctypes.c_void_p),
        ("requestor", ctypes.c_ulong),
        ("selection", ctypes.c_ulong),
        ("target", ctypes.c_ulong),
        ("property", ctypes.c_ulong),
        ("time", ctypes.c_ulong),
    ]


SELECTION_CLEAR = 29
SELECTION_REQUEST = 30


class XResClient(ctypes.Structure):
    _fields_ = [("resource_base", ctypes.c_ulong), ("resource_mask", ctypes.c_ulong)]


def fail(code):
    raise RuntimeError(code)


def safe_window(value):
    if not isinstance(value, str) or not WINDOW_ID.fullmatch(value):
        fail("x11_recipient_window_id_invalid")
    number = int(value, 10)
    if number > MAX_WINDOW_ID:
        fail("x11_recipient_window_id_invalid")
    return number


def safe_request(raw, operation=None):
    if not isinstance(raw, dict) or set(raw) - ALLOWED_REQUEST_KEYS:
        fail("x11_recipient_request_invalid")
    op = raw.get("op") if operation is None else operation
    if op not in {"verify", "click", "scroll", "keyboard_focus", "type_text"}:
        fail("x11_recipient_request_invalid")
    window_id = safe_window(raw.get("window_id"))
    pid = raw.get("process_id")
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0 or pid > 0x7FFFFFFF:
        fail("x11_recipient_process_id_invalid")
    application = raw.get("application")
    if not isinstance(application, str) or not APPLICATION.fullmatch(application):
        fail("x11_recipient_application_invalid")
    if op in {"keyboard_focus", "type_text"}:
        if any(key in raw for key in ("point", "direction", "amount")):
            fail("x11_recipient_request_invalid")
        if op == "type_text":
            text = raw.get("text")
            if not isinstance(text, str) or not text or len(text) > MAX_TYPE_TEXT or any(ord(char) < 0x20 and char not in "\t\n\r" for char in text):
                fail("x11_recipient_text_invalid")
            return {"op": op, "window_id": window_id, "process_id": pid, "application": application.lower(), "text": text}
        return {"op": op, "window_id": window_id, "process_id": pid, "application": application.lower()}
    if op in {"verify", "click"} and ("direction" in raw or "amount" in raw):
        fail("x11_recipient_request_invalid")
    if op == "scroll":
        direction = raw.get("direction")
        amount = raw.get("amount")
        if direction not in {"up", "down"}:
            fail("x11_recipient_scroll_direction_invalid")
        if isinstance(amount, bool) or not isinstance(amount, int) or amount < 1 or amount > MAX_SCROLL_AMOUNT:
            fail("x11_recipient_scroll_amount_invalid")
    point = raw.get("point")
    if not isinstance(point, dict) or set(point) != {"x", "y"}:
        fail("x11_recipient_point_invalid")
    x, y = point.get("x"), point.get("y")
    if isinstance(x, bool) or isinstance(y, bool) or not isinstance(x, int) or not isinstance(y, int):
        fail("x11_recipient_point_invalid")
    result = {"op": op, "window_id": window_id, "process_id": pid, "application": application.lower(), "point": (x, y)}
    if op == "scroll":
        result["direction"] = direction
        result["amount"] = amount
    return result


def load_x11():
    x11_name = ctypes.util.find_library("X11")
    xtst_name = ctypes.util.find_library("Xtst")
    if not x11_name or not xtst_name:
        fail("x11_recipient_library_unavailable")
    try:
        x11 = ctypes.CDLL(x11_name)
        xtst = ctypes.CDLL(xtst_name)
    except OSError:
        fail("x11_recipient_library_unavailable")
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x11.XOpenDisplay.restype = ctypes.c_void_p
    display = x11.XOpenDisplay(None)
    if not display:
        fail("x11_recipient_display_unavailable")
    x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
    x11.XCloseDisplay.restype = ctypes.c_int
    x11.XDefaultScreen.argtypes = [ctypes.c_void_p]
    x11.XDefaultScreen.restype = ctypes.c_int
    x11.XRootWindow.argtypes = [ctypes.c_void_p, ctypes.c_int]
    x11.XRootWindow.restype = ctypes.c_ulong
    x11.XDisplayWidth.argtypes = [ctypes.c_void_p, ctypes.c_int]
    x11.XDisplayWidth.restype = ctypes.c_int
    x11.XDisplayHeight.argtypes = [ctypes.c_void_p, ctypes.c_int]
    x11.XDisplayHeight.restype = ctypes.c_int
    x11.XGetWindowAttributes.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(XWindowAttributes)]
    x11.XGetWindowAttributes.restype = ctypes.c_int
    x11.XGetGeometry.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_uint)]
    x11.XGetGeometry.restype = ctypes.c_int
    x11.XTranslateCoordinates.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_ulong)]
    x11.XTranslateCoordinates.restype = ctypes.c_int
    x11.XQueryTree.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.POINTER(ctypes.c_ulong)), ctypes.POINTER(ctypes.c_uint)]
    x11.XQueryTree.restype = ctypes.c_int
    x11.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    x11.XInternAtom.restype = ctypes.c_ulong
    x11.XGetWindowProperty.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_long, ctypes.c_long, ctypes.c_int, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.POINTER(ctypes.c_ubyte))]
    x11.XGetWindowProperty.restype = ctypes.c_int
    x11.XFree.argtypes = [ctypes.c_void_p]
    x11.XFree.restype = ctypes.c_int
    x11.XGetInputFocus.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_int)]
    x11.XGetInputFocus.restype = ctypes.c_int
    x11.XFlush.argtypes = [ctypes.c_void_p]
    x11.XFlush.restype = ctypes.c_int
    x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
    x11.XSync.restype = ctypes.c_int
    x11.XCreateSimpleWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint, ctypes.c_uint, ctypes.c_ulong, ctypes.c_ulong]
    x11.XCreateSimpleWindow.restype = ctypes.c_ulong
    x11.XDestroyWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    x11.XDestroyWindow.restype = ctypes.c_int
    x11.XGetSelectionOwner.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    x11.XGetSelectionOwner.restype = ctypes.c_ulong
    x11.XSetSelectionOwner.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
    x11.XSetSelectionOwner.restype = ctypes.c_int
    x11.XPending.argtypes = [ctypes.c_void_p]
    x11.XPending.restype = ctypes.c_int
    x11.XNextEvent.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    x11.XNextEvent.restype = ctypes.c_int
    x11.XChangeProperty.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
    x11.XChangeProperty.restype = ctypes.c_int
    x11.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_long, ctypes.c_void_p]
    x11.XSendEvent.restype = ctypes.c_int
    x11.XGrabServer.argtypes = [ctypes.c_void_p]
    x11.XGrabServer.restype = ctypes.c_int
    x11.XUngrabServer.argtypes = [ctypes.c_void_p]
    x11.XUngrabServer.restype = ctypes.c_int
    x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    x11.XKeysymToKeycode.restype = ctypes.c_ubyte
    xtst.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
    xtst.XTestFakeMotionEvent.restype = ctypes.c_int
    xtst.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
    xtst.XTestFakeButtonEvent.restype = ctypes.c_int
    xtst.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
    xtst.XTestFakeKeyEvent.restype = ctypes.c_int
    xres = None
    xres_name = ctypes.util.find_library("XRes")
    if xres_name:
        try:
            xres = ctypes.CDLL(xres_name)
            xres.XResQueryClients.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.POINTER(XResClient))]
            xres.XResQueryClients.restype = ctypes.c_int
            if hasattr(xres, "XResQueryVersion"):
                xres.XResQueryVersion.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int)]
                xres.XResQueryVersion.restype = ctypes.c_int
                major = ctypes.c_int()
                minor = ctypes.c_int()
                if not xres.XResQueryVersion(display, ctypes.byref(major), ctypes.byref(minor)):
                    xres = None
        except (AttributeError, OSError):
            xres = None
    return x11, xtst, xres, display


class X11Recipient:
    def __init__(self):
        self.x11, self.xtst, self.xres, self.display = load_x11()
        self.screen = self.x11.XDefaultScreen(self.display)
        self.root = self.x11.XRootWindow(self.display, self.screen)
        self.screen_size = (self.x11.XDisplayWidth(self.display, self.screen), self.x11.XDisplayHeight(self.display, self.screen))
        if self.screen_size[0] <= 0 or self.screen_size[1] <= 0:
            self.close()
            fail("x11_recipient_screen_unavailable")
        self.atoms = {
            "active": self.x11.XInternAtom(self.display, b"_NET_ACTIVE_WINDOW", 0),
            "clients": self.x11.XInternAtom(self.display, b"_NET_CLIENT_LIST", 0),
            "pid": self.x11.XInternAtom(self.display, b"_NET_WM_PID", 0),
            "wm_class": self.x11.XInternAtom(self.display, b"WM_CLASS", 0),
            "state": self.x11.XInternAtom(self.display, b"_NET_WM_STATE", 0),
            "modal": self.x11.XInternAtom(self.display, b"_NET_WM_STATE_MODAL", 0),
            "window_type": self.x11.XInternAtom(self.display, b"_NET_WM_WINDOW_TYPE", 0),
            "dialog": self.x11.XInternAtom(self.display, b"_NET_WM_WINDOW_TYPE_DIALOG", 0),
            "transient": self.x11.XInternAtom(self.display, b"WM_TRANSIENT_FOR", 0),
            "atom": self.x11.XInternAtom(self.display, b"ATOM", 0),
            "cardinal": self.x11.XInternAtom(self.display, b"CARDINAL", 0),
            "window": self.x11.XInternAtom(self.display, b"WINDOW", 0),
            "clipboard": self.x11.XInternAtom(self.display, b"CLIPBOARD", 0),
            "targets": self.x11.XInternAtom(self.display, b"TARGETS", 0),
            "utf8": self.x11.XInternAtom(self.display, b"UTF8_STRING", 0),
            "text": self.x11.XInternAtom(self.display, b"TEXT", 0),
            "string": self.x11.XInternAtom(self.display, b"STRING", 0),
            "text_plain_utf8": self.x11.XInternAtom(self.display, b"text/plain;charset=utf-8", 0),
            "text_plain": self.x11.XInternAtom(self.display, b"text/plain", 0),
        }
        if not all(self.atoms.values()):
            self.close()
            fail("x11_recipient_atom_unavailable")

    def close(self):
        if getattr(self, "display", None):
            self.x11.XCloseDisplay(self.display)
            self.display = None

    def attributes(self, window):
        value = XWindowAttributes()
        if not self.x11.XGetWindowAttributes(self.display, window, ctypes.byref(value)):
            fail("x11_recipient_window_unavailable")
        if value.map_state != VIEWABLE:
            fail("x11_recipient_window_not_visible")
        return value

    def query_tree(self, window):
        root = ctypes.c_ulong()
        parent = ctypes.c_ulong()
        children = ctypes.POINTER(ctypes.c_ulong)()
        count = ctypes.c_uint()
        if not self.x11.XQueryTree(self.display, window, ctypes.byref(root), ctypes.byref(parent), ctypes.byref(children), ctypes.byref(count)):
            fail("x11_recipient_tree_unavailable")
        if count.value > MAX_TREE_NODES:
            if children:
                self.x11.XFree(children)
            fail("x11_recipient_tree_limit")
        result = [int(children[index]) for index in range(count.value)] if children else []
        if children:
            self.x11.XFree(children)
        return int(root.value), int(parent.value), result

    def ancestors(self, window):
        chain = []
        seen = set()
        current = window
        for _ in range(MAX_DEPTH):
            if current in seen or current == NONE_WINDOW:
                break
            seen.add(current)
            chain.append(current)
            root, parent, _ = self.query_tree(current)
            if current == self.root or parent == current or parent == NONE_WINDOW:
                break
            current = parent
        if not chain or chain[-1] != self.root:
            fail("x11_recipient_ancestry_unproven")
        return chain

    def property_bytes(self, window, atom, type_atom, length=8):
        actual_type = ctypes.c_ulong()
        actual_format = ctypes.c_int()
        count = ctypes.c_ulong()
        remaining = ctypes.c_ulong()
        data = ctypes.POINTER(ctypes.c_ubyte)()
        status = self.x11.XGetWindowProperty(self.display, window, atom, 0, length, 0, type_atom, ctypes.byref(actual_type), ctypes.byref(actual_format), ctypes.byref(count), ctypes.byref(remaining), ctypes.byref(data))
        if status != 0 or not data or count.value == 0:
            if data:
                self.x11.XFree(data)
            return None, actual_format.value, int(actual_type.value)
        byte_count = count.value * max(actual_format.value, 1) // 8
        if byte_count > 65_536:
            self.x11.XFree(data)
            fail("x11_recipient_property_limit")
        if actual_format.value == 32:
            # Xlib widens each 32-bit X property item to a native unsigned long.
            words = ctypes.cast(data, ctypes.POINTER(ctypes.c_ulong))
            value = b"".join((words[index] & 0xffffffff).to_bytes(4, sys.byteorder) for index in range(count.value))
        else:
            value = bytes(data[index] for index in range(byte_count))
        self.x11.XFree(data)
        return value, actual_format.value, int(actual_type.value)

    def numeric_property(self, window, atom, type_atom):
        value, fmt, actual_type = self.property_bytes(window, atom, type_atom, 1)
        if value is None or actual_type != type_atom or fmt != 32 or len(value) < 4:
            fail("x11_recipient_property_unproven")
        return int.from_bytes(value[:4], byteorder=sys.byteorder, signed=False)

    def word_property(self, window, atom, type_atom, length=MAX_TREE_NODES):
        value, fmt, actual_type = self.property_bytes(window, atom, type_atom, length)
        if value is None or actual_type != type_atom or fmt != 32 or len(value) % 4:
            fail("x11_recipient_property_unproven")
        return [int.from_bytes(value[offset:offset + 4], sys.byteorder) for offset in range(0, len(value), 4)]

    def optional_word_property(self, window, atom, type_atom, length=MAX_TREE_NODES):
        value, fmt, actual_type = self.property_bytes(window, atom, type_atom, length)
        if value is None:
            return []
        if actual_type != type_atom or fmt != 32 or len(value) % 4:
            fail("x11_recipient_property_unproven")
        return [int.from_bytes(value[offset:offset + 4], sys.byteorder) for offset in range(0, len(value), 4)]

    def optional_scalar_property(self, window, atom, type_atom):
        value, fmt, actual_type = self.property_bytes(window, atom, type_atom, 1)
        if value is None:
            return None
        if actual_type != type_atom or fmt != 32 or len(value) < 4:
            fail("x11_recipient_property_unproven")
        return int.from_bytes(value[:4], sys.byteorder)

    def identity(self, window):
        pid = self.numeric_property(window, self.atoms["pid"], self.atoms["cardinal"])
        raw, fmt, actual_type = self.property_bytes(window, self.atoms["wm_class"], 0, 256)
        if raw is None or actual_type == 0 or fmt != 8:
            fail("x11_recipient_class_unproven")
        classes = [item.decode("utf-8", "replace").lower() for item in raw.split(b"\0") if item]
        if not classes:
            fail("x11_recipient_class_unproven")
        return pid, classes

    def bounds(self, window):
        attributes = self.attributes(window)
        root = ctypes.c_ulong()
        x = ctypes.c_int()
        y = ctypes.c_int()
        width = ctypes.c_uint()
        height = ctypes.c_uint()
        border = ctypes.c_uint()
        depth = ctypes.c_uint()
        if not self.x11.XGetGeometry(self.display, window, ctypes.byref(root), ctypes.byref(x), ctypes.byref(y), ctypes.byref(width), ctypes.byref(height), ctypes.byref(border), ctypes.byref(depth)):
            fail("x11_recipient_geometry_unproven")
        absolute_x = ctypes.c_int()
        absolute_y = ctypes.c_int()
        child = ctypes.c_ulong()
        if not self.x11.XTranslateCoordinates(self.display, window, self.root, 0, 0, ctypes.byref(absolute_x), ctypes.byref(absolute_y), ctypes.byref(child)):
            fail("x11_recipient_geometry_unproven")
        if width.value == 0 or height.value == 0 or attributes.map_state != VIEWABLE:
            fail("x11_recipient_geometry_unproven")
        return {"x": absolute_x.value, "y": absolute_y.value, "width": int(width.value), "height": int(height.value)}

    def topmost_at(self, x, y):
        if x < 0 or y < 0 or x >= self.screen_size[0] or y >= self.screen_size[1]:
            fail("x11_recipient_point_out_of_screen")
        visited = set()

        def descend(window, depth):
            if depth > MAX_DEPTH or len(visited) >= MAX_TREE_NODES:
                fail("x11_recipient_tree_limit")
            if window in visited:
                return window
            visited.add(window)
            _, _, children = self.query_tree(window)
            for child in reversed(children):
                if child in visited:
                    continue
                try:
                    self.attributes(child)
                except RuntimeError as error:
                    # An unmapped child is not a candidate. Every other
                    # uncertainty, especially geometry/tree failure, must
                    # propagate instead of allowing a lower window through.
                    if str(error) == "x11_recipient_window_not_visible":
                        continue
                    raise
                local_x = ctypes.c_int()
                local_y = ctypes.c_int()
                child_window = ctypes.c_ulong()
                if not self.x11.XTranslateCoordinates(self.display, self.root, child, x, y, ctypes.byref(local_x), ctypes.byref(local_y), ctypes.byref(child_window)):
                    continue
                child_bounds = self.bounds(child)
                if 0 <= local_x.value < child_bounds["width"] and 0 <= local_y.value < child_bounds["height"]:
                    # Deliberately outside the ignorable-child block: a
                    # depth/tree limit or descendant proof failure is closed.
                    return descend(child, depth + 1)
            return window

        return descend(self.root, 0), visited

    def active_and_focus(self):
        active = self.numeric_property(self.root, self.atoms["active"], self.atoms["window"])
        focus = ctypes.c_ulong()
        revert = ctypes.c_int()
        if not self.x11.XGetInputFocus(self.display, ctypes.byref(focus), ctypes.byref(revert)):
            fail("x11_recipient_focus_unproven")
        focus_id = int(focus.value)
        if active in {NONE_WINDOW, POINTER_ROOT} or focus_id in {NONE_WINDOW, POINTER_ROOT}:
            fail("x11_recipient_focus_unproven")
        return active, focus_id

    def modal_blockers(self, window, pid, classes):
        clients = self.word_property(self.root, self.atoms["clients"], self.atoms["window"])
        if not clients:
            fail("x11_recipient_modal_unproven")
        owner_chain = set(self.ancestors(window))
        for client in clients:
            if client == window:
                continue
            try:
                self.attributes(client)
            except RuntimeError as error:
                if str(error) == "x11_recipient_window_not_visible":
                    continue
                raise
            try:
                transient = self.optional_scalar_property(client, self.atoms["transient"], self.atoms["window"])
            except RuntimeError:
                try:
                    candidate_pid, candidate_classes = self.identity(client)
                except RuntimeError:
                    continue
                if candidate_pid == pid and any(item == candidate or item in candidate or candidate in item for item in candidate_classes for candidate in classes):
                    fail("x11_recipient_modal_unproven")
                continue
            owned = modal_owned(transient, owner_chain, window)
            try:
                states = self.optional_word_property(client, self.atoms["state"], self.atoms["atom"])
                types = self.optional_word_property(client, self.atoms["window_type"], self.atoms["atom"])
            except RuntimeError:
                if owned:
                    fail("x11_recipient_modal_unproven")
                continue
            if self.atoms["modal"] not in states and self.atoms["dialog"] not in types:
                continue
            if owned:
                fail("x11_recipient_modal_blocked")
            if transient is None:
                try:
                    candidate_pid, candidate_classes = self.identity(client)
                except RuntimeError:
                    fail("x11_recipient_modal_unproven")
                if candidate_pid == pid and any(item == candidate or item in candidate or candidate in item for item in candidate_classes for candidate in classes):
                    fail("x11_recipient_modal_unproven")
        return True

    def keyboard_focus(self, request):
        window = request["window_id"]
        pid, classes = self.identity(window)
        if pid != request["process_id"]:
            fail("x11_recipient_pid_mismatch")
        application = request["application"]
        if not any(application == item or application in item or item in application for item in classes):
            fail("x11_recipient_application_mismatch")
        active, focus = self.active_and_focus()
        window_chain = self.ancestors(window)
        active_chain = self.ancestors(active)
        focus_chain = self.ancestors(focus)
        if active not in window_chain and window not in active_chain:
            fail("x11_recipient_window_not_active")
        if window not in focus_chain:
            fail("x11_recipient_focus_foreign")
        clients, fmt, prop_type = self.property_bytes(self.root, self.atoms["clients"], self.atoms["window"], MAX_TREE_NODES)
        if not clients or fmt != 32 or prop_type != self.atoms["window"]:
            fail("x11_recipient_focus_unproven")
        managed = {int.from_bytes(clients[offset:offset + 4], sys.byteorder) for offset in range(0, len(clients), 4)}
        # On a reparenting WM the root's immediate child is often a decoration.
        # The closest EWMH-managed client is the actual keyboard recipient.
        focused_top = next((candidate for candidate in focus_chain if candidate in managed), None)
        if focused_top != window:
            fail("x11_recipient_foreign_modal")
        focused_pid, focused_classes = self.identity(focused_top)
        if not keyboard_focus_owned(focused_pid, focused_classes, pid, application):
            fail("x11_recipient_foreign_modal")
        self.modal_blockers(window, pid, classes)
        return {"window_id": str(window), "process_id": pid, "active_window_id": str(active), "focus_window_id": str(focus), "focused_top_level_id": str(focused_top)}

    def xres_client(self, window):
        if self.xres is None:
            return None
        count = ctypes.c_int()
        clients = ctypes.POINTER(XResClient)()
        try:
            if self.xres.XResQueryClients(self.display, ctypes.byref(count), ctypes.byref(clients)) and 0 < count.value <= MAX_TREE_NODES:
                for index in range(count.value):
                    client = clients[index]
                    if (window & ~client.resource_mask) == client.resource_base:
                        return int(client.resource_base)
        finally:
            if clients:
                self.x11.XFree(clients)
        return None

    def selection_requestor_allowed(self, requestor, request):
        chain = self.ancestors(requestor)
        window = request["window_id"]
        pid, classes = self.identity(window)
        if pid != request["process_id"]:
            return False
        application = request["application"]
        if not any(application == item or application in item or item in application for item in classes):
            return False
        if window in chain:
            return True
        owner = self.xres_client(window)
        requestor_owner = self.xres_client(requestor)
        return owner is not None and owner == requestor_owner

    def selection_notify(self, requestor, selection, target, property_atom, timestamp):
        event = XSelectionEvent()
        event.type = 31
        event.send_event = 1
        event.display = self.display
        event.requestor = requestor
        event.selection = selection
        event.target = target
        event.property = property_atom
        event.time = timestamp
        if not self.x11.XSendEvent(self.display, requestor, 0, 0, ctypes.byref(event)):
            fail("x11_recipient_selection_notify_failed")

    def selection_property(self, requestor, property_atom, target, text):
        if target == self.atoms["targets"]:
            targets = (self.atoms["targets"], self.atoms["utf8"], self.atoms["text"], self.atoms["text_plain_utf8"], self.atoms["text_plain"])
            values = (ctypes.c_ulong * len(targets))(*targets)
            self.x11.XChangeProperty(self.display, requestor, property_atom, self.atoms["atom"], 32, 0, ctypes.cast(values, ctypes.c_void_p), len(targets))
            return True
        if target not in {self.atoms["utf8"], self.atoms["text"], self.atoms["text_plain_utf8"], self.atoms["text_plain"]}:
            return False
        encoded = text.encode("utf-8")
        buffer = ctypes.create_string_buffer(encoded)
        response_type = self.atoms["utf8"] if target == self.atoms["text"] else target
        self.x11.XChangeProperty(self.display, requestor, property_atom, response_type, 8, 0, ctypes.cast(buffer, ctypes.c_void_p), len(encoded))
        return True

    def selection_type_text(self, request):
        self.keyboard_focus(request)
        clipboard = self.atoms["clipboard"]
        owner = int(self.x11.XCreateSimpleWindow(self.display, self.root, 0, 0, 1, 1, 0, 0, 0))
        if owner == NONE_WINDOW:
            fail("x11_recipient_clipboard_owner_failed")
        control_key = int(self.x11.XKeysymToKeycode(self.display, 0xFFE3))
        paste_key = int(self.x11.XKeysymToKeycode(self.display, ord("v")))
        if control_key == 0 or paste_key == 0:
            self.x11.XDestroyWindow(self.display, owner)
            fail("x11_recipient_paste_key_unavailable")
        claimed = False
        control_down = False
        paste_down = False
        delivered = False
        try:
            self.x11.XGrabServer(self.display)
            try:
                old_owner = int(self.x11.XGetSelectionOwner(self.display, clipboard))
                if old_owner != NONE_WINDOW:
                    fail("x11_recipient_clipboard_busy")
                self.x11.XSetSelectionOwner(self.display, clipboard, owner, 0)
                if int(self.x11.XGetSelectionOwner(self.display, clipboard)) != owner:
                    fail("x11_recipient_clipboard_owner_failed")
            finally:
                self.x11.XUngrabServer(self.display)
                self.x11.XFlush(self.display)
            claimed = True
            if not self.xtst.XTestFakeKeyEvent(self.display, control_key, 1, 0):
                fail("x11_recipient_paste_failed")
            control_down = True
            if not self.xtst.XTestFakeKeyEvent(self.display, paste_key, 1, 0):
                fail("x11_recipient_paste_failed")
            paste_down = True
            if not self.xtst.XTestFakeKeyEvent(self.display, paste_key, 0, 0):
                fail("x11_recipient_paste_failed")
            paste_down = False
            if not self.xtst.XTestFakeKeyEvent(self.display, control_key, 0, 0):
                fail("x11_recipient_paste_failed")
            control_down = False
            self.x11.XFlush(self.display)
            deadline = time.monotonic() + 1.0
            event_buffer = ctypes.create_string_buffer(256)
            while time.monotonic() < deadline and not delivered:
                while self.x11.XPending(self.display):
                    self.x11.XNextEvent(self.display, ctypes.byref(event_buffer))
                    event = ctypes.cast(event_buffer, ctypes.POINTER(XSelectionRequestEvent)).contents
                    if event.type == SELECTION_CLEAR:
                        fail("x11_recipient_selection_lost")
                    if event.type != SELECTION_REQUEST or event.selection != clipboard:
                        continue
                    requestor = int(event.requestor)
                    property_atom = int(event.property) or int(event.target)
                    if property_atom == NONE_WINDOW:
                        self.selection_notify(requestor, clipboard, int(event.target), NONE_WINDOW, int(event.time))
                        continue
                    allowed = self.selection_requestor_allowed(requestor, request)
                    if int(event.target) == self.atoms["targets"]:
                        self.selection_property(requestor, property_atom, int(event.target), request["text"])
                        self.selection_notify(requestor, clipboard, int(event.target), property_atom, int(event.time))
                        continue
                    if not allowed or int(event.target) not in {self.atoms["utf8"], self.atoms["text"], self.atoms["text_plain_utf8"], self.atoms["text_plain"]}:
                        self.selection_notify(requestor, clipboard, int(event.target), NONE_WINDOW, int(event.time))
                        continue
                    if not self.selection_property(requestor, property_atom, int(event.target), request["text"]):
                        self.selection_notify(requestor, clipboard, int(event.target), NONE_WINDOW, int(event.time))
                        continue
                    self.selection_notify(requestor, clipboard, int(event.target), property_atom, int(event.time))
                    delivered = True
                    break
                if not delivered:
                    time.sleep(0.005)
            if not delivered:
                fail("x11_recipient_injection_unconfirmed")
            return {"delivered": True}
        finally:
            if paste_down:
                self.xtst.XTestFakeKeyEvent(self.display, paste_key, 0, 0)
            if control_down:
                self.xtst.XTestFakeKeyEvent(self.display, control_key, 0, 0)
            self.x11.XFlush(self.display)
            if claimed and int(self.x11.XGetSelectionOwner(self.display, clipboard)) == owner:
                self.x11.XSetSelectionOwner(self.display, clipboard, NONE_WINDOW, 0)
            self.x11.XDestroyWindow(self.display, owner)
            self.x11.XFlush(self.display)

    def verify(self, request):
        window = request["window_id"]
        pid, classes = self.identity(window)
        if pid != request["process_id"]:
            fail("x11_recipient_pid_mismatch")
        application = request["application"]
        if not any(application == item or application in item or item in application for item in classes):
            fail("x11_recipient_application_mismatch")
        bounds = self.bounds(window)
        x, y = request["point"]
        if not (bounds["x"] <= x < bounds["x"] + bounds["width"] and bounds["y"] <= y < bounds["y"] + bounds["height"]):
            fail("x11_recipient_point_outside_window")
        active, focus = self.active_and_focus()
        window_chain = self.ancestors(window)
        active_chain = self.ancestors(active)
        focus_chain = self.ancestors(focus)
        if active not in window_chain and window not in active_chain:
            fail("x11_recipient_window_not_active")
        if window not in focus_chain:
            fail("x11_recipient_focus_foreign")
        topmost, top_chain = self.topmost_at(x, y)
        if not topmost_owned(topmost, self.ancestors(topmost), window):
            fail("x11_recipient_point_occluded")
        return {"window_id": str(window), "process_id": pid, "screen": {"width": self.screen_size[0], "height": self.screen_size[1]}, "bounds": bounds, "active_window_id": str(active), "focus_window_id": str(focus), "topmost_window_id": str(topmost), "topmost_chain": [str(item) for item in top_chain]}

    def pointer_dispatch(self, request):
        """Verify and deliver one bounded pointer transaction atomically.

        The server grab keeps the authorized recipient, pointer position, and
        topmost-window proof stable while XTest queues motion plus click or
        wheel events. Any attempted physical event whose completion cannot be
        established is deliberately reported as unknown.
        """
        grabbed = False
        event_attempted = False
        button_down = False
        button = 1 if request["op"] == "click" else (4 if request["direction"] == "up" else 5)
        try:
            self.x11.XGrabServer(self.display)
            grabbed = True
            self.modal_blockers(request["window_id"], request["process_id"], self.identity(request["window_id"])[1])
            self.verify(request)
            x, y = request["point"]
            if not self.xtst.XTestFakeMotionEvent(self.display, self.screen, x, y, 0):
                fail("x11_recipient_motion_failed")
            self.x11.XSync(self.display, 0)
            proof = self.verify(request)
            count = 1 if request["op"] == "click" else request["amount"]
            for _ in range(count):
                event_attempted = True
                if not self.xtst.XTestFakeButtonEvent(self.display, button, 1, 0):
                    fail("x11_recipient_click_failed" if request["op"] == "click" else "x11_recipient_scroll_failed")
                button_down = True
                if not self.xtst.XTestFakeButtonEvent(self.display, button, 0, 0):
                    fail("x11_recipient_click_failed" if request["op"] == "click" else "x11_recipient_scroll_failed")
                button_down = False
            self.x11.XSync(self.display, 0)
            return {
                **proof,
                ("clicked" if request["op"] == "click" else "scrolled"): True,
                **({} if request["op"] == "click" else {"direction": request["direction"], "amount": request["amount"]}),
            }
        except RuntimeError:
            if event_attempted:
                fail("x11_recipient_delivery_unknown")
            raise
        finally:
            if button_down:
                try:
                    self.xtst.XTestFakeButtonEvent(self.display, button, 0, 0)
                except Exception:
                    pass
            try:
                self.x11.XFlush(self.display)
            finally:
                if grabbed:
                    self.x11.XUngrabServer(self.display)
                    self.x11.XFlush(self.display)

    def click(self, request):
        return self.pointer_dispatch(request)

    def scroll(self, request):
        return self.pointer_dispatch(request)


def self_test():
    own = ["400", "100"]
    foreign = ["900", "700"]
    assert topmost_owned(100, own, 100)
    assert not topmost_owned(900, foreign, 100)
    try:
        topmost_owned(900, ["900"] * (MAX_DEPTH + 1), 100)
    except RuntimeError as error:
        assert str(error) == "x11_recipient_tree_limit"
    else:
        raise AssertionError("deep_overlay_must_refuse")
    assert keyboard_focus_owned(123, ["chrome"], 123, "chrome")
    assert not keyboard_focus_owned(777, ["other-modal"], 123, "chrome")
    assert modal_owned(900, [900, 100], 100)
    assert not modal_owned(900, [700, 600], 100)
    try:
        safe_request({"op": "type_text", "window_id": "100", "process_id": 123, "application": "chrome", "text": "x" * (MAX_TYPE_TEXT + 1)})
    except RuntimeError as error:
        assert str(error) == "x11_recipient_text_invalid"
    else:
        raise AssertionError("type_text_bound_must_refuse")
    scroll = safe_request({"op": "scroll", "window_id": "100", "process_id": 123, "application": "chrome", "point": {"x": 10, "y": 20}, "direction": "down", "amount": MAX_SCROLL_AMOUNT})
    assert scroll["amount"] == MAX_SCROLL_AMOUNT
    try:
        # Re-encode the normalized integer window ID as the JSON wire string
        # accepted by safe_request before testing the amount bound.
        safe_request({**scroll, "window_id": str(scroll["window_id"]), "amount": MAX_SCROLL_AMOUNT + 1})
    except RuntimeError as error:
        assert str(error) == "x11_recipient_scroll_amount_invalid"
    else:
        raise AssertionError("scroll_bound_must_refuse")
    return {"ok": True, "foreign_overlay_refused": True, "overlay_depth_refused": True, "foreign_modal_refused": True, "type_text_bounded": True}


def topmost_owned(topmost, ancestry, authorized):
    """Pure ownership gate shared by the X11 proof and its no-display test."""
    if len(ancestry) > MAX_DEPTH:
        fail("x11_recipient_tree_limit")
    return topmost == authorized or authorized in ancestry


def keyboard_focus_owned(focused_pid, focused_classes, authorized_pid, application):
    return focused_pid == authorized_pid and any(application == item or application in item or item in application for item in focused_classes)


def modal_owned(transient, owner_chain, authorized):
    return transient is not None and (transient == authorized or transient in owner_chain)


def main():
    if len(sys.argv) == 2 and sys.argv[1] == "--self-test":
        print(json.dumps(self_test()), flush=True)
        return
    try:
        line = sys.stdin.readline(16_385)
        if len(line) > 16_384 or (len(line) == 16_384 and not line.endswith("\n")):
            fail("x11_recipient_request_too_large")
        raw = json.loads(line)
        request = safe_request(raw)
        recipient = X11Recipient()
        try:
            if request["op"] == "click":
                result = recipient.click(request)
            elif request["op"] == "scroll":
                result = recipient.scroll(request)
            elif request["op"] == "keyboard_focus":
                result = recipient.keyboard_focus(request)
            elif request["op"] == "type_text":
                result = recipient.selection_type_text(request)
            else:
                result = recipient.verify(request)
            print(json.dumps({"ok": True, "op": request["op"], **result}, separators=(",", ":")), flush=True)
        finally:
            recipient.close()
    except Exception as error:
        code = str(error)[:128] or "x11_recipient_failed"
        print(json.dumps({"ok": False, "code": code}, separators=(",", ":")), flush=True)


if __name__ == "__main__":
    main()
