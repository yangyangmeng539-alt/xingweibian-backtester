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

codes = [
    "932000",   # 中证2000
    "000852",   # 中证1000，对照
    "000905",   # 中证500，对照
    "000300",   # 沪深300，对照
]

for code in codes:
    print("")
    print("========== TEST", code, "==========")
    try:
        df = ak.stock_zh_index_hist_csindex(
            symbol=code,
            start_date="20240101",
            end_date="20240331"
        )
        print("[OK]", code, "rows=", len(df))
        print("columns=", list(df.columns))
        if len(df) > 0:
            print("head=")
            print(df.head(3).to_string())
            print("tail=")
            print(df.tail(3).to_string())
    except Exception as e:
        print("[FAIL]", code, repr(e))
        print(traceback.format_exc()[:1000])
