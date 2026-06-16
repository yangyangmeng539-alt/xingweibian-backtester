import json
import os
import sys
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

UNSUPPORTED_MARKET = "UNSUPPORTED_MARKET"
SOURCE_NAME = "bj_sina_daily"


class UnsupportedMarketError(ValueError):
    def __init__(self, message):
        self.code = UNSUPPORTED_MARKET
        super().__init__(message)


def clear_proxy_env():
    for key in PROXY_ENV_KEYS:
        os.environ.pop(key, None)

    os.environ["NO_PROXY"] = "*"
    os.environ["no_proxy"] = "*"


def normalize_symbol(value):
    text = str(value or "").strip().upper()

    if text.startswith("HK:") or text.endswith(".HK") or text.startswith("HK"):
        raise UnsupportedMarketError(f"{UNSUPPORTED_MARKET}: 北交所新浪源不支持港股代码: {value}")

    digits = "".join(ch for ch in text if ch.isdigit())

    if len(digits) != 6:
        raise ValueError(f"非法 A股代码: {value}")

    return digits


def is_bj_market_symbol(symbol):
    text = str(symbol or "").strip()
    return text.startswith(("8", "4")) or text.startswith("920")


def normalize_date(value, fallback=""):
    text = str(value or fallback or "").strip().replace("-", "")

    if len(text) == 8 and text.isdigit():
        return text

    return ""


def compact_date(value):
    return str(value or "").strip().replace("-", "")[:8]


def to_iso_date(value):
    text = compact_date(value)

    if len(text) == 8 and text.isdigit():
        return f"{text[0:4]}-{text[4:6]}-{text[6:8]}"

    return ""


def to_float(value):
    if value is None:
        return None

    text = str(value).strip().replace(",", "")

    if text == "" or text.lower() == "nan" or text in ("--", "-"):
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


def build_bar(symbol, row, previous_close=None):
    date = to_iso_date(row.get("date"))
    open_price = to_float(row.get("open"))
    high_price = to_float(row.get("high"))
    low_price = to_float(row.get("low"))
    close_price = to_float(row.get("close"))
    volume_shares = to_float(row.get("volume"))
    amount = to_float(row.get("amount"))
    turnover_raw = to_float(row.get("turnover"))

    if not date:
        return None

    if (
        open_price is None
        or high_price is None
        or low_price is None
        or close_price is None
        or open_price <= 0
        or high_price <= 0
        or low_price <= 0
        or close_price <= 0
    ):
        return None

    pct_change = None
    change_amount = None
    amplitude = None

    if previous_close is not None and previous_close > 0:
        change_amount = round_optional(close_price - previous_close, 4)
        pct_change = round_optional((close_price - previous_close) / previous_close * 100, 4)
        amplitude = round_optional((high_price - low_price) / previous_close * 100, 4)

    return {
        "symbol": symbol,
        "date": date,
        "open": open_price,
        "close": close_price,
        "high": high_price,
        "low": low_price,

        # 新浪北交所 volume 是“股”；项目 daily_bars 里 A 股 volume 统一按“手”存。
        "volume": round_optional(volume_shares / 100, 4) if volume_shares is not None else None,

        "amount": amount,
        "amplitude": amplitude,
        "pctChange": pct_change,
        "changeAmount": change_amount,

        # 新浪 turnover 是小数，例如 0.174929 = 17.4929%。
        "turnover": round_optional(turnover_raw * 100, 4) if turnover_raw is not None else None,

        "tradestatus": "1",
        "isST": "",
    }


def fetch_bj_sina_daily(symbol, start_date, end_date):
    if not is_bj_market_symbol(symbol):
        raise UnsupportedMarketError(f"{UNSUPPORTED_MARKET}: 北交所新浪源只支持 BJ/北交所代码: {symbol}")

    import akshare as ak

    df = ak.stock_zh_a_daily(
        symbol=f"bj{symbol}",
        start_date=start_date,
        end_date=end_date,
        adjust="",
    )

    if df is None or df.empty:
        return []

    records = df.to_dict("records")
    records.sort(key=lambda row: compact_date(row.get("date")))

    rows = []
    previous_close = None

    for row in records:
        trade_date = compact_date(row.get("date"))

        if start_date and trade_date < start_date:
            continue

        if end_date and trade_date > end_date:
            continue

        bar = build_bar(symbol, row, previous_close)

        close_price = to_float(row.get("close"))
        if close_price is not None and close_price > 0:
            previous_close = close_price

        if bar:
            rows.append(bar)

    rows.sort(key=lambda row: row.get("date") or "")
    return rows


def main():
    clear_proxy_env()

    symbol = normalize_symbol(sys.argv[1] if len(sys.argv) > 1 else "")
    start_date = normalize_date(sys.argv[2] if len(sys.argv) > 2 else "20180101", "20180101")
    end_date = normalize_date(sys.argv[3] if len(sys.argv) > 3 else "")

    if not end_date:
        end_date = datetime.now().strftime("%Y%m%d")

    bars = fetch_bj_sina_daily(symbol, start_date, end_date)

    print(json.dumps({
        "ok": True,
        "symbol": symbol,
        "source": SOURCE_NAME,
        "bars": bars,
        "count": len(bars),
    }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except UnsupportedMarketError as error:
        print(json.dumps({
            "ok": False,
            "source": SOURCE_NAME,
            "errorCode": UNSUPPORTED_MARKET,
            "error": str(error),
            "traceback": traceback.format_exc(),
        }, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({
            "ok": False,
            "source": SOURCE_NAME,
            "error": str(error),
            "traceback": traceback.format_exc(),
        }, ensure_ascii=False))