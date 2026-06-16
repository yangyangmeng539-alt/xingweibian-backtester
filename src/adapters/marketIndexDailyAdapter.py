# -*- coding: utf-8 -*-
"""
形位变指数日线适配器。

策略：
1. 腾讯指数接口 stock_zh_index_daily_tx 为主源；
2. 东方财富指数接口 stock_zh_index_daily_em 为补源；
3. BaoStock 指数 K 线为保底。

只输出 JSON，不写数据库。
"""

import argparse
import json
import os
import sys
import time
import traceback
from datetime import datetime, timedelta
import urllib.parse
import urllib.request

PROXY_ENV_KEYS = [
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
    "http_proxy", "https_proxy", "all_proxy",
]


def clear_proxy_env():
    for key in PROXY_ENV_KEYS:
        os.environ.pop(key, None)
    os.environ["NO_PROXY"] = "*"
    os.environ["no_proxy"] = "*"


def normalize_date(value):
    text = str(value or "").strip()
    if not text:
        return ""
    if len(text) == 8 and text.isdigit():
        return f"{text[0:4]}-{text[4:6]}-{text[6:8]}"
    return text[:10]


def date_to_num(value):
    text = normalize_date(value)
    if not text:
        return ""
    return text.replace("-", "")

def parse_date(value):
    text = normalize_date(value)
    if not text:
        return None
    return datetime.strptime(text, "%Y-%m-%d")


def format_num_date(dt):
    return dt.strftime("%Y%m%d")


def iter_date_chunks(start_date, end_date, chunk_days=120):
    start_dt = parse_date(start_date)
    end_dt = parse_date(end_date)

    if not start_dt or not end_dt:
        yield date_to_num(start_date), date_to_num(end_date)
        return

    current = start_dt

    while current <= end_dt:
        chunk_end = min(current + timedelta(days=chunk_days - 1), end_dt)
        yield format_num_date(current), format_num_date(chunk_end)
        current = chunk_end + timedelta(days=1)

def normalize_number(value):
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def row_get(row, keys):
    for key in keys:
        if key in row:
            return row.get(key)
    return None


def rows_from_df(df):
    if df is None:
        return []
    try:
        return df.to_dict("records")
    except Exception:
        return []


def normalize_records(records, index_code, index_name, source, start_date="", end_date=""):
    start_iso = normalize_date(start_date)
    end_iso = normalize_date(end_date)
    output = []
    previous_close = None

    for row in records:
        if not isinstance(row, dict):
            continue

        trade_date = normalize_date(row_get(row, ["date", "日期", "trade_date", "时间"]))
        if not trade_date:
            continue

        open_value = normalize_number(row_get(row, ["open", "开盘", "开盘价"]))
        high_value = normalize_number(row_get(row, ["high", "最高", "最高价"]))
        low_value = normalize_number(row_get(row, ["low", "最低", "最低价"]))
        close_value = normalize_number(row_get(row, ["close", "收盘", "收盘价"]))

        volume_value = normalize_number(row_get(row, ["volume", "成交量", "vol"]))
        amount_value = normalize_number(row_get(row, ["amount", "成交额", "成交金额"]))

        amplitude_value = normalize_number(row_get(row, ["amplitude", "振幅"]))
        pct_change_value = normalize_number(row_get(row, ["pct_change", "涨跌幅", "涨跌幅%", "pctChg"]))
        change_amount_value = normalize_number(row_get(row, ["change_amount", "涨跌额", "涨跌", "change"]))
        turnover_value = normalize_number(row_get(row, ["turnover", "换手率"]))

        if pct_change_value is None and previous_close not in (None, 0) and close_value is not None:
            pct_change_value = (close_value - previous_close) / previous_close * 100

        if change_amount_value is None and previous_close is not None and close_value is not None:
            change_amount_value = close_value - previous_close

        if close_value is not None:
            previous_close = close_value

        if start_iso and trade_date < start_iso:
            continue

        if end_iso and trade_date > end_iso:
            continue

        output.append({
            "indexCode": index_code,
            "indexName": index_name,
            "date": trade_date,
            "open": open_value,
            "high": high_value,
            "low": low_value,
            "close": close_value,
            "volume": volume_value,
            "amount": amount_value,
            "amplitude": amplitude_value,
            "pctChange": pct_change_value,
            "changeAmount": change_amount_value,
            "turnover": turnover_value,
            "source": source,
        })

    return output


def fetch_tx(args):
    if not args.tx_symbol:
        raise RuntimeError("TX_SYMBOL_EMPTY")

    import akshare as ak

    df = ak.stock_zh_index_daily_tx(symbol=args.tx_symbol)
    bars = normalize_records(
        rows_from_df(df),
        args.index_code,
        args.index_name,
        "akshare_stock_zh_index_daily_tx",
        args.start_date,
        args.end_date,
    )
    if not bars:
        raise RuntimeError("TX_EMPTY_BARS")
    return bars


def fetch_em(args):
    if not args.em_symbol:
        raise RuntimeError("EM_SYMBOL_EMPTY")

    import akshare as ak

    all_rows = []
    last_error = None

    # 东方财富指数接口长区间容易 RemoteDisconnected。
    # 这里固定分段拉取，尤其用于 CSI:932000 中证2000。
    chunk_days = int(getattr(args, "em_chunk_days", 120) or 120)

    for chunk_start, chunk_end in iter_date_chunks(args.start_date, args.end_date, chunk_days=chunk_days):
        chunk_ok = False

        for attempt in range(1, 4):
            try:
                df = ak.stock_zh_index_daily_em(
                    symbol=args.em_symbol,
                    start_date=chunk_start,
                    end_date=chunk_end,
                )
                rows = rows_from_df(df)

                if rows:
                    all_rows.extend(rows)

                chunk_ok = True
                break
            except Exception as error:
                last_error = error
                time.sleep(0.8 * attempt)

        if not chunk_ok:
            raise RuntimeError(f"EM_CHUNK_FAILED {chunk_start}-{chunk_end}: {compact_error(last_error)}")

        time.sleep(0.12)

    bars = normalize_records(
        all_rows,
        args.index_code,
        args.index_name,
        "akshare_stock_zh_index_daily_em",
        args.start_date,
        args.end_date,
    )

    # 去重，避免分段边界重复
    dedup = {}
    for bar in bars:
        dedup[bar["date"]] = bar

    bars = [dedup[key] for key in sorted(dedup.keys())]

    if not bars:
        raise RuntimeError("EM_EMPTY_BARS")

    return bars

def fetch_hk_tencent(args):
    if not getattr(args, "hk_tx_symbol", ""):
        raise RuntimeError("HK_TENCENT_SYMBOL_EMPTY")

    symbol = str(args.hk_tx_symbol).strip()

    # 腾讯这个接口不要把整个 param quote 掉；
    # 只 quote symbol，逗号保持原样，和探源脚本一致。
    # 先尝试大数量，失败再回落到已验证可用的 320。
    rows = []
    last_error = None

    for count in [5000, 2000, 1000, 320]:
        try:
            url = (
                "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"
                f"?param={urllib.parse.quote(symbol)},day,,,{count},qfq"
            )

            req = urllib.request.Request(
                url,
                headers={
                    "User-Agent": "Mozilla/5.0",
                    "Accept": "application/json,text/plain,*/*",
                    "Referer": "https://gu.qq.com/",
                },
            )

            with urllib.request.urlopen(req, timeout=30) as response:
                payload = json.loads(response.read().decode("utf-8", errors="replace"))

            data = payload.get("data") or {}
            item = data.get(symbol) or {}
            rows = item.get("qfqday") or item.get("day") or []

            if rows:
                break
        except Exception as error:
            last_error = error

        time.sleep(0.15)

    if not rows:
        if last_error:
            raise RuntimeError(f"HK_TENCENT_EMPTY_BARS: {compact_error(last_error)}")
        raise RuntimeError("HK_TENCENT_EMPTY_BARS")

    records = []

    for row in rows:
        if not isinstance(row, list) or len(row) < 5:
            continue

        records.append({
            "date": row[0],
            "open": row[1],
            "close": row[2],
            "high": row[3],
            "low": row[4],
            "amount": row[5] if len(row) > 5 else None,
        })

    bars = normalize_records(
        records,
        args.index_code,
        args.index_name,
        "tencent_hk_index_fqkline",
        args.start_date,
        args.end_date,
    )

    if not bars:
        raise RuntimeError("HK_TENCENT_EMPTY_BARS")

    return bars

def fetch_csindex(args):
    if not args.csindex_symbol:
        raise RuntimeError("CSINDEX_SYMBOL_EMPTY")

    import akshare as ak

    df = ak.stock_zh_index_hist_csindex(
        symbol=args.csindex_symbol,
        start_date=date_to_num(args.start_date),
        end_date=date_to_num(args.end_date),
    )

    records = rows_from_df(df)

    bars = normalize_records(
        records,
        args.index_code,
        args.index_name,
        "akshare_stock_zh_index_hist_csindex",
        args.start_date,
        args.end_date,
    )

    dedup = {}
    for bar in bars:
        dedup[bar["date"]] = bar

    bars = [dedup[key] for key in sorted(dedup.keys())]

    if not bars:
        raise RuntimeError("CSINDEX_EMPTY_BARS")

    return bars

def fetch_baostock(args):
    if not args.bs_symbol:
        raise RuntimeError("BAOSTOCK_SYMBOL_EMPTY")

    import baostock as bs

    login = bs.login()
    if str(getattr(login, "error_code", "")) != "0":
        raise RuntimeError(f"BAOSTOCK_LOGIN_FAIL: {login.error_code} {login.error_msg}")

    try:
        rs = bs.query_history_k_data_plus(
            args.bs_symbol,
            "date,code,open,high,low,close,preclose,volume,amount,pctChg",
            start_date=normalize_date(args.start_date),
            end_date=normalize_date(args.end_date),
            frequency="d",
            adjustflag="3",
        )
        if str(getattr(rs, "error_code", "")) != "0":
            raise RuntimeError(f"BAOSTOCK_QUERY_FAIL: {rs.error_code} {rs.error_msg}")

        records = []
        while rs.next():
            records.append(dict(zip(rs.fields, rs.get_row_data())))

        bars = normalize_records(
            records,
            args.index_code,
            args.index_name,
            "baostock_index_fallback",
            args.start_date,
            args.end_date,
        )
        if not bars:
            raise RuntimeError("BAOSTOCK_EMPTY_BARS")
        return bars
    finally:
        try:
            bs.logout()
        except Exception:
            pass


def compact_error(error):
    text = str(error).replace("\r", " ").replace("\n", " ").strip()
    if not text:
        text = error.__class__.__name__
    return text[:260]


def run(args):
    clear_proxy_env()
    attempts = []

    fetchers = []

    if getattr(args, "hk_tx_symbol", ""):
        fetchers.append(("hk_tencent", fetch_hk_tencent))

    fetchers.extend([
        ("tx", fetch_tx),
        ("csindex", fetch_csindex),
        ("em", fetch_em),
        ("baostock", fetch_baostock),
    ])

    if args.prefer_source:
        preferred = []
        others = []
        for name, fn in fetchers:
            if name == args.prefer_source:
                preferred.append((name, fn))
            else:
                others.append((name, fn))
        fetchers = preferred + others

    for source_name, fetcher in fetchers:
        try:
            bars = fetcher(args)
            return {
                "ok": True,
                "indexCode": args.index_code,
                "indexName": args.index_name,
                "source": bars[0].get("source") if bars else source_name,
                "barCount": len(bars),
                "startDate": bars[0].get("date") if bars else "",
                "endDate": bars[-1].get("date") if bars else "",
                "bars": bars,
                "attempts": attempts + [{"source": source_name, "ok": True, "rows": len(bars)}],
            }
        except Exception as error:
            attempts.append({"source": source_name, "ok": False, "error": compact_error(error)})

    return {
        "ok": False,
        "indexCode": args.index_code,
        "indexName": args.index_name,
        "error": "INDEX_DAILY_FETCH_FAILED",
        "attempts": attempts,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--index-code", required=True)
    parser.add_argument("--index-name", required=True)
    parser.add_argument("--start-date", required=True)
    parser.add_argument("--end-date", required=True)
    parser.add_argument("--tx-symbol", default="")
    parser.add_argument("--em-symbol", default="")
    parser.add_argument("--csindex-symbol", default="")
    parser.add_argument("--bs-symbol", default="")
    parser.add_argument("--hk-tx-symbol", default="")
    parser.add_argument("--prefer-source", default="")
    parser.add_argument("--em-chunk-days", type=int, default=120)
    args = parser.parse_args()

    try:
        result = run(args)
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result.get("ok") else 2
    except Exception as error:
        print(json.dumps({
            "ok": False,
            "error": str(error),
            "traceback": traceback.format_exc(),
        }, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())