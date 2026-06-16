import json
import sqlite3
from pathlib import Path

universe = json.loads(Path("./data/universe/stock-universe.json").read_text(encoding="utf-8"))
stocks = universe.get("stocks") or universe.get("items") or []

supported = []
for s in stocks:
    sym = str(s.get("symbol") or "").strip()
    market = str(s.get("market") or "").strip().upper()
    if len(sym) == 6 and (sym.startswith("0") or sym.startswith("3") or sym.startswith("6")) and market != "BJ":
        supported.append(s)

conn = sqlite3.connect("./data/cache/ashare-cache.sqlite")
conn.row_factory = sqlite3.Row
cur = conn.cursor()

db_ok = set()
db_bad = []

for s in supported:
    sym = s["symbol"]
    row = cur.execute("""
    SELECT
      COUNT(*) AS rows,
      MAX(trade_date) AS max_date,
      SUM(CASE WHEN amount IS NOT NULL AND amount > 0 THEN 1 ELSE 0 END) AS amount_rows,
      SUM(CASE WHEN turnover IS NOT NULL AND turnover > 0 THEN 1 ELSE 0 END) AS turnover_rows
    FROM daily_bars
    WHERE symbol = ?
    """, (sym,)).fetchone()

    rows = int(row["rows"] or 0)
    amount_rows = int(row["amount_rows"] or 0)
    turnover_rows = int(row["turnover_rows"] or 0)
    max_date = row["max_date"] or ""

    if rows > 0 and amount_rows == rows and turnover_rows == rows and max_date >= "2026-06-05":
        db_ok.add(sym)
    else:
        db_bad.append({
            "symbol": sym,
            "name": s.get("name") or "",
            "market": s.get("market") or "",
            "rows": rows,
            "max_date": max_date,
            "amount_rows": amount_rows,
            "turnover_rows": turnover_rows
        })

conn.close()

progress_path = Path("./data/sync/baostock-a-reload-progress-2018.json")
progress = json.loads(progress_path.read_text(encoding="utf-8")) if progress_path.exists() else {}
done = set((progress.get("done") or {}).keys())
failed = progress.get("failed") or {}

missing_progress = [s for s in supported if s["symbol"] not in done]
missing_db = [item for item in db_bad]

print({
    "supported": len(supported),
    "progress_done": len(done),
    "progress_failed": len(failed),
    "db_ok": len(db_ok),
    "db_bad": len(db_bad)
})

print("\n进度文件未完成样本：")
for s in missing_progress[:20]:
    print(s)

print("\n数据库不完整样本：")
for s in missing_db[:20]:
    print(s)
