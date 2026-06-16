import sys
import subprocess

try:
    import baostock as bs
except Exception:
    print("未安装 baostock，开始安装...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "baostock", "-i", "https://pypi.tuna.tsinghua.edu.cn/simple"])
    import baostock as bs

import pandas as pd
import json
from pathlib import Path

OUT_DIR = Path("./data/quality")
OUT_DIR.mkdir(parents=True, exist_ok=True)
OUT_PATH = OUT_DIR / "baostock-a-field-probe-2018.json"

TEST_SYMBOLS = ["600519", "300750", "000001", "688981", "601919"]
START = "2018-01-01"
END = "2026-06-10"

def bs_code(symbol):
    if symbol.startswith("6") or symbol.startswith("9"):
        return "sh." + symbol
    return "sz." + symbol

def to_float(v):
    try:
        if v is None or v == "":
            return None
        return float(v)
    except Exception:
        return None

def summarize(symbol, rows, error=None):
    total = len(rows)

    def positive(field):
        return sum(1 for r in rows if r.get(field) is not None and r.get(field) > 0)

    return {
        "symbol": symbol,
        "source": "baostock",
        "ok": total > 0 and not error,
        "error": error,
        "rows": total,
        "dateStart": rows[0]["date"] if rows else None,
        "dateEnd": rows[-1]["date"] if rows else None,
        "volumePositivePct": round(positive("volume") / total * 100, 4) if total else 0,
        "amountPositivePct": round(positive("amount") / total * 100, 4) if total else 0,
        "turnPositivePct": round(positive("turn") / total * 100, 4) if total else 0,
        "firstRows": rows[:2],
        "lastRows": rows[-2:] if rows else []
    }

report = {
    "start": START,
    "end": END,
    "symbols": [],
    "conclusion": []
}

lg = bs.login()
print("baostock login:", lg.error_code, lg.error_msg)

for symbol in TEST_SYMBOLS:
    print(f"\n=== BaoStock TEST {symbol} ===")

    try:
        rs = bs.query_history_k_data_plus(
            bs_code(symbol),
            "date,code,open,high,low,close,preclose,volume,amount,adjustflag,turn,tradestatus,pctChg,isST",
            start_date=START,
            end_date=END,
            frequency="d",
            adjustflag="2"
        )

        rows = []

        while rs.error_code == "0" and rs.next():
            item = dict(zip(rs.fields, rs.get_row_data()))
            rows.append({
                "symbol": symbol,
                "date": item.get("date"),
                "open": to_float(item.get("open")),
                "high": to_float(item.get("high")),
                "low": to_float(item.get("low")),
                "close": to_float(item.get("close")),
                "preclose": to_float(item.get("preclose")),
                "volume": to_float(item.get("volume")),
                "amount": to_float(item.get("amount")),
                "turn": to_float(item.get("turn")),
                "pctChg": to_float(item.get("pctChg")),
                "tradestatus": item.get("tradestatus"),
                "isST": item.get("isST")
            })

        if rs.error_code != "0":
            item = summarize(symbol, [], f"{rs.error_code}: {rs.error_msg}")
        else:
            item = summarize(symbol, rows)

        report["symbols"].append(item)

        print(json.dumps({
            "symbol": item["symbol"],
            "ok": item["ok"],
            "rows": item["rows"],
            "dateStart": item["dateStart"],
            "dateEnd": item["dateEnd"],
            "volumePositivePct": item["volumePositivePct"],
            "amountPositivePct": item["amountPositivePct"],
            "turnPositivePct": item["turnPositivePct"],
            "error": item["error"],
            "lastRows": item["lastRows"]
        }, ensure_ascii=False, indent=2))

    except Exception as e:
        item = summarize(symbol, [], str(e))
        report["symbols"].append(item)
        print(json.dumps(item, ensure_ascii=False, indent=2))

bs.logout()

ok_items = [x for x in report["symbols"] if x["ok"]]
amount_ok = [x for x in ok_items if x["amountPositivePct"] >= 80]
turn_ok = [x for x in ok_items if x["turnPositivePct"] >= 80]

if len(ok_items) == 0:
    report["conclusion"].append("BaoStock 未跑通，不能作为 A 股重拉源。")
else:
    report["conclusion"].append(f"BaoStock 跑通 {len(ok_items)} / {len(TEST_SYMBOLS)} 个测试股票。")

    if len(amount_ok) >= max(1, int(len(TEST_SYMBOLS) * 0.6)):
        report["conclusion"].append("BaoStock A股 amount 可用，可作为 A股 2018 后重拉字段源。")
    else:
        report["conclusion"].append("BaoStock A股 amount 覆盖不足，不建议作为基础字段源。")

    if len(turn_ok) >= max(1, int(len(TEST_SYMBOLS) * 0.6)):
        report["conclusion"].append("BaoStock A股 turn 可用，可作为 A股 2018 后换手率字段源。")
    else:
        report["conclusion"].append("BaoStock A股 turn 覆盖不足，不建议作为基础字段源。")

OUT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

print("\n=== BaoStock A股字段探针报告已生成 ===")
print(OUT_PATH)

print("\n=== 结论 ===")
for line in report["conclusion"]:
    print("-", line)
