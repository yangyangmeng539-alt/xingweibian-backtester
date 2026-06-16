import sqlite3

conn = sqlite3.connect("./data/cache/ashare-cache.sqlite")
conn.row_factory = sqlite3.Row
cur = conn.cursor()

print("建表 SQL：")
for row in cur.execute("SELECT type, name, sql FROM sqlite_master WHERE name='daily_bars' OR tbl_name='daily_bars' ORDER BY type, name"):
    print(dict(row))

print("\n索引字段：")
for idx in ["idx_daily_bars_symbol_date", "sqlite_autoindex_daily_bars_1"]:
    print("\n", idx)
    for row in cur.execute(f"PRAGMA index_info('{idx}')"):
        print(dict(row))

conn.close()
