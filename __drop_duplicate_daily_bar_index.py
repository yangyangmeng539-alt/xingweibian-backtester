import sqlite3
from pathlib import Path

db = Path("./data/cache/ashare-cache.sqlite")

conn = sqlite3.connect(str(db))
cur = conn.cursor()

print("before index list:")
for row in cur.execute("PRAGMA index_list('daily_bars')"):
    print(row)

cur.execute("DROP INDEX IF EXISTS idx_daily_bars_symbol_date")
conn.commit()

print("\nafter index list:")
for row in cur.execute("PRAGMA index_list('daily_bars')"):
    print(row)

print("\nfreelist after drop:", cur.execute("PRAGMA freelist_count").fetchone()[0])
conn.close()
