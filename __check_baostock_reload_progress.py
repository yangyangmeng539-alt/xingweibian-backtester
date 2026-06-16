import json
from pathlib import Path
from datetime import datetime

p = Path("./data/sync/baostock-a-reload-progress-2018.json")

if not p.exists():
    print("没有找到进度文件：", p)
    raise SystemExit(1)

data = json.loads(p.read_text(encoding="utf-8"))

done = data.get("done") or {}
failed = data.get("failed") or {}
skipped = data.get("skipped") or {}
current = data.get("current") or {}

total = data.get("universeCount") or current.get("total") or 0

done_keys = set(done.keys())
failed_keys = set(failed.keys())
skipped_keys = set(skipped.keys())

finished_unique = done_keys | failed_keys | skipped_keys
pending = max(int(total or 0) - len(finished_unique), 0)

def collect_times(items):
    arr = []
    for item in items.values():
        t = item.get("time")
        if not t:
            continue
        try:
            arr.append(datetime.strptime(t, "%Y-%m-%d %H:%M:%S"))
        except Exception:
            pass
    return arr

times = collect_times(done)

speed_per_min = None
eta_text = None

if len(times) >= 2:
    start = min(times)
    end = max(times)
    seconds = max((end - start).total_seconds(), 1)
    speed = len(done) / seconds
    speed_per_min = round(speed * 60, 2)

    remain_success = max(int(total or 0) - len(done), 0)
    eta_seconds = remain_success / speed if speed > 0 else 0
    eta_text = f"{round(eta_seconds / 60, 1)} 分钟 / {round(eta_seconds / 3600, 2)} 小时"

print({
    "total": total,
    "done_success": len(done),
    "failed": len(failed),
    "skipped": len(skipped),
    "finished_unique": len(finished_unique),
    "pending_not_touched": pending,
    "success_percent": round(len(done) / total * 100, 2) if total else None,
    "current": current,
    "speed_per_min_by_success": speed_per_min,
    "eta_by_success": eta_text,
    "progress_file": str(p)
})

if failed:
    print("\n最近失败样本：")
    for symbol, item in list(failed.items())[-10:]:
        print(symbol, item)
