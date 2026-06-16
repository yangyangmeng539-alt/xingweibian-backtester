# -*- coding: utf-8 -*-
import os
import time
import traceback
import requests

for k in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]:
    os.environ.pop(k, None)

os.environ["NO_PROXY"] = "*"
os.environ["no_proxy"] = "*"

try:
    import akshare as ak
except Exception as e:
    print("[FAIL] import akshare:", repr(e))
    raise SystemExit(1)

codes = [
    ("920634", "新威凌"),
    ("920642", "通易航天"),
    ("920006", "晟楠科技"),
    ("920169", "七丰精工"),
    ("920505", "九菱科技"),
]

print("========== AKSHARE SINA stock_zh_a_daily ==========")

sina_ok = []

for code, name in codes:
    print("")
    print("----", code, name, "----")

    symbols = [
        f"bj{code}",
        code,
    ]

    hit = False

    for symbol in symbols:
        for adjust in ["", "qfq"]:
            try:
                df = ak.stock_zh_a_daily(
                    symbol=symbol,
                    start_date="20240101",
                    end_date="20260612",
                    adjust=adjust,
                )

                print("[SINA]", symbol, "adjust=", adjust or "none", "rows=", len(df), "columns=", list(df.columns))

                if len(df) > 0:
                    print("[OK][SINA]", code, name, "symbol=", symbol, "adjust=", adjust or "none")
                    print("head=")
                    print(df.head(2).to_string())
                    print("tail=")
                    print(df.tail(2).to_string())
                    sina_ok.append((code, symbol, adjust or "none"))
                    hit = True
                    break
            except Exception as e:
                print("[FAIL][SINA]", symbol, "adjust=", adjust or "none", repr(e))
                print(traceback.format_exc()[:800])

        if hit:
            break

    time.sleep(1.2)

print("")
print("========== SOHU hisHq DIRECT ==========")

session = requests.Session()
session.headers.update({
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0 Safari/537.36",
    "Referer": "https://q.stock.sohu.com/",
    "Accept": "*/*",
    "Connection": "close",
})

sohu_ok = []

for code, name in codes:
    print("")
    print("----", code, name, "----")

    candidates = [
        f"cn_{code}",
        f"bj_{code}",
    ]

    for sohu_code in candidates:
        try:
            r = session.get(
                "https://q.stock.sohu.com/hisHq",
                params={
                    "code": sohu_code,
                    "start": "20240101",
                    "end": "20260612",
                    "stat": "1",
                    "order": "D",
                    "period": "d",
                    "rt": "jsonp",
                },
                timeout=12,
            )

            text = r.text.strip()
            print("[SOHU]", sohu_code, "status=", r.status_code, "text=", text[:220].replace("\n", ""))

            if r.status_code == 200 and "hq" in text and "[]" not in text[:500]:
                print("[OK][SOHU]", code, name, "sohu_code=", sohu_code)
                sohu_ok.append((code, sohu_code))
                break
        except Exception as e:
            print("[FAIL][SOHU]", sohu_code, repr(e))

    time.sleep(1.2)

print("")
print("========== SUMMARY ==========")
print("SINA_OK", sina_ok)
print("SOHU_OK", sohu_ok)

if sina_ok:
    print("[NEXT] 北交所日线优先接 AKShare stock_zh_a_daily / 新浪源")
elif sohu_ok:
    print("[NEXT] 北交所日线接 SOHU hisHq direct")
else:
    print("[NEXT] 新浪和搜狐也失败；北交所个股历史日线需要走 CSV/用户自备源，或做每日收盘后本地累积")
