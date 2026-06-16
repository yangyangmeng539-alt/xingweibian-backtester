# -*- coding: utf-8 -*-
import os
import json
import time
import traceback
import requests

for k in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]:
    os.environ.pop(k, None)

os.environ["NO_PROXY"] = "*"
os.environ["no_proxy"] = "*"

session = requests.Session()
session.headers.update({
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
    "Referer": "https://quote.eastmoney.com/",
    "Accept": "*/*",
    "Connection": "close",
})

codes = [
    ("920634", "新威凌"),
    ("920642", "通易航天"),
    ("920006", "晟楠科技"),
    ("920169", "七丰精工"),
    ("920505", "九菱科技"),
]

def test_eastmoney(code, name):
    print("")
    print("========== EASTMONEY", code, name, "==========")

    secids = [
        f"0.{code}",
        f"1.{code}",
        f"2.{code}",
        f"80.{code}",
        f"81.{code}",
        f"82.{code}",
        f"83.{code}",
        f"90.{code}",
        f"100.{code}",
    ]

    url = "https://push2his.eastmoney.com/api/qt/stock/kline/get"

    for secid in secids:
        params = {
            "secid": secid,
            "fields1": "f1,f2,f3,f4,f5,f6",
            "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
            "klt": "101",
            "fqt": "0",
            "beg": "20240101",
            "end": "20260612",
            "_": str(int(time.time() * 1000)),
        }

        try:
            r = session.get(url, params=params, timeout=12)
            text = r.text[:300]
            print("[EM]", secid, "status=", r.status_code, "text=", text.replace("\n", "")[:180])

            if r.status_code != 200:
                continue

            data = r.json()
            klines = (((data or {}).get("data") or {}).get("klines") or [])
            if klines:
                print("[OK][EM]", code, name, "secid=", secid, "rows=", len(klines))
                print("first=", klines[0])
                print("last =", klines[-1])
                return True
        except Exception as e:
            print("[FAIL][EM]", secid, repr(e))

    return False

def test_tencent(code, name):
    print("")
    print("========== TENCENT", code, name, "==========")

    symbols = [
        f"bj{code}",
        f"sz{code}",
        f"sh{code}",
    ]

    url = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"

    for symbol in symbols:
        params = {
            "param": f"{symbol},day,2024-01-01,2026-06-12,800,qfq",
            "_var": f"kline_dayqfq_{symbol}",
        }

        try:
            r = session.get(url, params=params, timeout=12, headers={
                "User-Agent": session.headers["User-Agent"],
                "Referer": "https://gu.qq.com/",
                "Accept": "*/*",
                "Connection": "close",
            })
            text = r.text[:300]
            print("[TX]", symbol, "status=", r.status_code, "text=", text.replace("\n", "")[:180])

            if r.status_code != 200:
                continue

            raw = r.text
            if "=" in raw:
                raw = raw.split("=", 1)[1].strip()
            if raw.endswith(";"):
                raw = raw[:-1]

            data = json.loads(raw)
            node = (((data or {}).get("data") or {}).get(symbol) or {})
            day = node.get("qfqday") or node.get("day") or []

            if day:
                print("[OK][TX]", code, name, "symbol=", symbol, "rows=", len(day))
                print("first=", day[0])
                print("last =", day[-1])
                return True
        except Exception as e:
            print("[FAIL][TX]", symbol, repr(e))
            print(traceback.format_exc()[:600])

    return False

em_ok = []
tx_ok = []

for code, name in codes:
    if test_eastmoney(code, name):
        em_ok.append(code)
    if test_tencent(code, name):
        tx_ok.append(code)

print("")
print("========== SUMMARY ==========")
print("EASTMONEY_OK", em_ok)
print("TENCENT_OK", tx_ok)

if em_ok:
    print("[NEXT] 北交所日线优先接 EastMoney push2his direct")
elif tx_ok:
    print("[NEXT] 北交所日线优先接 Tencent fqkline direct")
else:
    print("[NEXT] 两个直连源都失败，需要继续测新浪 / 网易 / 交易所文件源")
