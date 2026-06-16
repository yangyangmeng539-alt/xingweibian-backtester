import json
import os
import sys
import traceback
import contextlib
import io
import time

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
        raise UnsupportedMarketError(f"{UNSUPPORTED_MARKET}: BaoStock A股源不支持港股代码: {value}")

    if not text.isdigit() or len(text) != 6:
        raise ValueError(f"非法 A 股代码: {value}")

    return text


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

        # BaoStock volume 是“股”，项目库里 A股 volume 统一用“手”
        "volume": round_optional(volume_shares / 100, 4) if volume_shares is not None else None,

        "amount": amount,
        "amplitude": amplitude,
        "pctChange": pct_change,
        "changeAmount": change_amount,
        "turnover": turnover,
        "tradestatus": trade_status,
        "isST": str(item.get("isST") or "").strip()
    }

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

def fetch_baostock_daily(symbol, start_date, end_date, adjust):
    import baostock as bs

    last_error = None
    code = get_baostock_code(symbol)

    for attempt in range(1, 6):
        lg = safe_baostock_login(bs)

        if str(lg.error_code) != "0":
            last_error = RuntimeError(f"BaoStock login failed: {lg.error_code} {lg.error_msg}")
            safe_baostock_logout(bs)
            time.sleep(min(8, 1.2 * attempt))
            continue

        try:
            rs = bs.query_history_k_data_plus(
                code,
                "date,code,open,high,low,close,preclose,volume,amount,adjustflag,turn,tradestatus,pctChg,isST",
                start_date=f"{start_date[0:4]}-{start_date[4:6]}-{start_date[6:8]}",
                end_date=f"{end_date[0:4]}-{end_date[4:6]}-{end_date[6:8]}",
                frequency="d",
                adjustflag=get_adjustflag(adjust)
            )

            if str(rs.error_code) in ("10001001", "10002007"):
                last_error = RuntimeError(f"BaoStock query failed: {rs.error_code} {rs.error_msg}")
                safe_baostock_logout(bs)
                time.sleep(min(10, 1.5 * attempt))
                continue

            rows = []

            while rs.error_code == "0" and rs.next():
                item = dict(zip(rs.fields, rs.get_row_data()))
                bar = build_bar(symbol, item)

                if bar:
                    rows.append(bar)

            if str(rs.error_code) != "0":
                last_error = RuntimeError(f"BaoStock query failed: {rs.error_code} {rs.error_msg}")
                safe_baostock_logout(bs)
                time.sleep(min(10, 1.5 * attempt))
                continue

            rows.sort(key=lambda row: row.get("date") or "")
            return rows

        finally:
            safe_baostock_logout(bs)

    raise last_error or RuntimeError("BaoStock query failed after retry")

def main():
    clear_proxy_env()

    symbol = normalize_symbol(sys.argv[1] if len(sys.argv) > 1 else "")

    start_date = normalize_date(sys.argv[2] if len(sys.argv) > 2 else "20180101", "20180101")
    end_date = normalize_date(sys.argv[3] if len(sys.argv) > 3 else "")

    if not end_date:
        from datetime import datetime
        end_date = datetime.now().strftime("%Y%m%d")

    adjust = str(sys.argv[4] if len(sys.argv) > 4 else "qfq").strip() or "qfq"

    bars = fetch_baostock_daily(symbol, start_date, end_date, adjust)

    print(json.dumps({
        "ok": True,
        "symbol": symbol,
        "market": "CN_A",
        "source": "baostock_a_share",
        "bars": bars
    }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except UnsupportedMarketError as error:
        print(json.dumps({
            "ok": False,
            "source": "baostock_a_share",
            "market": "CN_A",
            "errorCode": UNSUPPORTED_MARKET,
            "error": str(error),
            "traceback": traceback.format_exc()
        }, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({
            "ok": False,
            "source": "baostock_a_share",
            "market": "CN_A",
            "error": str(error),
            "traceback": traceback.format_exc()
        }, ensure_ascii=False))