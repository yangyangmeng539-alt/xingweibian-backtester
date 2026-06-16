import json
import os
import sys
import time
import traceback
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
    for key in PROXY_ENV_KEYS:
        os.environ.pop(key, None)

    for key, value in _ORIGINAL_PROXY_ENV.items():
        os.environ[key] = value


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


def fetch_eastmoney_hk(session, symbol, start_date, end_date, adjust):
    # 东方财富港股 secid：116.00700
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

    response = session.get(url, params=params, timeout=20)
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


def fetch_tencent_hk(session, symbol, start_date, end_date, adjust):
    # 腾讯港股：hk00700
    code = f"hk{symbol}"

    start_text = to_iso_date(start_date)
    end_text = to_iso_date(end_date)

    fq = "qfq"

    if str(adjust or "").strip().lower() == "hfq":
        fq = "hfq"

    url = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"

    params = {
        "param": f"{code},day,{start_text},{end_text},2000,{fq}"
    }

    response = session.get(url, params=params, timeout=20)
    response.raise_for_status()

    payload = response.json()
    data = payload.get("data") or {}
    stock_data = data.get(code) or {}

    rows = (
        stock_data.get(f"{fq}day")
        or stock_data.get("qfqday")
        or stock_data.get("hfqday")
        or stock_data.get("day")
        or []
    )

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


def try_source(source_name, fetcher, session, symbol, start_date, end_date, adjust):
    errors = []

    for attempt in range(1, 4):
        try:
            bars = fetcher(session, symbol, start_date, end_date, adjust)

            if bars:
                return {
                    "ok": True,
                    "source": source_name,
                    "bars": bars,
                    "warnings": errors
                }

            errors.append(f"{source_name} 第 {attempt} 次返回空数据")
        except Exception as error:
            errors.append(f"{source_name} 第 {attempt} 次失败：{error}")

        time.sleep(0.8 * attempt)

    return {
        "ok": False,
        "source": source_name,
        "bars": [],
        "errors": errors
    }


def fetch_with_network_mode(symbol, start_date, end_date, adjust, mode_name, use_proxy):
    session = make_session(use_proxy=use_proxy)
    errors = []

    sources = [
        ("eastmoney_hk_direct", fetch_eastmoney_hk),
        ("tencent_hk_direct", fetch_tencent_hk),
    ]

    for source_name, fetcher in sources:
        result = try_source(source_name, fetcher, session, symbol, start_date, end_date, adjust)

        if result.get("ok"):
            return {
                "ok": True,
                "source": result.get("source"),
                "bars": result.get("bars") or [],
                "warnings": result.get("warnings") or [],
                "networkMode": mode_name,
                "proxyDisabled": not use_proxy
            }

        errors.extend(result.get("errors") or [])

    return {
        "ok": False,
        "errors": errors,
        "networkMode": mode_name,
        "proxyDisabled": not use_proxy
    }


def main():
    symbol = normalize_symbol(sys.argv[1] if len(sys.argv) > 1 else "")
    start_date = normalize_date(
        sys.argv[2] if len(sys.argv) > 2 else "19700101",
        "19700101"
    ) or "19700101"

    end_date = normalize_date(sys.argv[3] if len(sys.argv) > 3 else "")

    if not end_date:
        end_date = datetime.now().strftime("%Y%m%d")

    adjust = str(sys.argv[4] if len(sys.argv) > 4 else "qfq").strip() or "qfq"
    requested_mode = get_network_mode()

    all_errors = []

    for mode_name, use_proxy in get_mode_plan(requested_mode):
        result = fetch_with_network_mode(
            symbol=symbol,
            start_date=start_date,
            end_date=end_date,
            adjust=adjust,
            mode_name=mode_name,
            use_proxy=use_proxy
        )

        if result.get("ok"):
            print(json.dumps({
                "ok": True,
                "symbol": symbol,
                "market": "HK",
                "source": result.get("source"),
                "networkMode": result.get("networkMode"),
                "proxyDisabled": bool(result.get("proxyDisabled")),
                "warnings": result.get("warnings") or [],
                "bars": result.get("bars") or []
            }, ensure_ascii=False))
            return

        all_errors.extend(result.get("errors") or [])

    print(json.dumps({
        "ok": False,
        "symbol": symbol,
        "market": "HK",
        "source": "hk_multi_direct",
        "networkMode": requested_mode,
        "proxyDisabled": requested_mode != "system_proxy",
        "error": "港股日线拉取失败：东方财富港股直连与腾讯港股直连均失败。",
        "errors": all_errors
    }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({
            "ok": False,
            "source": "hk_multi_direct",
            "market": "HK",
            "networkMode": get_network_mode(),
            "proxyDisabled": get_network_mode() != "system_proxy",
            "error": str(error),
            "traceback": traceback.format_exc()
        }, ensure_ascii=False))