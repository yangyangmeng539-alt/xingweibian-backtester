# -*- coding: utf-8 -*-
import os
import traceback

for k in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]:
    os.environ.pop(k, None)

os.environ["NO_PROXY"] = "*"
os.environ["no_proxy"] = "*"

try:
    import akshare as ak
except Exception as e:
    print("[FAIL] import akshare:", repr(e))
    raise SystemExit(1)

print("========== BJ LIST ==========")
try:
    bj = ak.stock_bj_a_spot_em()
    print("[OK] stock_bj_a_spot_em rows=", len(bj))
    print("columns=", list(bj.columns))
    print(bj.head(10).to_string())
except Exception as e:
    print("[FAIL] stock_bj_a_spot_em:", repr(e))
    print(traceback.format_exc()[:1200])
    raise SystemExit(1)

codes = []
for _, row in bj.head(12).iterrows():
    code = str(row.get("代码", "")).strip()
    name = str(row.get("名称", "")).strip()
    if code:
        codes.append((code, name))

print("")
print("========== BJ DAILY TEST ==========")

for code, name in codes:
    print("")
    print("----", code, name, "----")
    try:
        df = ak.stock_zh_a_hist(
            symbol=code,
            period="daily",
            start_date="20240101",
            end_date="20260612",
            adjust=""
        )
        print("[OK]", code, name, "rows=", len(df))
        print("columns=", list(df.columns))
        if len(df) > 0:
            print(df.head(2).to_string())
            print(df.tail(2).to_string())
    except Exception as e:
        print("[FAIL]", code, name, repr(e))
        print(traceback.format_exc()[:1200])
