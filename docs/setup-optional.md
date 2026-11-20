# Optional OCR and E2B setup

OCR and E2B are opt-in. The core DeskLatch install does not install Python,
RapidOCR, ONNX Runtime, `@e2b/desktop`, or any model files. DSH and MCP are
separate connection choices; selecting one does not install or configure the
other.

## Choose DSH or MCP

Run these commands from the consumer project directory. Install the core
tarball there first, then start the interactive chooser for both optional
features. Each feature offers `install`, `existing`, and `skip` (the default).

```sh
npm install --omit=optional /path/to/desklatch-0.1.0-dev.0.tgz
npm exec -- desklatch-setup
```

For MCP:

```sh
npm exec -- desklatch-setup mcp --install
npm exec -- desklatch-setup mcp --install --install-e2b --install-ocr
```

For the native DSH plugin, pass the plugin bundle explicitly. Optional checks
are independent of the DSH bundle:

```sh
npm exec -- desklatch-setup dsh --bundle path/to/desklatch-dsh.tgz
npm exec -- desklatch-setup dsh --bundle path/to/desklatch-dsh.tgz --install-e2b --install-ocr
```

The optional configuration is for the host that owns the desktop session.
The packaged starter plugin and generated MCP demo still use an isolated local
browser. The DSH bundle is installed separately with the official DSH command.
[Connection setup](integrations.md)

## Local OCR

### Automatic project-local install

Installation is explicit and stays under `.desklatch/ocr` in the consumer
project. It creates or reuses `.desklatch/ocr/.venv`, installs pinned CPU
packages into that venv only, downloads the three official assets below with
SHA-256 verification, and writes `.desklatch/ocr/ocr.json`.

```sh
npm exec -- desklatch-setup mcp --install-ocr
npm exec -- desklatch-setup mcp --install-ocr --python python
npm exec -- desklatch-setup dsh --bundle path/to/desklatch-dsh.tgz --install-ocr
```

The installer uses `py -3` or `python` on Windows and `python3` (then
`python`) on macOS/Linux when `--python` is omitted. It never runs a global
`pip install`. To use an existing base interpreter, pass it with `--python`;
the returned `pythonExecutable` still points at the project-local venv.

### Manual venv commands

Use the venv interpreter for every pip command. The pinned pair used by the
installer is RapidOCR `3.10.0` with CPU ONNX Runtime `1.23.2`.

Windows PowerShell:

```powershell
py -3 -m venv .desklatch\ocr\.venv
.desklatch\ocr\.venv\Scripts\python.exe -m pip install --disable-pip-version-check --no-input "rapidocr==3.10.0" "onnxruntime==1.23.2"
```

Windows Command Prompt:

```bat
py -3 -m venv .desklatch\ocr\.venv
.desklatch\ocr\.venv\Scripts\python.exe -m pip install --disable-pip-version-check --no-input "rapidocr==3.10.0" "onnxruntime==1.23.2"
```

macOS or Linux:

```sh
python3 -m venv .desklatch/ocr/.venv
.desklatch/ocr/.venv/bin/python -m pip install --disable-pip-version-check --no-input 'rapidocr==3.10.0' 'onnxruntime==1.23.2'
```

### Official PP-OCRv5 Mobile assets

These are the ONNX detector and recognizer routes in RapidAI's official
RapidOCR `v3.10.0` [`default_models.yaml`](https://github.com/RapidAI/RapidOCR/blob/v3.10.0/python/rapidocr/default_models.yaml).
The dictionary is the matching `paddle/PP-OCRv5/rec/ch_PP-OCRv5_rec_mobile`
asset referenced by that registry.

| File | Official download | SHA-256 |
| --- | --- | --- |
| `ch_PP-OCRv5_det_mobile.onnx` | [`ModelScope`](https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv5/det/ch_PP-OCRv5_det_mobile.onnx) | `4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae` |
| `ch_PP-OCRv5_rec_mobile.onnx` | [`ModelScope`](https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv5/rec/ch_PP-OCRv5_rec_mobile.onnx) | `5825fc7ebf84ae7a412be049820b4d86d77620f204a041697b0494669b1742c5` |
| `ppocrv5_dict.txt` | [`ModelScope matching dictionary`](https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/paddle/PP-OCRv5/rec/ch_PP-OCRv5_rec_mobile/ppocrv5_dict.txt) | `d1979e9f794c464c0d2e0b70a7fe14dd978e9dc644c0e71f14158cdf8342af1b` |

The first two hashes are the values in RapidAI's v3.10.0 registry. The
dictionary hash was computed from the matching official ModelScope download
and is pinned by the installer. If a downloaded byte stream has a different
hash, do not use it. A classifier model is optional; omitting it leaves
orientation classification disabled.

### `ocr.json`

The setup checker accepts this shape. Keep paths local and absolute.

```json
{
  "pythonExecutable": "C:/my-project/.desklatch/ocr/.venv/Scripts/python.exe",
  "detectorModelPath": "C:/my-project/.desklatch/ocr/models/ch_PP-OCRv5_det_mobile.onnx",
  "recognizerModelPath": "C:/my-project/.desklatch/ocr/models/ch_PP-OCRv5_rec_mobile.onnx",
  "dictionaryPath": "C:/my-project/.desklatch/ocr/models/ppocrv5_dict.txt"
}
```

Validate a manually prepared environment with:

```sh
npm exec -- desklatch-setup mcp --ocr path/to/ocr.json
```

The probe loads the real local worker and model files. In a host integration,
pass the parsed JSON to `createRapidOcrCpuRunner` and use its recognition
function for the host's risk evidence policy. [OCR evidence integration](../src/evidence/README.md)

## E2B

Create an E2B account and copy an API key from the Dashboard as described in
the [official E2B quickstart](https://docs.e2b.dev/quickstart/). Install the
optional SDK in the consumer project through the setup route:

```sh
npm exec -- desklatch-setup mcp --install-e2b
```

The check only resolves `@e2b/desktop` from that project and checks that
`E2B_API_KEY` is non-empty. It returns only a boolean presence result; it
never copies, logs, serializes, or displays the key and never starts a paid
sandbox.

Set the key in the current process session without putting it in command
history. In PowerShell, use the masked prompt:

```powershell
$secure = Read-Host "E2B_API_KEY" -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $env:E2B_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
```

In macOS/Linux shells:

```sh
read -r -s E2B_API_KEY
export E2B_API_KEY
printf '\n'
```

For a private env file, keep `.env` outside source control and restrict it to
the owner (`chmod 600 .env` on macOS/Linux; use a user-only ACL on Windows):

```dotenv
E2B_API_KEY=replace-this-line-in-your-private-file
```

Pass the path to the file when the wizard asks, or select a file directly.
Use `--e2b` to check an already installed SDK.

```sh
npm exec -- desklatch-setup mcp --install-e2b --env-file .env
npm exec -- desklatch-setup mcp --e2b --env-file .env
```

Do not commit the file, paste the real key into shell history, or include it
in `ocr.json`, MCP JSON, DSH bundle metadata, logs, or bug reports.

### Existing host-owned sandbox

DeskLatch does not own E2B lifecycle. The host creates and releases the
sandbox, then passes that already-owned `Sandbox` to the E2B backend:

```js
import { Sandbox } from "@e2b/desktop";
import { createE2BBrowserBackend } from "desklatch/e2b";

const guest = await Sandbox.create({
  timeoutMs: 300_000,
  network: { allowPublicTraffic: false },
  allowInternetAccess: false
});
try {
  const backend = await createE2BBrowserBackend(guest, {
    browser: { allowBlank: true }
  });
  try {
    // Pass backend to createDeskSession/createDeskTools in the existing host.
  } finally {
    await backend.close();
  }
} finally {
  await guest.kill();
}
```

The setup check does not execute this code, allocate a guest, or contact E2B.
Only the host's explicitly authorized integration should create a sandbox and
choose its network policy.
