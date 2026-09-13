"""Render recorded load-test measurements without smoothing or resampling."""

import hashlib
import json
import pathlib
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

source = pathlib.Path(sys.argv[1])
destination = pathlib.Path(sys.argv[2])
raw = source.read_bytes()
record = json.loads(raw)
rows = record["measurements"]["sustained_container_samples"]
start = rows[0]["elapsed_ms"]
minutes = [(row["elapsed_ms"] - start) / 60_000 for row in rows]
mib = 1_048_576

fig, axes = plt.subplots(3, 1, figsize=(12, 9), sharex=True, height_ratios=[2, 1, 1])
fig.patch.set_facecolor("#f8fafc")
for axis in axes:
    axis.set_facecolor("#ffffff")
    axis.grid(True, color="#e2e8f0", linewidth=0.6)
    axis.spines[["top", "right"]].set_visible(False)

for field, label, color in [
    ("rss", "Process RSS", "#2563eb"),
    ("cgroup_current", "Container memory.current", "#0f766e"),
    ("heap_used", "JS heap used", "#9333ea"),
]:
    axes[0].plot(minutes, [row[field] / mib for row in rows], label=label, color=color, linewidth=1)
axes[0].axvspan(0, 5, color="#dbeafe", alpha=0.35)
axes[0].axvspan(max(0, minutes[-1] - 5), minutes[-1], color="#dbeafe", alpha=0.35)
axes[0].set_ylabel("Memory (MiB)")
axes[0].set_ylim(bottom=0)
axes[0].legend(loc="upper left", ncol=3, frameon=False)
axes[0].set_title("Unfiltered one-second samples; shaded areas are the comparison windows", loc="left", fontsize=10)

axes[1].plot(minutes, [row["event_loop_p99_ms"] for row in rows], color="#d97706", linewidth=0.8)
axes[1].set_ylabel("Event-loop p99 (ms)")
axes[1].set_ylim(bottom=0)

for field, label, color in [("total", "Open connections", "#2563eb"), ("waiting", "Waiting", "#dc2626")]:
    axes[2].plot(minutes, [row["pool"][field] for row in rows], color=color, label=label, linewidth=1)
axes[2].set_ylabel("Database pool")
axes[2].set_xlabel("Minutes since first sustained-load sample")
axes[2].set_ylim(-0.2, 8.5)
axes[2].legend(loc="upper left", ncol=2, frameon=False)
axes[2].set_xlim(0, minutes[-1])

qualified = "passed" if record["qualified"] else "did not pass"
fig.suptitle(f"LexCerta local full-service soak — {qualified}", fontsize=17, x=0.08, ha="left")
fig.text(
    0.08,
    0.925,
    "1 CPU · 1 GiB container limit · 8 client workers · synthetic upstream · local PostgreSQL and object storage",
    fontsize=10,
    color="#475569",
)
fig.text(
    0.08,
    0.025,
    "Fixture evidence only; not Cloud Run, live Neon/GCS or external-pilot qualification.\n"
    f"Source SHA-256: {hashlib.sha256(raw).hexdigest()}",
    fontsize=8,
    color="#475569",
)
fig.tight_layout(rect=[0.04, 0.065, 0.98, 0.91])
fig.savefig(destination, dpi=160, facecolor=fig.get_facecolor())
plt.close(fig)
