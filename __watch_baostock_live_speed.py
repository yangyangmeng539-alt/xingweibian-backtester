import json
import time
from pathlib import Path
from datetime import datetime

p = Path("./data/sync/baostock-a-reload-progress-2018.json")

last_done = None
last_time = None

while True:
    data = json.loads(p.read_text(encoding="utf-8"))
    done = data.get("done") or {}
    failed = data.get("failed") or {}
    skipped = data.get("skipped") or {}
    current = data.get("current") or {}
    total = data.get("universeCount") or current.get("total") or 5207

    now = datetime.now()
    done_count = len(done)
    failed_count = len(failed)
    skipped_count = len(skipped)
    remain = max(total - done_count - skipped_count, 0)

    speed = None
    eta = None

    if last_done is not None and last_time is not None:
        minutes = max((now - last_time).total_seconds() / 60, 0.001)
        delta = done_count - last_done
        speed = delta / minutes

        if speed > 0:
            eta_minutes = remain / speed
            eta = f"{eta_minutes:.1f} 分钟 / {eta_minutes / 60:.2f} 小时"

    print({
        "time": now.strftime("%H:%M:%S"),
        "done": done_count,
        "failed": failed_count,
        "skipped": skipped_count,
        "remain": remain,
        "delta_since_last": None if last_done is None else done_count - last_done,
        "live_speed_per_min": None if speed is None else round(speed, 2),
        "live_eta": eta,
        "current": current
    })

    last_done = done_count
    last_time = now
    time.sleep(60)
