import sqlite3

conn = sqlite3.connect("./data/cache/ashare-cache.sqlite")
conn.row_factory = sqlite3.Row
cur = conn.cursor()

for sym in ["300750", "600519", "HK:00700", "HK:09888"]:
    r = cur.execute("""
    SELECT
      symbol,
      COUNT(*) AS rows,
      SUM(CASE WHEN amount IS NOT NULL AND amount > 0 THEN 1 ELSE 0 END) AS amount_rows,
      SUM(CASE WHEN turnover IS NOT NULL AND turnover > 0 THEN 1 ELSE 0 END) AS turnover_rows,
      MIN(trade_date) AS start_date,
      MAX(trade_date) AS end_date
    FROM daily_bars
    WHERE symbol = ?
    GROUP BY symbol
    """, (sym,)).fetchone()

    print(dict(r) if r else {"symbol": sym, "exists": False})

conn.close()
