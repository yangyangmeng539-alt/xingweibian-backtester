import sqlite3

db = "./data/cache/ashare-cache.sqlite"

conn = sqlite3.connect(db)
cur = conn.cursor()

before_a = cur.execute("""
SELECT COUNT(*), COUNT(DISTINCT symbol)
FROM daily_bars
WHERE symbol NOT LIKE 'HK:%'
""").fetchone()

before_hk = cur.execute("""
SELECT COUNT(*), COUNT(DISTINCT symbol)
FROM daily_bars
WHERE symbol LIKE 'HK:%'
""").fetchone()

print("删除前 A股/非HK:", {"rows": before_a[0], "symbols": before_a[1]})
print("删除前 港股:", {"rows": before_hk[0], "symbols": before_hk[1]})

cur.execute("""
DELETE FROM daily_bars
WHERE symbol NOT LIKE 'HK:%'
""")

conn.commit()

after_a = cur.execute("""
SELECT COUNT(*), COUNT(DISTINCT symbol)
FROM daily_bars
WHERE symbol NOT LIKE 'HK:%'
""").fetchone()

after_hk = cur.execute("""
SELECT COUNT(*), COUNT(DISTINCT symbol)
FROM daily_bars
WHERE symbol LIKE 'HK:%'
""").fetchone()

print("删除后 A股/非HK:", {"rows": after_a[0], "symbols": after_a[1]})
print("删除后 港股:", {"rows": after_hk[0], "symbols": after_hk[1]})

print("开始 VACUUM...")
cur.execute("VACUUM")
conn.close()

print("完成：A股已全删，港股保留。")
