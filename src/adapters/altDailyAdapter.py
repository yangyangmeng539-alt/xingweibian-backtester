import json
import os
import sys
import traceback
import urllib.parse
import urllib.request
from datetime import datetime, timedelta


PROXY_ENV_KEYS = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
]
TENCENT_HOST = "web.ifzq.gtimg.cn"
TENCENT_FQKLINE_URL = f"https://{TENCENT_HOST}/appstock/app/fqkline/get"
BASE_REQUEST_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json,text/plain,*/*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Referer": "https://gu.qq.com/",
    "Origin": "https://gu.qq.com",
    "Connection": "close",
}
UNSUPPORTED_MARKET = "UNSUPPORTED_MARKET"


class UnsupportedMarketError(ValueError):
    def __init__(self, message):
        self.code = UNSUPPORTED_MARKET
        super().__init__(message)


class AltDailyFailure(RuntimeError):
    def __init__(self, message, raw_error="", request_errors=None):
        self.raw_error = raw_error or message
        self.request_errors = request_errors or []
        super().__init__(message)


def get_network_mode():
    return str(os.environ.get("XWB_NETWORK_MODE") or "direct").strip().lower() or "direct"


def clear_proxy_env():
    for key in PROXY_ENV_KEYS:
        os.environ.pop(key, None)

    os.environ["NO_PROXY"] = "*"
    os.environ["no_proxy"] = "*"


clear_proxy_env()


def normalize_symbol(value):
    text = str(value or "").strip()
    if not text.isdigit() or len(text) != 6:
        raise ValueError(f"非法 A 股代码: {value}")
    return text


def normalize_date(value, fallback=""):
    text = str(value or fallback or "").strip().replace("-", "")
    if not text:
        return ""
    if not text.isdigit() or len(text) != 8:
        raise ValueError(f"非法日期: {value}")
    return text


def parse_ak_date(value):
    text = normalize_date(value)
    return datetime.strptime(text, "%Y%m%d")


def to_tencent_date(value):
    text = normalize_date(value)
    return f"{text[:4]}-{text[4:6]}-{text[6:8]}"


def to_float(value):
    if value is None:
        return None

    text = str(value).strip()
    if text == "" or text == "-" or text.lower() == "nan":
        return None

    try:
        return float(text)
    except Exception:
        return None


def round_optional(value, digits=4):
    if value is None:
        return None

    try:
        return round(float(value), digits)
    except Exception:
        return None


def is_bj_market_symbol(symbol):
    text = str(symbol or "").strip()
    return text.startswith(("8", "4")) or text.startswith("920")


def get_tencent_symbol(symbol):
    if symbol.startswith("6"):
        return f"sh{symbol}"

    if symbol.startswith(("0", "3")):
        return f"sz{symbol}"

    if is_bj_market_symbol(symbol):
        raise UnsupportedMarketError(f"{UNSUPPORTED_MARKET}: 备用源暂不支持 BJ/北交所市场代码: {symbol}")

    raise UnsupportedMarketError(f"{UNSUPPORTED_MARKET}: 备用源暂不支持该市场代码: {symbol}")


def get_adjust_param(adjust):
    text = str(adjust or "qfq").strip().lower()

    if text == "hfq":
        return "hfq"

    if text in ("", "none", "bfq"):
        return ""

    return "qfq"


def get_kline_keys(adjust_param):
    if adjust_param == "qfq":
        return ["qfqday", "day"]

    if adjust_param == "hfq":
        return ["hfqday", "day"]

    return ["day", "qfqday", "hfqday"]


def compact_error(error, limit=180):
    text = str(error or "未知错误").replace("\n", " ").strip()
    if len(text) <= limit:
        return text
    return f"{text[:limit]}..."


def build_date_windows(start_date, end_date, max_days=540):
    start = parse_ak_date(start_date)
    end = parse_ak_date(end_date)

    if start > end:
        raise ValueError("开始日期不能晚于结束日期")

    windows = []
    current = start

    while current <= end:
        window_end = min(current + timedelta(days=max_days - 1), end)
        windows.append((
            current.strftime("%Y%m%d"),
            window_end.strftime("%Y%m%d"),
        ))
        current = window_end + timedelta(days=1)

    return windows


def build_request_url(tencent_symbol, start_date, end_date, adjust_param):
    parts = [
        tencent_symbol,
        "day",
        to_tencent_date(start_date),
        to_tencent_date(end_date),
        "640",
    ]

    if adjust_param:
        parts.append(adjust_param)

    params = {
        "param": ",".join(parts),
    }
    query = urllib.parse.urlencode(params)
    return f"{TENCENT_FQKLINE_URL}?{query}"


def read_url(url):
    clear_proxy_env()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    opener.addheaders = list(BASE_REQUEST_HEADERS.items())
    request = urllib.request.Request(url, headers=BASE_REQUEST_HEADERS)

    with opener.open(request, timeout=30) as response:
        return response.read().decode("utf-8", errors="replace")


def parse_json_or_jsonp(body):
    text = str(body or "").strip()

    if not text:
        raise ValueError("空响应")

    json_start = text.find("{")
    json_end = text.rfind("}")

    if json_start < 0 or json_end < json_start:
        raise ValueError(f"响应不是 JSON：{text[:160]}")

    return json.loads(text[json_start:json_end + 1])


def parse_payload_rows(payload, tencent_symbol, adjust_param):
    data = payload.get("data") if isinstance(payload, dict) else None
    stock_data = data.get(tencent_symbol) if isinstance(data, dict) else None

    if not isinstance(stock_data, dict):
        raise ValueError("响应缺少股票日线数据")

    code = stock_data.get("code")
    if code not in (None, 0, "0"):
        raise ValueError(stock_data.get("msg") or f"接口返回 code={code}")

    for key in get_kline_keys(adjust_param):
        rows = stock_data.get(key)
        if isinstance(rows, list):
            return rows, key

    raise ValueError("响应缺少可用日线数组")


def fetch_window(tencent_symbol, start_date, end_date, adjust_param):
    url = build_request_url(tencent_symbol, start_date, end_date, adjust_param)
    body = read_url(url)
    payload = parse_json_or_jsonp(body)
    rows, key = parse_payload_rows(payload, tencent_symbol, adjust_param)
    return rows, url, key


def is_date_in_range(date_text, start_date, end_date):
    compact = str(date_text or "").replace("-", "")
    return len(compact) == 8 and start_date <= compact <= end_date


def parse_rows(rows, start_date, end_date, previous_close=None):
    bars = []
    prev_close = previous_close

    for row in rows:
        if not isinstance(row, list) or len(row) < 6:
            continue

        date_text = str(row[0] or "").strip()
        if not is_date_in_range(date_text, start_date, end_date):
            continue

        open_price = to_float(row[1])
        close_price = to_float(row[2])
        high_price = to_float(row[3])
        low_price = to_float(row[4])
        volume = to_float(row[5])
        amount = to_float(row[6]) if len(row) > 6 else None
        change_amount = None
        pct_change = None
        amplitude = None

        if prev_close is not None and close_price is not None:
            change_amount = close_price - prev_close
            if prev_close != 0:
                pct_change = (change_amount / prev_close) * 100

        if prev_close is not None and prev_close != 0 and high_price is not None and low_price is not None:
            amplitude = ((high_price - low_price) / prev_close) * 100

        bars.append({
            "date": date_text,
            "open": open_price,
            "high": high_price,
            "low": low_price,
            "close": close_price,
            "volume": volume,
            "amount": amount,
            "amplitude": round_optional(amplitude),
            "pctChange": round_optional(pct_change),
            "change": round_optional(change_amount),
            "changeAmount": round_optional(change_amount),
            "turnover": None,
        })

        if close_price is not None:
            prev_close = close_price

    return bars, prev_close


def build_raw_error(request_errors):
    if not request_errors:
        return ""

    parts = []
    for item in request_errors:
        parts.append(
            f"{item.get('startDate', '')}-{item.get('endDate', '')} "
            f"{item.get('url', '')}: {compact_error(item.get('error', ''), 260)}"
        )

    return "\n".join(parts)


def fetch_daily_bars(symbol, start_date, end_date, adjust):
    clear_proxy_env()
    tencent_symbol = get_tencent_symbol(symbol)
    adjust_param = get_adjust_param(adjust)
    request_errors = []
    bars_by_date = {}
    previous_close = None
    selected_keys = []

    for window_start, window_end in build_date_windows(start_date, end_date):
        url = build_request_url(tencent_symbol, window_start, window_end, adjust_param)

        try:
            rows, _, selected_key = fetch_window(tencent_symbol, window_start, window_end, adjust_param)
            window_bars, previous_close = parse_rows(rows, window_start, window_end, previous_close)
            selected_keys.append(selected_key)

            for bar in window_bars:
                bars_by_date[bar["date"]] = bar
        except Exception as error:
            request_errors.append({
                "startDate": window_start,
                "endDate": window_end,
                "url": url,
                "error": str(error),
                "traceback": traceback.format_exc(),
            })
            raw_error = build_raw_error(request_errors)
            raise AltDailyFailure(
                f"备用历史日线源失败：{compact_error(error)}",
                raw_error=raw_error,
                request_errors=request_errors,
            )

    bars = [bars_by_date[date] for date in sorted(bars_by_date.keys())]

    if not bars:
        raw_error = build_raw_error(request_errors) or f"{symbol} {start_date}-{end_date} 备用历史日线源返回空日线"
        raise AltDailyFailure("备用历史日线源失败：返回空日线。", raw_error=raw_error, request_errors=request_errors)

    source_suffix = adjust_param or "bfq"
    selected_key = selected_keys[-1] if selected_keys else "day"
    return bars, f"tencent_fqkline:{source_suffix}:{selected_key}", request_errors


def main():
    clear_proxy_env()

    symbol = normalize_symbol(sys.argv[1] if len(sys.argv) > 1 else "")
    start_date = normalize_date(sys.argv[2] if len(sys.argv) > 2 else "20180101", "20180101")
    end_date = normalize_date(sys.argv[3] if len(sys.argv) > 3 else "", "")
    adjust = str(sys.argv[4] if len(sys.argv) > 4 else "qfq")

    if not end_date:
        end_date = datetime.now().strftime("%Y%m%d")

    bars, source, request_errors = fetch_daily_bars(symbol, start_date, end_date, adjust)

    print(json.dumps({
        "ok": True,
        "source": source,
        "symbol": symbol,
        "networkMode": get_network_mode(),
        "proxyDisabled": True,
        "bars": bars,
        "error": "",
        "traceback": "",
        "rawError": "",
        "requestErrors": request_errors,
    }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        raw_error = getattr(error, "raw_error", "") or str(error)
        print(json.dumps({
            "ok": False,
            "source": "alt_daily",
            "networkMode": get_network_mode(),
            "proxyDisabled": True,
            "bars": [],
            "errorCode": getattr(error, "code", ""),
            "error": str(error),
            "rawError": raw_error,
            "traceback": traceback.format_exc(),
            "requestErrors": getattr(error, "request_errors", []),
        }, ensure_ascii=False))
