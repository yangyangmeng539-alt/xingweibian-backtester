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

missing = []
factor_incomplete = []
stale_by_source = []
ok = []

for s in supported:
    sym = s["symbol"]
    row = cur.execute("""
    SELECT
      COUNT(*) AS rows,
      MAX(trade_date) AS max_date,
      SUM(CASE WHEN amount IS NOT NULL AND amount > 0 THEN 1 ELSE 0 END) AS amount_rows,
      SUM(CASE WHEN turnover IS NOT NULL AND turnover > 0 THEN 1 ELSE 0 END) AS turnover_rows,
      SUM(CASE WHEN open <= 0 OR close <= 0 OR high <= 0 OR low <= 0 THEN 1 ELSE 0 END) AS bad_price_rows
    FROM daily_bars
    WHERE symbol = ?
    """, (sym,)).fetchone()

    rows = int(row["rows"] or 0)
    amount_rows = int(row["amount_rows"] or 0)
    turnover_rows = int(row["turnover_rows"] or 0)
    bad_price_rows = int(row["bad_price_rows"] or 0)
    max_date = row["max_date"] or ""

    item = {
        "symbol": sym,
        "name": s.get("name") or "",
        "market": s.get("market") or "",
        "rows": rows,
        "max_date": max_date,
        "amount_rows": amount_rows,
        "turnover_rows": turnover_rows,
        "bad_price_rows": bad_price_rows
    }

    if rows <= 0:
        missing.append(item)
    elif amount_rows != rows or turnover_rows != rows or bad_price_rows > 0:
        factor_incomplete.append(item)
    elif max_date < "2026-06-05":
        stale_by_source.append(item)
    else:
        ok.append(item)

conn.close()

print({
    "supported": len(supported),
    "ok_latest": len(ok),
    "stale_by_source": len(stale_by_source),
    "missing": len(missing),
    "factor_incomplete": len(factor_incomplete),
    "usable_total": len(ok) + len(stale_by_source)
})

print("\n源头最新日不足，但字段完整：")
for item in stale_by_source:
    print(item)

print("\n真正缺失：")
for item in missing:
    print(item)

print("\n字段不完整/坏价：")
for item in factor_incomplete:
    print(item)
