import sqlite3

conn = sqlite3.connect("./data/cache/ashare-cache.sqlite")
conn.row_factory = sqlite3.Row
cur = conn.cursor()

for name, where in [
    ("A股", "symbol NOT LIKE 'HK:%'"),
    ("港股", "symbol LIKE 'HK:%'")
]:
    row = cur.execute(f"""
    SELECT
      COUNT(*) AS rows,
      COUNT(DISTINCT symbol) AS symbols,
      MIN(trade_date) AS start_date,
      MAX(trade_date) AS end_date,
      SUM(CASE WHEN amount IS NOT NULL AND amount > 0 THEN 1 ELSE 0 END) AS amount_rows,
      SUM(CASE WHEN turnover IS NOT NULL AND turnover > 0 THEN 1 ELSE 0 END) AS turnover_rows,
      SUM(CASE WHEN open <= 0 OR close <= 0 OR high <= 0 OR low <= 0 THEN 1 ELSE 0 END) AS bad_price_rows
    FROM daily_bars
    WHERE {where}
    """).fetchone()

    print(name, dict(row))

conn.close()
