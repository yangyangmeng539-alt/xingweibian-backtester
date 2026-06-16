import json
import sqlite3
from pathlib import Path
from datetime import datetime

progress_path = Path("./data/sync/baostock-a-reload-progress-2018.json")
universe_path = Path("./data/universe/stock-universe.json")
db_path = Path("./data/cache/ashare-cache.sqlite")

progress = json.loads(progress_path.read_text(encoding="utf-8")) if progress_path.exists() else {}
universe = json.loads(universe_path.read_text(encoding="utf-8"))

stocks = universe.get("stocks") or universe.get("items") or []
supported = []
for s in stocks:
    sym = str(s.get("symbol") or "").strip()
    market = str(s.get("market") or "").strip().upper()
    if len(sym) == 6 and (sym.startswith("0") or sym.startswith("3") or sym.startswith("6")) and market != "BJ":
        supported.append(s)

conn = sqlite3.connect(str(db_path))
conn.row_factory = sqlite3.Row
cur = conn.cursor()

complete = {}
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
        complete[sym] = {
            "name": s.get("name") or "",
            "rows": rows,
            "maxDate": max_date,
            "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "from": "sqlite_reconcile"
        }

conn.close()

old_done = progress.get("done") or {}
old_failed = progress.get("failed") or {}

for sym, item in complete.items():
    old_done[sym] = item

# 清掉 failed，让脚本只重试未 done 的股票
progress["done"] = old_done
progress["failed"] = {}
progress["skipped"] = progress.get("skipped") or {}
progress["universeCount"] = len(supported)
progress["current"] = {
    "status": "RECONCILED_FROM_SQLITE",
    "sqliteComplete": len(complete),
    "doneTotal": len(old_done),
    "clearedFailed": len(old_failed),
    "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
}

backup = Path(f"./data/sync/baostock-a-reload-progress-before-reconcile-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json")
backup.write_text(json.dumps({
    "oldDone": progress.get("done") or {},
    "oldFailed": old_failed
}, ensure_ascii=False, indent=2), encoding="utf-8")

progress_path.write_text(json.dumps(progress, ensure_ascii=False, indent=2), encoding="utf-8")

print({
    "supported": len(supported),
    "sqliteComplete": len(complete),
    "doneTotalAfterReconcile": len(progress["done"]),
    "clearedFailed": len(old_failed),
    "remainingApprox": len(supported) - len(progress["done"]),
    "progress": str(progress_path),
    "backup": str(backup)
})
