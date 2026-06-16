import sqlite3

conn = sqlite3.connect("./data/cache/ashare-cache.sqlite")
conn.row_factory = sqlite3.Row
cur = conn.cursor()

row = cur.execute("""
SELECT
  COUNT(*) AS rows,
  COUNT(DISTINCT symbol) AS symbols,
  MIN(trade_date) AS start_date,
  MAX(trade_date) AS end_date,
  SUM(CASE WHEN amount IS NOT NULL AND amount > 0 THEN 1 ELSE 0 END) AS amount_rows,
  SUM(CASE WHEN turnover IS NOT NULL AND turnover > 0 THEN 1 ELSE 0 END) AS turnover_rows
FROM daily_bars
WHERE symbol NOT LIKE 'HK:%'
""").fetchone()

print(dict(row))

conn.close()
