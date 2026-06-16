import json
import os
import sys
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime


PROXY_ENV_KEYS = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
]

_ORIGINAL_PROXY_ENV = {
    key: os.environ.get(key)
    for key in PROXY_ENV_KEYS
    if os.environ.get(key)
}


def get_network_mode():
    return str(os.environ.get("XWB_NETWORK_MODE") or "direct").strip().lower() or "direct"


def clear_proxy_env():
    for key in PROXY_ENV_KEYS:
        os.environ.pop(key, None)

    os.environ["NO_PROXY"] = "*"
    os.environ["no_proxy"] = "*"


def restore_proxy_env():
    for key, value in _ORIGINAL_PROXY_ENV.items():
        os.environ[key] = value


def get_mode_plan(requested_mode):
    mode = str(requested_mode or "direct").strip().lower()

    if mode == "system_proxy":
        return [("system_proxy", True)]

    if mode == "auto":
        plan = [("direct", False)]
        if _ORIGINAL_PROXY_ENV:
            plan.append(("system_proxy", True))
        return plan

    return [("direct", False)]


def make_session(use_proxy=False):
    import requests

    if use_proxy:
        restore_proxy_env()
    else:
        clear_proxy_env()

    session = requests.Session()
    session.trust_env = bool(use_proxy)
    session.headers.update({
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept": "application/json,text/plain,*/*",
        "Connection": "close",
        "Referer": "https://quote.eastmoney.com/"
    })
    return session


def normalize_symbol(value):
    text = str(value or "").strip().upper()

    if text.startswith("HK:"):
        text = text[3:]

    if text.endswith(".HK"):
        text = text[:-3]

    digits = "".join(ch for ch in text if ch.isdigit())

    if not digits or len(digits) > 5:
        raise ValueError(f"非法港股代码: {value}")

    return digits.zfill(5)


def normalize_date(value, fallback=""):
    text = str(value or fallback or "").strip().replace("-", "")
    if len(text) == 8 and text.isdigit():
        return text
    return ""


def to_iso_date(value):
    text = str(value or "").strip().replace("-", "")
    if len(text) == 8 and text.isdigit():
        return f"{text[0:4]}-{text[4:6]}-{text[6:8]}"
    return str(value or "").strip()[:10]


def to_float(value):
    if value is None:
        return None

    text = str(value).strip().replace(",", "")

    if text == "" or text.lower() == "nan" or text == "--" or text == "-":
        return None

    try:
        return float(text)
    except Exception:
        return None


def date_to_int(value):
    text = str(value or "").strip().replace("-", "")
    if len(text) == 8 and text.isdigit():
        return int(text)
    return 0


def get_eastmoney_fqt(adjust):
    text = str(adjust or "qfq").strip().lower()

    if text in ("qfq", "1"):
        return "1"

    if text in ("hfq", "2"):
        return "2"

    return "0"


def normalize_bar(bar):
    if not bar:
        return None

    date = str(bar.get("date") or "").strip()
    close_price = to_float(bar.get("close"))

    if not date or close_price is None:
        return None

    return {
        "date": date,
        "open": to_float(bar.get("open")),
        "close": close_price,
        "high": to_float(bar.get("high")),
        "low": to_float(bar.get("low")),
        "volume": to_float(bar.get("volume")),
        "amount": to_float(bar.get("amount")),
        "amplitude": to_float(bar.get("amplitude")),
        "pctChange": to_float(bar.get("pctChange")),
        "changeAmount": to_float(bar.get("changeAmount")),
        "turnover": to_float(bar.get("turnover"))
    }


def filter_sort_bars(bars, start_date, end_date):
    start_int = date_to_int(start_date)
    end_int = date_to_int(end_date)
    result = []

    for item in bars or []:
        bar = normalize_bar(item)

        if not bar:
            continue

        current_int = date_to_int(bar.get("date"))

        if start_int and current_int and current_int < start_int:
            continue

        if end_int and current_int and current_int > end_int:
            continue

        result.append(bar)

    result.sort(key=lambda row: row.get("date") or "")

    prev_close = None
    for row in result:
        close_price = to_float(row.get("close"))

        if row.get("pctChange") is None and prev_close and close_price is not None:
            row["pctChange"] = round((close_price - prev_close) / prev_close * 100, 4)
            row["changeAmount"] = round(close_price - prev_close, 4)

        if close_price is not None:
            prev_close = close_price

    return result

def fetch_tencent_hk(session, symbol, start_date, end_date, adjust):
    code = f"hk{symbol}"

    start_text = to_iso_date(start_date)
    end_text = to_iso_date(end_date)

    # 港股腾讯接口不能走 fqkline/get + qfq/hfq：
    # 该组合会返回 501 / WAF 页面。港股这里先走可用的 kline/kline 非复权日线。
    url = "https://web.ifzq.gtimg.cn/appstock/app/kline/kline"

    params = {
        "param": f"{code},day,{start_text},{end_text},2000"
    }

    response = session.get(
        url,
        params=params,
        timeout=12,
        headers={
            "Referer": "https://gu.qq.com/",
            "Accept": "application/json,text/plain,*/*"
        }
    )
    response.raise_for_status()

    payload = response.json()
    data = payload.get("data") or {}
    stock_data = data.get(code) or {}

    rows = stock_data.get("day") or []

    bars = []

    for row in rows:
        if not isinstance(row, list) or len(row) < 5:
            continue

        bars.append({
            "date": to_iso_date(row[0]),
            "open": row[1] if len(row) > 1 else None,
            "close": row[2] if len(row) > 2 else None,
            "high": row[3] if len(row) > 3 else None,
            "low": row[4] if len(row) > 4 else None,
            "volume": row[5] if len(row) > 5 else None,
            "amount": None,
            "amplitude": None,
            "pctChange": None,
            "changeAmount": None,
            "turnover": None
        })

    return filter_sort_bars(bars, start_date, end_date)

def fetch_eastmoney_hk(session, symbol, start_date, end_date, adjust):
    url = "https://push2his.eastmoney.com/api/qt/stock/kline/get"

    params = {
        "secid": f"116.{symbol}",
        "ut": "fa5fd1943c7b386f172d6893dbfba10b",
        "fields1": "f1,f2,f3,f4,f5,f6",
        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
        "klt": "101",
        "fqt": get_eastmoney_fqt(adjust),
        "beg": start_date,
        "end": end_date,
        "_": str(int(time.time() * 1000))
    }

    response = session.get(url, params=params, timeout=12)
    response.raise_for_status()

    payload = response.json()
    data = payload.get("data") or {}
    klines = data.get("klines") or []

    bars = []

    for line in klines:
        parts = str(line).split(",")

        if len(parts) < 6:
            continue

        bars.append({
            "date": to_iso_date(parts[0]),
            "open": parts[1] if len(parts) > 1 else None,
            "close": parts[2] if len(parts) > 2 else None,
            "high": parts[3] if len(parts) > 3 else None,
            "low": parts[4] if len(parts) > 4 else None,
            "volume": parts[5] if len(parts) > 5 else None,
            "amount": parts[6] if len(parts) > 6 else None,
            "amplitude": parts[7] if len(parts) > 7 else None,
            "pctChange": parts[8] if len(parts) > 8 else None,
            "changeAmount": parts[9] if len(parts) > 9 else None,
            "turnover": parts[10] if len(parts) > 10 else None
        })

    return filter_sort_bars(bars, start_date, end_date)


def fetch_one(symbol, start_date, end_date, adjust, network_mode):
    normalized = normalize_symbol(symbol)
    errors = []
    empty_sources = []

    sources = [
        ("tencent_hk_batch_incremental", fetch_tencent_hk),
        ("eastmoney_hk_batch_incremental", fetch_eastmoney_hk),
    ]

    for mode_name, use_proxy in get_mode_plan(network_mode):
        session = make_session(use_proxy=use_proxy)

        for source_name, fetcher in sources:
            for attempt in range(1, 3):
                try:
                    bars = fetcher(session, normalized, start_date, end_date, adjust)

                    if bars:
                        return {
                            "symbol": f"HK:{normalized}",
                            "ok": True,
                            "source": source_name,
                            "bars": bars,
                            "error": ""
                        }

                    empty_sources.append(source_name)
                    errors.append(f"{source_name} 第 {attempt} 次返回空数据")
                except Exception as error:
                    errors.append(f"{source_name} 第 {attempt} 次失败：{error}")

                time.sleep(0.25 * attempt)

    if empty_sources:
        return {
            "symbol": f"HK:{normalized}",
            "ok": True,
            "source": "hk_batch_incremental_no_new_data",
            "bars": [],
            "noNewData": True,
            "error": "; ".join(errors[-6:]) or "港股批量增量无新增日线"
        }

    return {
        "symbol": f"HK:{normalized}",
        "ok": False,
        "source": "hk_batch_incremental_multi_direct",
        "bars": [],
        "noNewData": False,
        "error": "; ".join(errors[-6:]) or "港股批量增量返回空数据"
    }


def read_payload():
    raw = sys.stdin.read()
    raw = raw.lstrip("\ufeff").strip()

    if not raw:
        raise ValueError("stdin payload is empty")

    payload = json.loads(raw)

    symbols = payload.get("symbols") or []
    if not isinstance(symbols, list):
        raise ValueError("symbols must be list")

    start_date = normalize_date(payload.get("startDate"), "19700101") or "19700101"
    end_date = normalize_date(payload.get("endDate"), datetime.now().strftime("%Y%m%d"))
    adjust = str(payload.get("adjust") or "qfq").strip() or "qfq"
    network_mode = str(payload.get("networkMode") or get_network_mode()).strip() or "direct"
    concurrency = int(payload.get("concurrency") or 8)

    if concurrency < 1:
        concurrency = 1
    if concurrency > 16:
        concurrency = 16

    clean_symbols = []
    seen = set()

    for item in symbols:
        code = normalize_symbol(item)
        display = f"HK:{code}"
        if display in seen:
            continue
        seen.add(display)
        clean_symbols.append(display)

    return {
        "symbols": clean_symbols,
        "startDate": start_date,
        "endDate": end_date,
        "adjust": adjust,
        "networkMode": network_mode,
        "concurrency": concurrency
    }


def main():
    payload = read_payload()
    results = []

    with ThreadPoolExecutor(max_workers=payload["concurrency"]) as executor:
        futures = [
            executor.submit(
                fetch_one,
                symbol,
                payload["startDate"],
                payload["endDate"],
                payload["adjust"],
                payload["networkMode"]
            )
            for symbol in payload["symbols"]
        ]

        for future in as_completed(futures):
            results.append(future.result())

    ok_count = sum(1 for item in results if item.get("ok"))
    failed_count = len(results) - ok_count
    bar_count = sum(len(item.get("bars") or []) for item in results)

    print(json.dumps({
        "ok": True,
        "market": "HK",
        "source": "hk_batch_incremental_multi_direct",
        "startDate": payload["startDate"],
        "endDate": payload["endDate"],
        "concurrency": payload["concurrency"],
        "total": len(results),
        "okCount": ok_count,
        "failedCount": failed_count,
        "barCount": bar_count,
        "results": results
    }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({
            "ok": False,
            "market": "HK",
            "source": "hk_batch_incremental_multi_direct",
            "error": str(error),
            "traceback": traceback.format_exc()
        }, ensure_ascii=False))