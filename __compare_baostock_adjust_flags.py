import subprocess
import sys
import json
import sqlite3

def run_adapter(adjust):
    p = subprocess.run(
        [
            sys.executable,
            "./src/adapters/baostockAshareDailyAdapter.py",
            "600519",
            "20180101",
            "20260610",
            adjust
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE
    )

    text = p.stdout.decode("utf-8", errors="ignore")
    start = text.find("{")
    end = text.rfind("}")
    data = json.loads(text[start:end + 1])
    bars = data.get("bars") or []

    return {
        "adjust": adjust,
        "rows": len(bars),
        "first": bars[0] if bars else None,
        "last": bars[-1] if bars else None
    }

conn = sqlite3.connect("./data/cache/ashare-cache.sqlite")
conn.row_factory = sqlite3.Row
cur = conn.cursor()

old_first = cur.execute("""
SELECT *
FROM daily_bars
WHERE symbol = '600519'
ORDER BY trade_date ASC
LIMIT 1
""").fetchone()

old_last = cur.execute("""
SELECT *
FROM daily_bars
WHERE symbol = '600519'
ORDER BY trade_date DESC
LIMIT 1
""").fetchone()

print("=== 当前库 600519 ===")
print("first:", dict(old_first))
print("last :", dict(old_last))

print("\n=== BaoStock 三种复权 ===")
for adjust in ["qfq", "hfq", "none"]:
    item = run_adapter(adjust)
    first = item["first"]
    last = item["last"]

    print("\n", adjust)
    print({
        "rows": item["rows"],
        "first_date": first.get("date") if first else None,
        "first_open": first.get("open") if first else None,
        "first_close": first.get("close") if first else None,
        "last_date": last.get("date") if last else None,
        "last_open": last.get("open") if last else None,
        "last_close": last.get("close") if last else None,
        "last_amount": last.get("amount") if last else None,
        "last_turnover": last.get("turnover") if last else None
    })

conn.close()
