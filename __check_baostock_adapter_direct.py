import json
import subprocess
import sys

cmd = [
    sys.executable,
    "./src/adapters/baostockAshareDailyAdapter.py",
    "600519",
    "20180101",
    "20260610",
    "qfq"
]

p = subprocess.run(
    cmd,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE
)

raw = p.stdout

text = None
for enc in ["utf-8", "utf-8-sig", "gbk", "utf-16", "utf-16le"]:
    try:
        text = raw.decode(enc)
        break
    except Exception:
        pass

if text is None:
    raise SystemExit("stdout 解码失败: " + repr(raw[:80]))

if p.stderr:
    try:
        print("STDERR:", p.stderr.decode("utf-8", errors="ignore")[:1000])
    except Exception:
        print("STDERR:", p.stderr[:1000])

start = text.find("{")
end = text.rfind("}")

if start < 0 or end < 0 or end <= start:
    print("原始输出：")
    print(text[:2000])
    raise SystemExit("没有找到 JSON 输出")

data = json.loads(text[start:end + 1])
bars = data.get("bars") or []

print({
    "ok": data.get("ok"),
    "source": data.get("source"),
    "market": data.get("market"),
    "symbol": data.get("symbol"),
    "rows": len(bars),
    "first": bars[0] if bars else None,
    "last": bars[-1] if bars else None,
    "amount_rows": sum(1 for x in bars if x.get("amount")),
    "turnover_rows": sum(1 for x in bars if x.get("turnover"))
})
