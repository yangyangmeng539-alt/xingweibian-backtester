import json
from pathlib import Path
from datetime import datetime

p = Path("./data/sync/baostock-a-reload-progress-2018.json")
data = json.loads(p.read_text(encoding="utf-8"))

failed = data.get("failed") or {}
backup = Path(f"./data/sync/baostock-a-reload-failed-backup-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json")
backup.write_text(json.dumps(failed, ensure_ascii=False, indent=2), encoding="utf-8")

data["failed"] = {}
data["current"] = {
    "status": "RETRY_FAILED_PREPARED",
    "retryCount": len(failed),
    "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
}

p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

print({
    "progress": str(p),
    "failed_backup": str(backup),
    "cleared_failed": len(failed),
    "done_kept": len(data.get("done") or {}),
    "skipped_kept": len(data.get("skipped") or {})
})
