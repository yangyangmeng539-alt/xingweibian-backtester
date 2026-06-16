import json
import os
import sys
import time
import traceback


PROXY_ENV_KEYS = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
]

_REQUESTS_PROXY_DISABLED = False
_ORIGINAL_PROXY_ENV = {key: os.environ.get(key) for key in PROXY_ENV_KEYS if os.environ.get(key)}


def get_network_mode():
    return str(os.environ.get("XWB_NETWORK_MODE") or "auto").strip().lower() or "auto"


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


def disable_requests_proxy():
    global _REQUESTS_PROXY_DISABLED

    if _REQUESTS_PROXY_DISABLED:
        return

    import requests

    original_init = requests.sessions.Session.__init__
    original_request = requests.sessions.Session.request

    def no_proxy_init(self, *args, **kwargs):
        original_init(self, *args, **kwargs)
        self.trust_env = False

    def no_proxy_request(self, method, url, **kwargs):
        self.trust_env = False
        kwargs["proxies"] = {}

        headers = dict(kwargs.get("headers") or {})
        headers.setdefault(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        )
        headers.setdefault("Accept", "application/json,text/plain,*/*")
        headers.setdefault("Connection", "close")
        kwargs["headers"] = headers

        return original_request(self, method, url, **kwargs)

    requests.sessions.Session.__init__ = no_proxy_init
    requests.sessions.Session.request = no_proxy_request
    _REQUESTS_PROXY_DISABLED = True


def apply_network_mode(mode):
    current = str(mode or "auto").strip().lower()

    if current == "system_proxy":
        restore_proxy_env()
        return {
            "networkMode": "system_proxy",
            "proxyDisabled": False
        }

    clear_proxy_env()
    disable_requests_proxy()

    return {
        "networkMode": "direct",
        "proxyDisabled": True
    }


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


def to_float(value):
    if value is None:
        return None

    text = str(value).strip()

    if text == "" or text.lower() == "nan" or text == "--":
        return None

    text = text.replace(",", "")

    try:
        return float(text)
    except Exception:
        return None


def to_date_text(value):
    if value is None:
        return ""

    if hasattr(value, "strftime"):
        return value.strftime("%Y-%m-%d")

    text = str(value).strip()

    if not text:
        return ""

    if len(text) == 8 and text.isdigit():
        return f"{text[0:4]}-{text[4:6]}-{text[6:8]}"

    return text[:10]


def normalize_ak_date(value):
    text = str(value or "").strip().replace("-", "")

    if len(text) == 8 and text.isdigit():
        return text

    return ""


def date_text_to_int(value):
    text = str(value or "").strip().replace("-", "")

    if len(text) == 8 and text.isdigit():
        return int(text)

    return 0


def get_value(row, names):
    for name in names:
        if name in row:
            return row[name]
    return None


def dataframe_to_bars(df, start_date="", end_date=""):
    import pandas as pd

    if df is None or df.empty:
        return []

    working = df.copy()

    if working.index is not None:
        index_name = working.index.name or ""
        if index_name and index_name not in working.columns:
            working = working.reset_index()
        elif "date" not in working.columns and "日期" not in working.columns:
            working = working.reset_index()

    working = working.where(pd.notnull(working), None)

    start_int = date_text_to_int(start_date)
    end_int = date_text_to_int(end_date)

    bars = []

    for _, raw_row in working.iterrows():
        row = raw_row.to_dict()

        date_text = to_date_text(get_value(row, ["日期", "date", "Date", "index", "时间"]))

        if not date_text:
            continue

        date_int = date_text_to_int(date_text)

        if start_int and date_int and date_int < start_int:
            continue

        if end_int and date_int and date_int > end_int:
            continue

        open_price = to_float(get_value(row, ["开盘", "open", "Open"]))
        close_price = to_float(get_value(row, ["收盘", "close", "Close"]))
        high_price = to_float(get_value(row, ["最高", "high", "High"]))
        low_price = to_float(get_value(row, ["最低", "low", "Low"]))

        if close_price is None:
            continue

        bars.append({
            "date": date_text,
            "open": open_price,
            "close": close_price,
            "high": high_price,
            "low": low_price,
            "volume": to_float(get_value(row, ["成交量", "volume", "Volume"])),
            "amount": to_float(get_value(row, ["成交额", "amount", "Amount"])),
            "amplitude": to_float(get_value(row, ["振幅", "amplitude"])),
            "pctChange": to_float(get_value(row, ["涨跌幅", "pct_change", "pctChange"])),
            "changeAmount": to_float(get_value(row, ["涨跌额", "change_amount", "changeAmount"])),
            "turnover": to_float(get_value(row, ["换手率", "turnover"]))
        })

    bars.sort(key=lambda item: item.get("date") or "")
    return bars


def fetch_stock_hk_hist(ak, symbol, start_date, end_date, adjust):
    df = ak.stock_hk_hist(
        symbol=symbol,
        period="daily",
        start_date=start_date,
        end_date=end_date,
        adjust=adjust
    )

    return dataframe_to_bars(df, start_date, end_date)


def fetch_stock_hk_daily(ak, symbol, start_date, end_date, adjust):
    # 新浪港股日线兜底。部分 AKShare 版本支持 adjust，部分版本不稳定，所以分两次尝试。
    last_error = None

    for kwargs in (
        {"symbol": symbol, "adjust": adjust},
        {"symbol": symbol},
    ):
        try:
            df = ak.stock_hk_daily(**kwargs)
            bars = dataframe_to_bars(df, start_date, end_date)

            if bars:
                return bars
        except TypeError as error:
            last_error = error
            continue
        except Exception as error:
            last_error = error
            continue

    if last_error:
        raise last_error

    return []


def try_fetch_with_mode(ak, symbol, start_date, end_date, adjust, mode):
    network_info = apply_network_mode(mode)
    errors = []

    for attempt in range(1, 4):
        try:
            bars = fetch_stock_hk_hist(ak, symbol, start_date, end_date, adjust)

            if bars:
                return {
                    "ok": True,
                    "bars": bars,
                    "source": "akshare_hk_hist",
                    **network_info
                }

            errors.append(f"stock_hk_hist 第 {attempt} 次返回空数据")
        except Exception as error:
            errors.append(f"stock_hk_hist 第 {attempt} 次失败：{error}")

        time.sleep(1.2 * attempt)

    try:
        bars = fetch_stock_hk_daily(ak, symbol, start_date, end_date, adjust)

        if bars:
            return {
                "ok": True,
                "bars": bars,
                "source": "akshare_hk_daily_fallback",
                "fallbackFrom": "stock_hk_hist",
                "warnings": errors,
                **network_info
            }

        errors.append("stock_hk_daily 兜底返回空数据")
    except Exception as error:
        errors.append(f"stock_hk_daily 兜底失败：{error}")

    return {
        "ok": False,
        "bars": [],
        "errors": errors,
        **network_info
    }


def main():
    symbol = normalize_symbol(sys.argv[1] if len(sys.argv) > 1 else "")
    start_date = normalize_ak_date(sys.argv[2] if len(sys.argv) > 2 else "19700101") or "19700101"
    end_date = normalize_ak_date(sys.argv[3] if len(sys.argv) > 3 else "")

    if not end_date:
        from datetime import datetime
        end_date = datetime.now().strftime("%Y%m%d")

    adjust = str(sys.argv[4] if len(sys.argv) > 4 else "qfq").strip() or "qfq"
    requested_mode = get_network_mode()

    import akshare as ak

    modes = []

    if requested_mode == "direct":
        modes = ["direct"]
    elif requested_mode == "system_proxy":
        modes = ["system_proxy"]
    else:
        modes = ["direct"]
        if _ORIGINAL_PROXY_ENV:
            modes.append("system_proxy")

    all_errors = []

    for mode in modes:
        result = try_fetch_with_mode(ak, symbol, start_date, end_date, adjust, mode)

        if result.get("ok"):
            print(json.dumps({
                "ok": True,
                "symbol": symbol,
                "market": "HK",
                "source": result.get("source") or "akshare_hk",
                "fallbackFrom": result.get("fallbackFrom") or "",
                "networkMode": result.get("networkMode") or mode,
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
        "source": "akshare_hk",
        "networkMode": requested_mode,
        "proxyDisabled": requested_mode != "system_proxy",
        "error": "港股日线拉取失败，stock_hk_hist 与 stock_hk_daily 均未成功。",
        "errors": all_errors
    }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({
            "ok": False,
            "source": "akshare_hk",
            "market": "HK",
            "networkMode": get_network_mode(),
            "proxyDisabled": get_network_mode() != "system_proxy",
            "error": str(error),
            "traceback": traceback.format_exc()
        }, ensure_ascii=False))