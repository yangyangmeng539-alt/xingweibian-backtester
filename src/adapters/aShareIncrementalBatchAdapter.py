import contextlib
import io
import json
import os
import sys
import time
import traceback
from datetime import datetime, timedelta


PROXY_ENV_KEYS = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
]

UNSUPPORTED_MARKET = "UNSUPPORTED_MARKET"


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
        raise UnsupportedMarketError(f"{UNSUPPORTED_MARKET}: A股批量日更不支持港股代码: {value}")

    digits = "".join(ch for ch in text if ch.isdigit())

    if not digits or len(digits) > 6:
        raise ValueError(f"非法 A股代码: {value}")

    return digits.zfill(6)


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

def compact_date(value):
    return str(value or "").strip().replace("-", "")[:8]


def shift_compact_date_days(value, days):
    text = compact_date(value)

    if len(text) != 8 or not text.isdigit():
        return ""

    try:
        date_value = datetime.strptime(text, "%Y%m%d")
        return (date_value + timedelta(days=days)).strftime("%Y%m%d")
    except Exception:
        return ""


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


def get_baostock_code(symbol):
    if symbol.startswith("6"):
        return f"sh.{symbol}"

    if symbol.startswith(("0", "3")):
        return f"sz.{symbol}"

    if is_bj_market_symbol(symbol):
        raise UnsupportedMarketError(f"{UNSUPPORTED_MARKET}: BaoStock 暂不支持 BJ/北交所市场代码: {symbol}")

    raise UnsupportedMarketError(f"{UNSUPPORTED_MARKET}: BaoStock 暂不支持该 A股市场代码: {symbol}")


def get_adjustflag(adjust):
    text = str(adjust or "qfq").strip().lower()

    # BaoStock: 1 后复权，2 前复权，3 不复权
    if text in ("hfq", "1"):
        return "1"

    if text in ("", "none", "bfq", "3"):
        return "3"

    return "2"


def build_bar(symbol, item):
    trade_status = str(item.get("tradestatus") or "").strip()

    if trade_status and trade_status != "1":
        return None

    date = to_iso_date(item.get("date"))
    open_price = to_float(item.get("open"))
    high_price = to_float(item.get("high"))
    low_price = to_float(item.get("low"))
    close_price = to_float(item.get("close"))
    preclose = to_float(item.get("preclose"))
    volume_shares = to_float(item.get("volume"))
    amount = to_float(item.get("amount"))
    turnover = to_float(item.get("turn"))
    pct_change = to_float(item.get("pctChg"))

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

    change_amount = None
    if preclose is not None:
        change_amount = round_optional(close_price - preclose, 4)

    amplitude = None
    if preclose is not None and preclose > 0:
        amplitude = round_optional((high_price - low_price) / preclose * 100, 4)

    return {
        "symbol": symbol,
        "date": date,
        "open": open_price,
        "close": close_price,
        "high": high_price,
        "low": low_price,
        "volume": round_optional(volume_shares / 100, 4) if volume_shares is not None else None,
        "amount": amount,
        "amplitude": amplitude,
        "pctChange": pct_change,
        "changeAmount": change_amount,
        "turnover": turnover,
        "tradestatus": trade_status,
        "isST": str(item.get("isST") or "").strip()
    }

def build_bj_sina_bar(symbol, row, previous_close=None):
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

        # 新浪北交所 volume 是“股”；daily_bars 统一按“手”存。
        "volume": round_optional(volume_shares / 100, 4) if volume_shares is not None else None,

        "amount": amount,
        "amplitude": amplitude,
        "pctChange": pct_change,
        "changeAmount": change_amount,

        # 新浪 turnover 是小数，例如 0.174929 = 17.4929%。
        "turnover": round_optional(turnover_raw * 100, 4) if turnover_raw is not None else None,

        "tradestatus": "1",
        "isST": ""
    }


def fetch_bj_sina_daily(symbol, start_date, end_date):
    import akshare as ak

    # 增量第一天需要前收盘价，所以向前多取 20 天，只入库 start_date 之后的数据。
    request_start_date = shift_compact_date_days(start_date, -20) or start_date

    df = ak.stock_zh_a_daily(
        symbol=f"bj{symbol}",
        start_date=request_start_date,
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

        bar = build_bj_sina_bar(symbol, row, previous_close)

        close_price = to_float(row.get("close"))
        if close_price is not None and close_price > 0:
            previous_close = close_price

        if not bar:
            continue

        if start_date and trade_date < start_date:
            continue

        if end_date and trade_date > end_date:
            continue

        rows.append(bar)

    rows.sort(key=lambda row: row.get("date") or "")
    return rows


def safe_baostock_login(bs):
    buffer = io.StringIO()

    with contextlib.redirect_stdout(buffer):
        return bs.login()


def safe_baostock_logout(bs):
    try:
        buffer = io.StringIO()

        with contextlib.redirect_stdout(buffer):
            bs.logout()
    except Exception:
        pass


def login_baostock():
    import baostock as bs

    last_error = None

    for attempt in range(1, 6):
        lg = safe_baostock_login(bs)

        if str(lg.error_code) == "0":
            return bs

        last_error = RuntimeError(f"BaoStock login failed: {lg.error_code} {lg.error_msg}")
        safe_baostock_logout(bs)
        time.sleep(min(8, 1.2 * attempt))

    raise last_error or RuntimeError("BaoStock login failed after retry")


def fetch_one_with_login(bs, symbol, start_date, end_date, adjust):
    code = get_baostock_code(symbol)

    rs = bs.query_history_k_data_plus(
        code,
        "date,code,open,high,low,close,preclose,volume,amount,adjustflag,turn,tradestatus,pctChg,isST",
        start_date=f"{start_date[0:4]}-{start_date[4:6]}-{start_date[6:8]}",
        end_date=f"{end_date[0:4]}-{end_date[4:6]}-{end_date[6:8]}",
        frequency="d",
        adjustflag=get_adjustflag(adjust)
    )

    rows = []

    while rs.error_code == "0" and rs.next():
        item = dict(zip(rs.fields, rs.get_row_data()))
        bar = build_bar(symbol, item)

        if bar:
            rows.append(bar)

    if str(rs.error_code) != "0":
        raise RuntimeError(f"BaoStock query failed: {rs.error_code} {rs.error_msg}")

    rows.sort(key=lambda row: row.get("date") or "")
    return rows


def fetch_one(bs, symbol, start_date, end_date, adjust):
    normalized = normalize_symbol(symbol)

    try:
        if is_bj_market_symbol(normalized):
            bars = fetch_bj_sina_daily(normalized, start_date, end_date)

            return {
                "symbol": normalized,
                "ok": True,
                "source": "bj_sina_daily_batch_incremental",
                "bars": bars,
                "error": ""
            }

        bars = fetch_one_with_login(bs, normalized, start_date, end_date, adjust)

        return {
            "symbol": normalized,
            "ok": True,
            "source": "baostock_a_share_batch_incremental",
            "bars": bars,
            "error": ""
        }
    except UnsupportedMarketError as error:
        return {
            "symbol": normalized,
            "ok": False,
            "source": "baostock_a_share_batch_incremental",
            "bars": [],
            "errorCode": UNSUPPORTED_MARKET,
            "error": str(error)
        }
    except Exception as error:
        return {
            "symbol": normalized,
            "ok": False,
            "source": "bj_sina_daily_batch_incremental" if is_bj_market_symbol(normalized) else "baostock_a_share_batch_incremental",
            "bars": [],
            "error": str(error)
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

    start_date = normalize_date(payload.get("startDate"), "20180101") or "20180101"
    end_date = normalize_date(payload.get("endDate"), "")

    if not end_date:
        from datetime import datetime
        end_date = datetime.now().strftime("%Y%m%d")

    adjust = str(payload.get("adjust") or "qfq").strip() or "qfq"

    clean_symbols = []
    seen = set()

    for item in symbols:
        code = normalize_symbol(item)

        if code in seen:
            continue

        seen.add(code)
        clean_symbols.append(code)

    return {
        "symbols": clean_symbols,
        "startDate": start_date,
        "endDate": end_date,
        "adjust": adjust
    }


def main():
    clear_proxy_env()
    payload = read_payload()
    results = []

    needs_baostock = any(not is_bj_market_symbol(symbol) for symbol in payload["symbols"])
    bs = login_baostock() if needs_baostock else None

    try:
        for symbol in payload["symbols"]:
            results.append(fetch_one(
                bs,
                symbol,
                payload["startDate"],
                payload["endDate"],
                payload["adjust"]
            ))

            if is_bj_market_symbol(symbol):
                time.sleep(0.35)
    finally:
        if bs is not None:
            safe_baostock_logout(bs)

    ok_count = sum(1 for item in results if item.get("ok"))
    failed_count = len(results) - ok_count
    bar_count = sum(len(item.get("bars") or []) for item in results)

    print(json.dumps({
        "ok": True,
        "market": "CN_A",
        "source": "a_share_batch_incremental_mixed_baostock_bj_sina",
        "startDate": payload["startDate"],
        "endDate": payload["endDate"],
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
            "market": "CN_A",
            "source": "a_share_batch_incremental_mixed_baostock_bj_sina",
            "error": str(error),
            "traceback": traceback.format_exc()
        }, ensure_ascii=False))