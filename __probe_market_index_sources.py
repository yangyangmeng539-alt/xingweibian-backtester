# -*- coding: utf-8 -*-
import os
import sys
import time
import traceback
from datetime import datetime, timezone

START = "2024-01-01"
END = "2024-03-31"
START_NUM = "20240101"
END_NUM = "20240331"

PROXY_ENV_KEYS = [
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
    "http_proxy", "https_proxy", "all_proxy",
]

def clear_proxy_env():
    for k in PROXY_ENV_KEYS:
        os.environ.pop(k, None)
    os.environ["NO_PROXY"] = "*"
    os.environ["no_proxy"] = "*"

def short_error(e):
    text = str(e).replace("\r", " ").replace("\n", " ").strip()
    if not text:
        text = e.__class__.__name__
    return text[:220]

def row_count(df):
    try:
        return int(len(df))
    except Exception:
        return 0

def last_row_text(df):
    try:
        if len(df) <= 0:
            return ""
        row = df.tail(1).to_dict("records")[0]
        keys = list(row.keys())
        keep = keys[:8]
        return " | ".join([f"{k}={row.get(k)}" for k in keep])
    except Exception as e:
        return short_error(e)

def print_result(source, code, name, ok, rows=0, last="", err=""):
    mark = "OK" if ok else "FAIL"
    print(f"[{mark}] {source} | {code} | {name} | rows={rows}")
    if ok and last:
        print(f"      last: {last}")
    if (not ok) and err:
        print(f"      err : {err}")

INDEXES = [
    {"name": "上证指数", "std": "SH:000001", "bs": ["sh.000001"], "tx": ["sh000001"], "em": ["sh000001"], "ak": ["000001"]},
    {"name": "深证成指", "std": "SZ:399001", "bs": ["sz.399001"], "tx": ["sz399001"], "em": ["sz399001"], "ak": ["399001"]},
    {"name": "创业板指", "std": "SZ:399006", "bs": ["sz.399006"], "tx": ["sz399006"], "em": ["sz399006"], "ak": ["399006"]},
    {"name": "科创50", "std": "SH:000688", "bs": ["sh.000688"], "tx": ["sh000688"], "em": ["sh000688"], "ak": ["000688"]},
    {"name": "北证50", "std": "BJ:899050", "bs": ["bj.899050", "sh.899050"], "tx": ["bj899050", "sh899050"], "em": ["bj899050"], "ak": ["899050"]},
    {"name": "沪深300", "std": "CSI:000300", "bs": ["sh.000300", "sz.399300"], "tx": ["sh000300", "sz399300"], "em": ["csi000300", "sh000300"], "ak": ["000300", "399300"]},
    {"name": "中证500", "std": "CSI:000905", "bs": ["sh.000905", "sz.399905"], "tx": ["sh000905", "sz399905"], "em": ["csi000905", "sh000905"], "ak": ["000905", "399905"]},
    {"name": "中证1000", "std": "CSI:000852", "bs": ["sh.000852", "sz.399852"], "tx": ["sh000852", "sz399852"], "em": ["csi000852", "sh000852"], "ak": ["000852", "399852"]},
    {"name": "中证2000", "std": "CSI:932000", "bs": ["sh.932000"], "tx": ["sh932000"], "em": ["csi932000", "sh932000"], "ak": ["932000"]},
    {"name": "中证全指", "std": "CSI:000985", "bs": ["sh.000985"], "tx": ["sh000985"], "em": ["csi000985", "sh000985"], "ak": ["000985"]},
]

def probe_baostock():
    print("\n========== BaoStock 指数 K 线 ==========")
    try:
        import baostock as bs
    except Exception as e:
        print_result("baostock", "-", "IMPORT", False, err=short_error(e))
        return

    clear_proxy_env()

    lg = None
    try:
        lg = bs.login()
        if str(getattr(lg, "error_code", "")) != "0":
            print_result("baostock", "-", "LOGIN", False, err=f"{lg.error_code} {lg.error_msg}")
            return

        for item in INDEXES:
            success = False
            last_err = ""
            for code in item["bs"]:
                try:
                    rs = bs.query_history_k_data_plus(
                        code,
                        "date,code,open,high,low,close,preclose,volume,amount,pctChg",
                        start_date=START,
                        end_date=END,
                        frequency="d",
                        adjustflag="3"
                    )

                    if str(getattr(rs, "error_code", "")) != "0":
                        last_err = f"{rs.error_code} {rs.error_msg}"
                        continue

                    rows = []
                    while rs.next():
                        rows.append(dict(zip(rs.fields, rs.get_row_data())))

                    if rows:
                        last = rows[-1]
                        last_text = " | ".join([f"{k}={last.get(k)}" for k in list(last.keys())[:8]])
                        print_result("baostock", code, item["name"], True, rows=len(rows), last=last_text)
                        success = True
                        break

                    last_err = "返回 0 行"
                except Exception as e:
                    last_err = short_error(e)

            if not success:
                print_result("baostock", "/".join(item["bs"]), item["name"], False, err=last_err)
    finally:
        try:
            bs.logout()
        except Exception:
            pass

def probe_akshare_index_zh_a_hist():
    print("\n========== AKShare index_zh_a_hist ==========")
    try:
        import akshare as ak
    except Exception as e:
        print_result("ak.index_zh_a_hist", "-", "IMPORT", False, err=short_error(e))
        return

    clear_proxy_env()

    for item in INDEXES:
        success = False
        last_err = ""
        for code in item["ak"]:
            try:
                df = ak.index_zh_a_hist(
                    symbol=code,
                    period="daily",
                    start_date=START_NUM,
                    end_date=END_NUM
                )
                rows = row_count(df)
                if rows > 0:
                    print_result("ak.index_zh_a_hist", code, item["name"], True, rows=rows, last=last_row_text(df))
                    success = True
                    break
                last_err = "返回 0 行"
            except Exception as e:
                last_err = short_error(e)

        if not success:
            print_result("ak.index_zh_a_hist", "/".join(item["ak"]), item["name"], False, err=last_err)

def probe_akshare_stock_zh_index_daily_tx():
    print("\n========== AKShare stock_zh_index_daily_tx 腾讯 ==========")
    try:
        import akshare as ak
    except Exception as e:
        print_result("ak.stock_zh_index_daily_tx", "-", "IMPORT", False, err=short_error(e))
        return

    clear_proxy_env()

    for item in INDEXES:
        success = False
        last_err = ""
        for code in item["tx"]:
            try:
                df = ak.stock_zh_index_daily_tx(symbol=code)
                rows = row_count(df)
                if rows > 0:
                    print_result("ak.stock_zh_index_daily_tx", code, item["name"], True, rows=rows, last=last_row_text(df))
                    success = True
                    break
                last_err = "返回 0 行"
            except Exception as e:
                last_err = short_error(e)

        if not success:
            print_result("ak.stock_zh_index_daily_tx", "/".join(item["tx"]), item["name"], False, err=last_err)

def probe_akshare_stock_zh_index_daily_em():
    print("\n========== AKShare stock_zh_index_daily_em 东方财富 ==========")
    try:
        import akshare as ak
    except Exception as e:
        print_result("ak.stock_zh_index_daily_em", "-", "IMPORT", False, err=short_error(e))
        return

    clear_proxy_env()

    for item in INDEXES:
        success = False
        last_err = ""
        for code in item["em"]:
            try:
                df = ak.stock_zh_index_daily_em(
                    symbol=code,
                    start_date=START_NUM,
                    end_date=END_NUM
                )
                rows = row_count(df)
                if rows > 0:
                    print_result("ak.stock_zh_index_daily_em", code, item["name"], True, rows=rows, last=last_row_text(df))
                    success = True
                    break
                last_err = "返回 0 行"
            except Exception as e:
                last_err = short_error(e)

        if not success:
            print_result("ak.stock_zh_index_daily_em", "/".join(item["em"]), item["name"], False, err=last_err)

def find_hk_index_code(spot, keyword):
    try:
        records = spot.to_dict("records")
    except Exception:
        return None

    for row in records:
        text = " ".join([str(v) for v in row.values()])
        if keyword in text:
            for key in ["代码", "code", "symbol", "指数代码"]:
                if key in row and str(row.get(key)).strip():
                    return str(row.get(key)).strip()
            for v in row.values():
                s = str(v).strip()
                if s and any(ch.isdigit() for ch in s):
                    return s
    return None

def probe_hk_akshare():
    print("\n========== AKShare 港股指数 ==========")
    try:
        import akshare as ak
    except Exception as e:
        print_result("ak.hk_index", "-", "IMPORT", False, err=short_error(e))
        return

    clear_proxy_env()

    try:
        spot = ak.stock_hk_index_spot_em()
        print_result("ak.stock_hk_index_spot_em", "-", "港股指数列表", True, rows=row_count(spot), last=last_row_text(spot))
    except Exception as e:
        print_result("ak.stock_hk_index_spot_em", "-", "港股指数列表", False, err=short_error(e))
        return

    targets = [
        ("HK:HSI", "恒生指数", "恒生指数"),
        ("HK:HSTECH", "恒生科技指数", "恒生科技"),
    ]

    for std, name, keyword in targets:
        code = find_hk_index_code(spot, keyword)
        if not code:
            print_result("ak.stock_hk_index_daily_em", std, name, False, err="spot 列表里没找到代码")
            continue

        try:
            df = ak.stock_hk_index_daily_em(symbol=code)
            rows = row_count(df)
            if rows > 0:
                print_result("ak.stock_hk_index_daily_em", code, name, True, rows=rows, last=last_row_text(df))
            else:
                print_result("ak.stock_hk_index_daily_em", code, name, False, err="返回 0 行")
        except Exception as e:
            print_result("ak.stock_hk_index_daily_em", code, name, False, err=short_error(e))

if __name__ == "__main__":
    print("Python:", sys.executable)
    print("Range :", START, "=>", END)
    probe_baostock()
    probe_akshare_index_zh_a_hist()
    probe_akshare_stock_zh_index_daily_tx()
    probe_akshare_stock_zh_index_daily_em()
    probe_hk_akshare()
