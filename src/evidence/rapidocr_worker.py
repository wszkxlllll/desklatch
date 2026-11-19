#!/usr/bin/env python3
"""Bounded, stdin/stdout-only RapidOCR bridge for DeskLatch.

The parent process passes an already-existing local model configuration and a
base64 image on stdin. No image, model path, or user text is accepted on argv or
written to stdout/stderr. This worker never downloads models; all configured
files must exist before RapidOCR is constructed.
"""

from __future__ import annotations

import base64
import contextlib
import importlib
import io
import json
import math
from pathlib import Path
import sys
from typing import Any


class WorkerFailure(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def emit(value: dict[str, Any]) -> None:
    # sys.__stdout__ bypasses library logging redirected below. Keep the wire
    # format one compact JSON object so model/image text cannot become logs.
    # ASCII escaping keeps the worker protocol safe on Windows cp1252 stdout;
    # the parent JSON parser restores the original Unicode text.
    sys.__stdout__.write(json.dumps(value, ensure_ascii=True, separators=(",", ":")) + "\n")
    sys.__stdout__.flush()


def fail(code: str) -> None:
    emit({"ok": False, "error": {"code": code}})


def validate_config(config: Any) -> dict[str, Any]:
    if not isinstance(config, dict):
        raise WorkerFailure("MODEL_NOT_FOUND")
    required = ("detectorModelPath", "recognizerModelPath", "dictionaryPath")
    for key in required:
        value = config.get(key)
        if not isinstance(value, str) or not value or "\x00" in value or "\r" in value or "\n" in value:
            raise WorkerFailure("MODEL_NOT_FOUND")
        path = Path(value)
        if not path.is_absolute() or not path.is_file():
            raise WorkerFailure("MODEL_NOT_FOUND")
    classifier = config.get("classifierModelPath")
    if classifier is not None:
        if not isinstance(classifier, str) or not Path(classifier).is_absolute() or not Path(classifier).is_file():
            raise WorkerFailure("MODEL_NOT_FOUND")
    return config


def rapid_params(config: dict[str, Any], modern: Any = None) -> dict[str, Any]:
    engine_type: Any = "onnxruntime"
    det_lang: Any = "ch"
    rec_lang: Any = "ch"
    model_type: Any = "mobile"
    ocr_version: Any = "PP-OCRv5"
    if modern is not None:
        # rapidocr>=3.10 validates these five fields as Enum instances rather
        # than accepting their YAML string spellings.
        engine_type = getattr(getattr(modern, "EngineType", None), "ONNXRUNTIME", engine_type)
        det_lang = getattr(getattr(modern, "LangDet", None), "CH", det_lang)
        rec_lang = getattr(getattr(modern, "LangRec", None), "CH", rec_lang)
        model_type = getattr(getattr(modern, "ModelType", None), "MOBILE", model_type)
        ocr_version = getattr(getattr(modern, "OCRVersion", None), "PPOCRV5", ocr_version)
    params: dict[str, Any] = {
        "Global.use_cls": config.get("classifierModelPath") is not None,
        "Det.engine_type": engine_type,
        "Det.lang_type": det_lang,
        "Det.model_type": model_type,
        "Det.ocr_version": ocr_version,
        "Det.model_path": config["detectorModelPath"],
        "Rec.engine_type": engine_type,
        "Rec.lang_type": rec_lang,
        "Rec.model_type": model_type,
        "Rec.ocr_version": ocr_version,
        "Rec.model_path": config["recognizerModelPath"],
        "Rec.rec_keys_path": config["dictionaryPath"],
        # rapidocr_onnxruntime used keys_path before the merged rapidocr API.
        "Rec.keys_path": config["dictionaryPath"],
    }
    classifier = config.get("classifierModelPath")
    if classifier is not None:
        params.update({
            "Cls.engine_type": engine_type,
            "Cls.lang_type": det_lang,
            "Cls.model_type": model_type,
            "Cls.ocr_version": ocr_version,
            "Cls.model_path": classifier,
        })
    return params


def load_engine(config: dict[str, Any]) -> Any:
    # Import and construct under redirected streams. RapidOCR versions differ:
    # the merged package is preferred, with the legacy ONNX package supported
    # for existing offline installations.
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        block_network()
        try:
            modern = importlib.import_module("rapidocr")
        except ImportError:
            modern = None
        if modern is not None:
            try:
                params = rapid_params(config, modern)
                return modern.RapidOCR(params=params)
            except Exception as error:  # noqa: BLE001 - hide model paths/details
                raise WorkerFailure("MODEL_LOAD_FAILED") from error

        try:
            legacy = importlib.import_module("rapidocr_onnxruntime")
        except ImportError as error:
            raise WorkerFailure("RAPIDOCR_UNAVAILABLE") from error
        try:
            params = rapid_params(config)
            return legacy.RapidOCR(params)
        except Exception as error:  # noqa: BLE001 - hide model paths/details
            raise WorkerFailure("MODEL_LOAD_FAILED") from error


def block_network() -> None:
    """Make an accidental RapidOCR model/resource download fail locally."""
    def deny(*_args: Any, **_kwargs: Any) -> None:
        raise WorkerFailure("MODEL_LOAD_FAILED")

    try:
        import socket
        socket.create_connection = deny  # type: ignore[assignment]
        socket.socket.connect = deny  # type: ignore[assignment]
    except Exception:
        pass
    try:
        import urllib.request
        urllib.request.urlopen = deny  # type: ignore[assignment]
    except Exception:
        pass
def decode_image(value: Any) -> tuple[Any, dict[str, Any]]:
    if not isinstance(value, dict):
        raise WorkerFailure("INVALID_IMAGE")
    encoded = value.get("dataBase64")
    if not isinstance(encoded, str) or not encoded or len(encoded) > 100_000_000:
        raise WorkerFailure("INVALID_IMAGE")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except Exception as error:  # noqa: BLE001
        raise WorkerFailure("INVALID_IMAGE") from error
    if not raw:
        raise WorkerFailure("INVALID_IMAGE")

    try:
        import numpy as np
        import cv2
        image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    except Exception:
        image = None
    if image is None:
        try:
            from PIL import Image
            with Image.open(io.BytesIO(raw)) as pil_image:
                image = pil_image.convert("RGB").copy()
        except Exception as error:  # noqa: BLE001
            raise WorkerFailure("INVALID_IMAGE") from error
    if image is None or getattr(image, "size", 0) == 0:
        raise WorkerFailure("INVALID_IMAGE")

    width = value.get("width")
    height = value.get("height")
    region = value.get("region")
    if not isinstance(width, int) or not isinstance(height, int) or width < 1 or height < 1 or not isinstance(region, dict):
        raise WorkerFailure("INVALID_REGION")
    x = region.get("x")
    y = region.get("y")
    region_width = region.get("width")
    region_height = region.get("height")
    if not all(isinstance(item, (int, float)) and math.isfinite(float(item)) for item in (x, y, region_width, region_height)):
        raise WorkerFailure("INVALID_REGION")
    if x < 0 or y < 0 or region_width <= 0 or region_height <= 0 or region_width > 4096 or region_height > 4096 or x + region_width > width or y + region_height > height:
        raise WorkerFailure("INVALID_REGION")
    # Host coordinates are integer pixels. Clamp only the conversion boundary;
    # the TS side has already checked the full image bound.
    left = int(x)
    top = int(y)
    right = int(x + region_width)
    bottom = int(y + region_height)
    if hasattr(image, "crop"):
        cropped = image.crop((left, top, right, bottom))
    else:
        cropped = image[top:bottom, left:right]
    if getattr(cropped, "size", 0) == 0:
        raise WorkerFailure("INVALID_REGION")
    return cropped, region


def make_box(value: Any) -> list[float] | None:
    try:
        points = value.tolist() if hasattr(value, "tolist") else value
        if isinstance(points, (list, tuple)) and points and isinstance(points[0], (list, tuple)):
            xs = [float(point[0]) for point in points if len(point) >= 2]
            ys = [float(point[1]) for point in points if len(point) >= 2]
            if xs and ys:
                return [min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)]
        if isinstance(points, (list, tuple)) and len(points) >= 4:
            return [float(points[0]), float(points[1]), float(points[2]), float(points[3])]
    except Exception:
        return None
    return None


def lines_from_result(result: Any) -> list[dict[str, Any]]:
    # rapidocr>=3 returns an OCRResult with txts/scores/boxes; legacy versions
    # return ([(box, text, score), ...], elapsed).
    if isinstance(result, tuple) and result:
        result = result[0]
    texts = getattr(result, "txts", None)
    scores = getattr(result, "scores", None)
    boxes = getattr(result, "boxes", None)
    if texts is not None:
        texts = texts.tolist() if hasattr(texts, "tolist") else texts
        scores = scores.tolist() if hasattr(scores, "tolist") else scores
        boxes = boxes.tolist() if hasattr(boxes, "tolist") else boxes
        output: list[dict[str, Any]] = []
        for index, text in enumerate(texts or []):
            if not isinstance(text, str):
                continue
            cleaned = " ".join(text.replace("\r", " ").replace("\n", " ").split())[:320]
            if not cleaned:
                continue
            score = None
            if isinstance(scores, (list, tuple)) and index < len(scores):
                try:
                    score = max(0.0, min(1.0, float(scores[index])))
                except (TypeError, ValueError):
                    score = None
            line: dict[str, Any] = {"text": cleaned}
            if score is not None and math.isfinite(score):
                line["confidence"] = score
            if isinstance(boxes, (list, tuple)) and index < len(boxes):
                box = make_box(boxes[index])
                if box is not None:
                    line["box"] = box
            output.append(line)
        return output[:128]

    if not isinstance(result, (list, tuple)):
        return []
    output = []
    for item in result:
        if not isinstance(item, (list, tuple)) or len(item) < 2:
            continue
        box, text = item[0], item[1]
        if not isinstance(text, str):
            continue
        cleaned = " ".join(text.replace("\r", " ").replace("\n", " ").split())[:320]
        if not cleaned:
            continue
        line = {"text": cleaned}
        if len(item) >= 3:
            try:
                score = max(0.0, min(1.0, float(item[2])))
                if math.isfinite(score):
                    line["confidence"] = score
            except (TypeError, ValueError):
                pass
        parsed_box = make_box(box)
        if parsed_box is not None:
            line["box"] = parsed_box
        output.append(line)
    return output[:128]


def handle(request: Any) -> None:
    if not isinstance(request, dict):
        raise WorkerFailure("WORKER_PROTOCOL_ERROR")
    config = validate_config(request.get("config"))
    op = request.get("op")
    engine = load_engine(config)
    if op == "probe":
        emit({"ok": True, "status": "ready"})
        return
    if op != "recognize":
        raise WorkerFailure("WORKER_PROTOCOL_ERROR")
    image, _region = decode_image(request.get("image"))
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            result = engine(image)
        emit({"ok": True, "lines": lines_from_result(result)})
    except WorkerFailure:
        raise
    except Exception as error:  # noqa: BLE001 - do not leak paths/text
        raise WorkerFailure("INFERENCE_FAILED") from error


def main() -> None:
    # Deliberately do not inspect argv. The only accepted input is one JSON
    # request on stdin; this keeps image bytes out of process arguments.
    line = sys.stdin.readline()
    if not line:
        fail("WORKER_PROTOCOL_ERROR")
        return
    try:
        request = json.loads(line)
        handle(request)
    except WorkerFailure as error:
        fail(error.code)
    except Exception:  # noqa: BLE001 - typed failure only
        fail("WORKER_FAILED")


if __name__ == "__main__":
    main()
