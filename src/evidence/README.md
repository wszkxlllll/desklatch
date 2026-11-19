# Execution-side evidence

DeskLatch core does not install an OCR dependency, model files, or an uploader.
`createLocalPpOcrV5Mobile` is a host adapter: the host must already have
RapidOCR configured for local CPU PP-OCRv5 mobile ONNX models and inject a
runner (and, when needed, a `getImage` callback for a host-local image/crop).
Model paths are checked for local-looking model files, runtime downloads are
rejected, and the adapter is lazy. The risk policy calls it only when
structural evidence is insufficient and a bounded region is available.

`createRapidOcrCpuRunner` is the concrete optional bridge. It launches the
bundled `rapidocr_worker.py` with a host-supplied Python executable and sends
one JSON request over stdin. Detection, recognition, dictionary, and optional
classifier paths must be existing absolute local files; image bytes are sent
only over stdin and never appear in argv or logs. The worker supports the
merged `rapidocr` API and the legacy `rapidocr_onnxruntime` API, always with
explicit PP-OCRv5/mobile/ONNX parameters and no model-download path. Missing
Python, RapidOCR, models, or a compatible API returns a typed status/error.
For modern RapidOCR (including 3.10), the worker supplies the package's enum
values rather than YAML strings. Its JSON wire output uses ASCII escapes so
Chinese OCR text remains safe on Windows cp1252 stdout and is restored by the
Node parser.

The OCR result is text evidence only. It is never sent to the reviewer as an
image, and OCR cannot authorize an action. A missing, failed, or low-confidence
result keeps the action at approval/stop rather than silently allowing it.

`LocalEvidenceSink` is opt-in and execution-side only. It requires an explicit
private store and a redactor. The raw image is copied for in-memory redaction;
the store receives only output marked `redacted: true`. There is no egress API.
`FilePrivateEvidenceStore` requires the caller to provide an already-existing,
private, ACL-protected directory; it never creates a new root or chooses a
shared/global path. Writes are atomic, IDs are generated, and count/size/age
retention is bounded. On Windows, `chmod(0700)` cannot enforce a DACL, so the
host must set and verify the directory ACL before constructing the store. On
POSIX it is applied as a best-effort mode tightening. `EvidenceCapturingBackend` can
wrap a `DesktopBackend`; a required `localOnly` capture policy approves each
before/after capture, and only the private sink receives pixels. A pre-capture
uses `request.frame.image` when already present; otherwise the host must supply
the independent `captureImage` hook. That hook never changes the prepared
dispatch frame or target binding, and the wrapper never calls `backend.observe`
between validation and dispatch. After-dispatch archival failures are reported
through `onDiagnostic` while preserving the backend's known delivery. Ordinary
observe/act calls and all provider/reviewer paths remain image-free unless the
host explicitly enables local capture.
