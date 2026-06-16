import json
from pathlib import Path

p = Path("./data/quality/baostock-adapter-600519.json")
data = json.loads(p.read_text(encoding="utf-8"))
bars = data.get("bars") or []

print({
    "ok": data.get("ok"),
    "source": data.get("source"),
    "rows": len(bars),
    "first": bars[0] if bars else None,
    "last": bars[-1] if bars else None,
    "amount_rows": sum(1 for x in bars if x.get("amount")),
    "turnover_rows": sum(1 for x in bars if x.get("turnover"))
})
