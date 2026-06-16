import json
from pathlib import Path
from datetime import datetime

p = Path("./data/sync/baostock-a-reload-progress-2018.json")

if not p.exists():
    raise SystemExit("进度文件不存在，脚本可能还没开始写进度。")

data = json.loads(p.read_text(encoding="utf-8"))

done = data.get("done") or {}
failed = data.get("failed") or {}
skipped = data.get("skipped") or {}
current = data.get("current") or {}

total = data.get("universeCount") or current.get("total") or 0
finished = len(done) + len(failed) + len(skipped)

times = []

for group in [done, failed, skipped]:
    for item in group.values():
        t = item.get("time")
        if t:
            try:
                times.append(datetime.strptime(t, "%Y-%m-%d %H:%M:%S"))
            except Exception:
                pass

if len(times) >= 2 and finished > 0:
    start = min(times)
    end = max(times)
    seconds = max((end - start).total_seconds(), 1)
    speed = finished / seconds
    remain = max(total - finished, 0)
    eta_seconds = remain / speed if speed > 0 else 0

    print({
        "total": total,
        "done": len(done),
        "failed": len(failed),
        "skipped": len(skipped),
        "finished": finished,
        "current": current,
        "speed_per_min": round(speed * 60, 2),
        "avg_seconds_per_symbol": round(1 / speed, 2) if speed > 0 else None,
        "eta_minutes": round(eta_seconds / 60, 1),
        "eta_hours": round(eta_seconds / 3600, 2)
    })
else:
    print({
        "total": total,
        "done": len(done),
        "failed": len(failed),
        "skipped": len(skipped),
        "finished": finished,
        "current": current,
        "note": "样本太少，暂时无法估算 ETA。等跑几十只后再看。"
    })
