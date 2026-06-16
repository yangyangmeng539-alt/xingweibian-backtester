import json
from pathlib import Path
from datetime import datetime

symbols = [
    "000004",
    "001331",
    "002731",
    "002808",
    "002898",
    "300029",
    "688002",
    "688121"
]

p = Path("./data/sync/baostock-a-reload-progress-2018.json")
data = json.loads(p.read_text(encoding="utf-8"))

backup = Path(f"./data/sync/baostock-a-reload-progress-before-final-8-retry-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json")
backup.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

for group_name in ["done", "failed", "skipped"]:
    group = data.get(group_name) or {}
    for sym in symbols:
        group.pop(sym, None)
    data[group_name] = group

data["current"] = {
    "status": "FINAL_8_RETRY_PREPARED",
    "symbols": symbols,
    "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
}

p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

print({
    "backup": str(backup),
    "removedSymbols": symbols,
    "doneAfter": len(data.get("done") or {}),
    "failedAfter": len(data.get("failed") or {}),
    "skippedAfter": len(data.get("skipped") or {})
})
