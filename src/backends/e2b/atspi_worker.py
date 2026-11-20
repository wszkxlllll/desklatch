"""Fixed, bounded AT-SPI snapshot worker for the E2B desktop backend.

The parent process sends one JSON observe request on stdin. This worker never
accepts a shell command, path, or executable code from that request. It emits a
small JSON snapshot and exits; keyboard and pointer delivery remains in the
host-owned E2B SDK surface.
"""

import json
import os
import shutil
import subprocess
import sys


MAX_WINDOWS = 16
MAX_ELEMENTS = 512
MAX_NAME = 512
MAX_DEPTH = 32
MAX_TREE_NODES = 4096


def safe_text(value, limit=MAX_NAME):
    if not isinstance(value, str) or len(value) > limit or any(ord(ch) < 0x20 and ch not in "\t\n\r" for ch in value):
        return None
    return value


def rect_for(accessible):
    try:
        component = accessible.queryComponent()
        extents = component.getExtents(0)  # Atspi.XY_SCREEN is zero in pyatspi.
        values = (int(extents.x), int(extents.y), int(extents.width), int(extents.height))
        if values[2] <= 0 or values[3] <= 0:
            return None
        return {"x": values[0], "y": values[1], "width": values[2], "height": values[3]}
    except Exception:
        return None


def role_name(accessible):
    try:
        return safe_text(accessible.getRoleName(), 128) or "Unknown"
    except Exception:
        return "Unknown"


def state_names(accessible):
    result = []
    try:
        state = accessible.getState()
        mapping = (
            ("visible", "STATE_VISIBLE"),
            ("enabled", "STATE_ENABLED"),
            ("focused", "STATE_FOCUSED"),
            ("checked", "STATE_CHECKED"),
            ("selected", "STATE_SELECTED"),
            ("editable", "STATE_EDITABLE"),
        )
        import pyatspi

        for name, constant in mapping:
            value = getattr(pyatspi, constant, None)
            if value is not None and state.contains(value):
                result.append(name)
    except Exception:
        pass
    return result


def actions_for(accessible):
    actions = []
    try:
        query = accessible.queryAction()
        for index in range(min(int(query.nActions), 16)):
            name = safe_text(query.getName(index), 64)
            if name:
                actions.append(name)
    except Exception:
        pass
    return actions


def value_for(accessible, role, states):
    # Values are deliberately limited to editor-like roles. Passwords and
    # arbitrary application values never enter the model surface.
    if role.lower().replace(" ", "") not in {"document", "text", "textbox", "textfield", "edit", "editor", "paragraph"}:
        return None
    if "editable" not in states:
        return None
    try:
        text = accessible.queryText()
        value = text.getText(0, min(int(text.characterCount), 16384))
        return safe_text(value, 16384)
    except Exception:
        return None


def x11_window_bounds(window_id):
    if not isinstance(window_id, str) or not window_id.isdigit() or shutil.which("xdotool") is None:
        return None
    try:
        result = subprocess.run(
            ["xdotool", "getwindowgeometry", "--shell", window_id],
            check=False,
            capture_output=True,
            text=True,
            timeout=2,
        )
        values = {}
        for line in result.stdout.splitlines():
            key, _, value = line.partition("=")
            if key in {"X", "Y", "WIDTH", "HEIGHT"} and value.isdigit():
                values[key] = int(value)
        if values.get("WIDTH", 0) > 0 and values.get("HEIGHT", 0) > 0:
            return {"x": values.get("X", 0), "y": values.get("Y", 0), "width": values["WIDTH"], "height": values["HEIGHT"]}
    except Exception:
        pass
    return None


def x11_window_identity(window_id):
    """Read only the X11 identity facts needed to bind a grant."""
    if not isinstance(window_id, str) or not window_id.isdigit() or shutil.which("xprop") is None:
        return None, None
    try:
        result = subprocess.run(
            ["xprop", "-id", window_id, "_NET_WM_PID", "WM_CLASS"],
            check=False,
            capture_output=True,
            text=True,
            timeout=2,
        )
        pid = None
        app_class = None
        for line in result.stdout.splitlines():
            if "_NET_WM_PID" in line:
                value = line.split("=", 1)[-1].strip()
                if value.isdigit():
                    pid = int(value)
            elif "WM_CLASS" in line:
                value = line.split("=", 1)[-1].strip()
                app_class = safe_text(value.strip('"').split(",")[-1].strip('"'), 128)
        return pid, app_class
    except Exception:
        return None, None


def accessible_identity(accessible):
    pid = None
    xwindow = None
    try:
        value = accessible.get_process_id()
        if isinstance(value, int) and value > 0:
            pid = value
    except Exception:
        pass
    try:
        window = None
        for name in ("queryWindow", "get_window", "getWindow"):
            method = getattr(accessible, name, None)
            if method is not None:
                window = method()
                if window is not None:
                    break
        if window is not None:
            for name in ("getXwindow", "get_xwindow", "getWindowId", "get_window_id"):
                method = getattr(window, name, None)
                if method is not None:
                    value = method()
                    if isinstance(value, int) and value > 0:
                        xwindow = str(value)
                        break
                    if isinstance(value, str) and value.isdigit() and int(value) > 0:
                        xwindow = str(int(value))
                        break
    except Exception:
        pass
    return pid, xwindow


def snapshot_accessible(root, window_id, max_elements):
    controls = []
    stack = [(root, "0", 0)]
    while stack and len(controls) < max_elements:
        accessible, path, depth = stack.pop()
        role = role_name(accessible)
        name = safe_text(getattr(accessible, "name", None))
        states = state_names(accessible)
        actions = actions_for(accessible)
        editable = "editable" in states
        item = {
            "id": path,
            "token": path,
            "role": role,
            "states": states,
            "actions": actions,
            "editable": editable,
        }
        if name:
            item["name"] = name
        bounds = rect_for(accessible)
        if bounds:
            item["rect"] = bounds
        value = value_for(accessible, role, states)
        if value is not None:
            item["value"] = value
        controls.append(item)
        try:
            count = min(int(accessible.childCount), 128)
            for index in range(count - 1, -1, -1):
                child = accessible.getChildAtIndex(index)
                if child is not None:
                    stack.append((child, f"{path}.{index}", depth + 1))
        except Exception:
            continue
    return controls, not stack


def find_root(candidates, grant):
    expected_pid = grant.get("process_id") if isinstance(grant, dict) else None
    expected_window_id = grant.get("window_id") if isinstance(grant, dict) else None
    matches = []
    for candidate in candidates:
        try:
            title = safe_text(getattr(candidate, "name", None))
            role = role_name(candidate).lower()
            if role not in {"frame", "window", "dialog"}:
                continue
            pid, xwindow = accessible_identity(candidate)
            if expected_pid is None or pid != expected_pid:
                continue
            if expected_window_id is None or xwindow != expected_window_id:
                continue
            matches.append((candidate, title, pid, xwindow))
        except Exception:
            continue
    if len(matches) != 1:
        return None, None, None, None
    return matches[0]


def top_level_accessibles():
    """Enumerate actual frame/window nodes below bounded AT-SPI applications.

    Registry desktop children are application roots, not necessarily the
    top-level X11 frames. Walk each application subtree and retain only
    frame/window/dialog roles; identity is checked later using PID and XID.
    """
    import pyatspi

    desktop = pyatspi.Registry.getDesktop(0)
    result = []
    stack = []
    try:
        application_count = min(int(desktop.childCount), MAX_WINDOWS * 4)
        for index in range(application_count - 1, -1, -1):
            application = desktop.getChildAtIndex(index)
            if application is not None:
                stack.append((application, 0))
    except Exception:
        return result
    visited = 0
    while stack and visited < MAX_TREE_NODES:
        accessible, depth = stack.pop()
        visited += 1
        role = role_name(accessible).lower()
        if role in {"frame", "window", "dialog"}:
            result.append(accessible)
        if depth >= MAX_DEPTH:
            continue
        try:
            count = min(int(accessible.childCount), 256)
            for index in range(count - 1, -1, -1):
                child = accessible.getChildAtIndex(index)
                if child is not None:
                    stack.append((child, depth + 1))
        except Exception:
            continue
    return result


def main():
    try:
        request = json.load(sys.stdin)
        if not isinstance(request, dict) or request.get("op") != "observe":
            raise ValueError("e2b_desktop_worker_request_invalid")
        windows = request.get("windows")
        max_elements = request.get("max_elements", MAX_ELEMENTS)
        if not isinstance(windows, list) or not windows or len(windows) > MAX_WINDOWS:
            raise ValueError("e2b_desktop_worker_request_invalid")
        if not isinstance(max_elements, int) or max_elements < 1 or max_elements > MAX_ELEMENTS:
            raise ValueError("e2b_desktop_worker_request_invalid")
        import pyatspi  # noqa: F401

        candidates = top_level_accessibles()
        output = []
        complete = True
        for grant in windows:
            if not isinstance(grant, dict) or not isinstance(grant.get("window_id"), str) or not grant["window_id"].isdigit():
                complete = False
                continue
            x11_pid, app_class = x11_window_identity(grant["window_id"])
            expected_pid = grant.get("process_id")
            expected_application = grant.get("application")
            app_match = isinstance(app_class, str) and isinstance(expected_application, str) and (
                expected_application.lower() in app_class.lower() or app_class.lower() in expected_application.lower()
            )
            if x11_pid is None or not app_match or expected_pid is None or x11_pid != expected_pid:
                complete = False
                continue
            root, title, atspi_pid, atspi_window_id = find_root(candidates, grant)
            if root is None:
                complete = False
                continue
            if atspi_pid is None or atspi_pid != x11_pid or atspi_window_id != grant["window_id"]:
                complete = False
                continue
            controls, controls_complete = snapshot_accessible(root, grant["window_id"], max_elements)
            complete = complete and controls_complete
            output.append({
                "window_id": grant["window_id"],
                "title": title,
                "process_id": x11_pid,
                "app_class": app_class,
                "bounds": x11_window_bounds(grant["window_id"]),
                "controls": controls,
                "complete": controls_complete,
            })
        if len(output) != len(windows):
            print(json.dumps({"ok": False, "code": "e2b_atspi_unavailable", "reason": "window_unbound"}), flush=True)
        else:
            print(json.dumps({"ok": True, "windows": output, "complete": complete}, ensure_ascii=False), flush=True)
    except ImportError:
        print(json.dumps({"ok": False, "code": "e2b_atspi_unavailable"}), flush=True)
    except Exception as error:
        code = str(error)[:96] or "e2b_atspi_failed"
        print(json.dumps({"ok": False, "code": code}), flush=True)


if __name__ == "__main__":
    main()
