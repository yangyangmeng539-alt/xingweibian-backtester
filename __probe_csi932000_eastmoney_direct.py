# -*- coding: utf-8 -*-
import os
import json
import requests
from datetime import datetime

PROXY_ENV_KEYS = [
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
    "http_proxy", "https_proxy", "all_proxy",
]

for key in PROXY_ENV_KEYS:
    os.environ.pop(key, None)

os.environ["NO_PROXY"] = "*"
os.environ["no_proxy"] = "*"

URL = "https://push2his.eastmoney.com/api/qt/stock/kline/get"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
    "Referer": "https://quote.eastmoney.com/",
    "Accept": "application/json,text/plain,*/*",
    "Connection": "close",
}

SECID_CANDIDATES = [
    "1.932000",
    "0.932000",
    "2.932000",
    "90.932000",
    "100.932000",
]

RANGES = [
    ("20240101", "20240331"),
    ("20240101", "20240131"),
    ("20240201", "20240229"),
    ("20240301", "20240331"),
    ("20250101", "20250331"),
]

def try_one(secid, beg, end):
    params = {
        "secid": secid,
        "fields1": "f1,f2,f3,f4,f5,f6",
        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
        "klt": "101",
        "fqt": "0",
        "beg": beg,
        "end": end,
    }

    try:
        resp = requests.get(URL, params=params, headers=HEADERS, timeout=20)
        text = resp.text[:200].replace("\n", " ").replace("\r", " ")
        print(f"[HTTP] secid={secid} range={beg}-{end} status={resp.status_code} head={text}")

        resp.raise_for_status()
        payload = resp.json()
        data = payload.get("data") or {}
        klines = data.get("klines") or []

        if not klines:
            print(f"[EMPTY] secid={secid} range={beg}-{end} name={data.get('name')} code={data.get('code')}")
            return False

        print(f"[OK] secid={secid} range={beg}-{end} name={data.get('name')} code={data.get('code')} rows={len(klines)}")
        print(f"     first={klines[0]}")
        print(f"     last ={klines[-1]}")
        return True

    except Exception as e:
        print(f"[FAIL] secid={secid} range={beg}-{end} err={repr(e)}")
        return False

ok_hits = []

for secid in SECID_CANDIDATES:
    for beg, end in RANGES:
        ok = try_one(secid, beg, end)
        if ok:
            ok_hits.append((secid, beg, end))

print("")
print("========== SUMMARY ==========")
if ok_hits:
    for secid, beg, end in ok_hits:
        print(f"OK secid={secid} range={beg}-{end}")
else:
    print("NO_DIRECT_EASTMONEY_HIT_FOR_CSI_932000")
