import sqlite3
from pathlib import Path

db = Path("data/cache/ashare-cache.sqlite")

print("[DB]", db.resolve())
print("[EXISTS]", db.exists())

if not db.exists():
    raise SystemExit("DB not found")

print("[SIZE_MB]", round(db.stat().st_size / 1024 / 1024, 2))

conn = sqlite3.connect(str(db))
cur = conn.cursor()

tables = [
    row[0]
    for row in cur.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).fetchall()
]

print("[TABLES]", tables)

keywords = ["vol", "volume", "amount", "turnover", "成交", "换手"]

for table in tables:
    print()
    print("==========", table, "==========")

    cols = cur.execute("PRAGMA table_info(" + table + ")").fetchall()
    names = [col[1] for col in cols]

    print("[COLUMNS]", names)

    hits = [
        name for name in names
        if any(keyword.lower() in name.lower() for keyword in keywords)
    ]

    print("[VOLUME_AMOUNT_HITS]", hits)

    try:
        count = cur.execute("SELECT COUNT(*) FROM " + table).fetchone()[0]
        print("[COUNT]", count)
    except Exception as error:
        print("[COUNT_ERROR]", error)

    try:
        sample = cur.execute("SELECT * FROM " + table + " LIMIT 3").fetchall()
        print("[SAMPLE]", sample)
    except Exception as error:
        print("[SAMPLE_ERROR]", error)

conn.close()
