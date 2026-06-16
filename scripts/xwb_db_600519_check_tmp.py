import sqlite3

db = "data/cache/ashare-cache.sqlite"
conn = sqlite3.connect(db)
cur = conn.cursor()

rows = cur.execute("""
SELECT symbol, trade_date, open, high, low, close, volume, amount, amplitude, pct_change, change_amount, turnover
FROM daily_bars
WHERE symbol = '600519'
  AND trade_date IN ('2018-07-03','2018-07-04','2020-04-09','2021-02-01')
ORDER BY trade_date
""").fetchall()

for row in rows:
    print(row)

conn.close()
