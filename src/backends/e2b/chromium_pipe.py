"""Private bridge for the host's Chromium instance in an existing E2B guest."""
import base64
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading


def main():
    browser = next((p for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser")
                    if (p := shutil.which(name))), None)
    if browser is None:
        return 2
    # Chrome reads CDP on fd 3 and writes on fd 4. It never listens on a TCP port.
    redirect = 'exec "$@" 3<&0 4>&1 </dev/null >/dev/null 2>/dev/null'
    limit = 24 * 1024 * 1024
    with tempfile.TemporaryDirectory(prefix="desklatch-chrome-") as profile:
        args = [browser, "--remote-debugging-pipe", "--user-data-dir=" + profile, "--no-first-run",
                "--no-default-browser-check", "--disable-extensions", "--disable-sync",
                "--disable-background-networking", "--disable-dev-shm-usage", "--window-size=1280,800"]
        if sys.argv[1:] == ["--headless"]:
            args.append("--headless=new")
        proc = subprocess.Popen(["/bin/sh", "-c", redirect, "desklatch"] + args + ["about:blank"],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, start_new_session=True)

        def stop(*_):
            if proc.poll() is None:
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass

        def forward_input():
            try:
                while line := sys.stdin.buffer.readline(limit + 1):
                    if len(line) > limit or not line.endswith(b"\n") or b"\0" in line:
                        break
                    proc.stdin.write(line[:-1] + b"\0")
                    proc.stdin.flush()
            except (OSError, ValueError):
                pass
            finally:
                stop()

        signal.signal(signal.SIGTERM, stop)
        threading.Thread(target=forward_input, daemon=True).start()
        try:
            pending = bytearray()
            while chunk := os.read(proc.stdout.fileno(), 65536):
                pending.extend(chunk)
                while (end := pending.find(b"\0")) >= 0:
                    if end > limit:
                        return 3
                    sys.stdout.buffer.write(base64.b64encode(pending[:end]) + b"\n")
                    sys.stdout.buffer.flush()
                    del pending[:end+1]
                if len(pending) > limit:
                    return 3
        finally:
            stop()
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
        return 0


if __name__ == "__main__":
    sys.exit(main())
