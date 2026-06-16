import sqlite3

db = r"data/cache/ashare-cache.sqlite"
conn = sqlite3.connect(db)
cur = conn.cursor()

where = """
symbol GLOB '920[0-9][0-9][0-9]'
OR symbol GLOB '8[0-9][0-9][0-9][0-9][0-9]'
OR symbol GLOB '4[0-9][0-9][0-9][0-9][0-9]'
"""

print("===== BJ daily_bars summary =====")
row = cur.execute(f"""
SELECT
  COUNT(DISTINCT symbol),
  COUNT(*),
  MIN(trade_date),
  MAX(trade_date)
FROM daily_bars
WHERE {where}
""").fetchone()

print({
  "bj_symbol_count": row[0],
  "bj_bar_count": row[1],
  "min_date": row[2],
  "max_date": row[3],
})

print("")
print("===== BJ top 20 symbols =====")
for row in cur.execute(f"""
SELECT symbol, COUNT(*) AS cnt, MIN(trade_date), MAX(trade_date)
FROM daily_bars
WHERE {where}
GROUP BY symbol
ORDER BY symbol
LIMIT 20
"""):
    print(row)

conn.close()
