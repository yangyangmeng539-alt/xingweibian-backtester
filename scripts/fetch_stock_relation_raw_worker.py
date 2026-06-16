# -*- coding: utf-8 -*-
import contextlib
import json
import math
import os
import sys
import time
import traceback


PROXY_KEYS = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
]


def clean_proxy_env():
    for key in PROXY_KEYS:
        os.environ.pop(key, None)

    os.environ["NO_PROXY"] = "*"
    os.environ["no_proxy"] = "*"


def is_blank(value):
    if value is None:
        return True

    if isinstance(value, float) and math.isnan(value):
        return True

    return str(value).strip() == ""


def clean_value(value):
    if value is None:
        return ""

    if isinstance(value, float) and math.isnan(value):
        return ""

    if isinstance(value, (str, int, float, bool)):
        return value

    return str(value)


def to_records(raw):
    if raw is None:
        return []

    if hasattr(raw, "to_dict"):
        try:
            records = raw.to_dict(orient="records")
            return records if isinstance(records, list) else []
        except TypeError:
            try:
                data = raw.to_dict()
                if isinstance(data, dict):
                    return [data]
            except Exception:
                return []

    if isinstance(raw, list):
        return raw

    if isinstance(raw, tuple):
        return list(raw)

    if isinstance(raw, dict):
        if isinstance(raw.get("data"), list):
            return raw.get("data")
        if isinstance(raw.get("items"), list):
            return raw.get("items")
        return [raw]

    return []


def first_value(row, keys):
    for key in keys:
        if key in row and not is_blank(row.get(key)):
            return str(row.get(key)).strip()

    return ""


def normalize_concept_row(code, row):
    data = row if isinstance(row, dict) else {}
    concept_code = first_value(data, ["concept_code", "code", "conceptCode", "ths_code", "id"])
    name = first_value(data, ["name", "concept_name", "conceptName", "plate_name", "板块名称"])
    reason = first_value(data, ["reason", "reason_info", "desc", "description", "入选理由"])

    if not concept_code and name:
        concept_code = name

    if not concept_code and not name:
        return None

    return {
        "stock_code": first_value(data, ["stock_code", "symbol"]) or code,
        "concept_code": concept_code,
        "name": name or concept_code,
        "source": first_value(data, ["source"]) or "同花顺",
        "reason": reason,
    }


def normalize_plate_row(code, row):
    data = row if isinstance(row, dict) else {}
    plate_code = first_value(data, ["plate_code", "code", "plateCode", "bk_code", "id"])
    plate_name = first_value(data, ["plate_name", "name", "plateName", "板块名称"])
    plate_type = first_value(data, ["plate_type", "type", "plateType", "板块类型"])

    if not plate_code and plate_name:
        plate_code = plate_name

    if not plate_code and not plate_name:
        return None

    return {
        "stock_code": first_value(data, ["stock_code", "symbol"]) or code,
        "plate_code": plate_code,
        "plate_name": plate_name or plate_code,
        "plate_type": plate_type,
        "source": first_value(data, ["source"]) or "东方财富",
    }


def normalize_concepts(code, raw):
    rows = []

    for row in to_records(raw):
        normalized = normalize_concept_row(code, row)
        if normalized:
            rows.append(normalized)

    return rows


def normalize_plates(code, raw):
    rows = []

    for row in to_records(raw):
        normalized = normalize_plate_row(code, row)
        if normalized:
            rows.append(normalized)

    return rows


def fetch_relation(code):
    import adata

    with contextlib.redirect_stdout(sys.stderr):
        concept_raw = adata.stock.info.get_concept_ths(code)
        plate_raw = adata.stock.info.get_plate_east(code)

    return {
        "conceptThs": normalize_concepts(code, concept_raw),
        "plateEast": normalize_plates(code, plate_raw),
    }


def main():
    clean_proxy_env()
    code = str(sys.argv[1] if len(sys.argv) > 1 else "").strip().zfill(6)
    started_at = time.time()

    if not code.isdigit() or len(code) != 6:
        print(json.dumps({
            "ok": False,
            "code": code,
            "error": "股票代码必须是 6 位数字。",
        }, ensure_ascii=False))
        return 1

    try:
        data = fetch_relation(code)
        print(json.dumps({
            "ok": True,
            "code": code,
            "costMs": int((time.time() - started_at) * 1000),
            **data,
        }, ensure_ascii=False))
        return 0
    except Exception as error:
        print(json.dumps({
            "ok": False,
            "code": code,
            "error": str(error),
            "traceback": traceback.format_exc(limit=12),
            "costMs": int((time.time() - started_at) * 1000),
        }, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
