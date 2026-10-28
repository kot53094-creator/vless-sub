#!/usr/bin/env python3
"""
Measure how many nodes each source actually contributes, so that dead sources
can be removed from sources.txt with data instead of guesswork.

For every source it takes a spread sample (the head of a bot's file is not
representative), runs the TCP probe and then the real traffic test through Xray,
and prints a table with a keep/drop verdict.

  python scripts/check_sources.py                     # sources.txt, 120 nodes each
  python scripts/check_sources.py --sample 200        # larger sample
  python scripts/check_sources.py --no-deep           # TCP only, fast
  python scripts/check_sources.py --sources my.txt    # another list

Runs from the network of whoever executes it -- a node that is dead here may be
alive somewhere else, so the verdict is only meaningful for this network.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import merge  # noqa: E402
import xray_check  # noqa: E402

ALLOWED = {"vless", "ss", "vmess", "trojan"}


def parse_args(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--sources", default="sources.txt")
    ap.add_argument("--sample", type=int, default=120,
                    help="how many nodes to take from each source (0 = all)")
    ap.add_argument("--probe-concurrency", type=int, default=96)
    ap.add_argument("--probe-timeout", type=float, default=4.0)
    ap.add_argument("--deep-workers", type=int, default=32)
    ap.add_argument("--deep-timeout", type=float, default=6.0)
    ap.add_argument("--no-deep", action="store_true", help="skip the traffic test")
    return ap.parse_args(argv)


def spread_sample(items: list, count: int) -> list:
    """Every count-th item, so the sample covers the whole file, not its head."""
    if not count or len(items) <= count:
        return items
    step = max(1, len(items) // count)
    return items[::step][:count]


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    sources = [s for s in merge.load_sources(args.sources) if not s["private"]]
    if not sources:
        print("[check] no public source in", args.sources)
        return 2

    records: list[dict] = []
    known: dict[str, int] = {}          # источник -> сколько валидных всего
    for src in sources:
        name = src["name"][:58]
        try:
            text = merge.fetch_text(src["url"], timeout=30, retries=1)
            lines = merge.decode_payload(text)
        except Exception as exc:                              # noqa: BLE001
            print(f"[check] FETCH FAIL {name} -> {type(exc).__name__}: {exc}"[:150])
            known[src["name"]] = -1
            continue
        valid = []
        for line in lines:
            if "://" not in line:
                continue
            try:
                rec = merge.validate_uri(line, ALLOWED)
            except Exception:                                 # noqa: BLE001
                continue
            if rec:
                valid.append(rec)
        known[src["name"]] = len(valid)
        sample = spread_sample(valid, args.sample)
        for rec in sample:
            rec["origin"] = src["name"]
        records.extend(sample)
        print(f"[check] {name} -> {len(valid)} valid, sample {len(sample)}")

    if not records:
        print("[check] nothing to test")
        return 2

    t0 = time.perf_counter()
    asyncio.run(merge.probe_all(records, args.probe_concurrency, args.probe_timeout))
    tcp_time = time.perf_counter() - t0
    alive = [r for r in records if r["reachable"]]
    print(f"[check] tcp {len(alive)}/{len(records)} in {tcp_time:.1f}s")

    if args.no_deep:
        print("[check] traffic test skipped -> verdicts are TCP-only")
    else:
        deep = xray_check.run_deep_check(alive, workers=args.deep_workers,
                                          timeout=args.deep_timeout)
        if not deep["available"]:
            print(f"[check] traffic test UNAVAILABLE ({deep['reason']})")
            return 2
        print(f"[check] traffic {deep['passed']}/{deep['checked']} "
              f"in {deep.get('seconds', 0)}s\n")

    rows = []
    for src in sources:
        known_count = known.get(src["name"], -1)
        if known_count <= 0:
            rows.append((0, 0, 0, known_count, src["name"]))
            continue
        sample = [r for r in records if r["origin"] == src["name"]]
        tcp = sum(1 for r in sample if r["reachable"])
        live = sum(1 for r in sample if r.get("deep_ok") is True)
        rows.append((live, tcp, len(sample), known_count, src["name"]))

    print(f"{'живых':>6} {'tcp':>5} {'выборка':>8} {'всего':>7}  {'вердикт':8} источник")
    drop = 0
    for live, tcp, size, total, name in sorted(rows, reverse=True):
        if total < 0:
            verdict = "BROKEN"
        elif live == 0:
            verdict = "DROP"
            drop += 1
        else:
            verdict = "keep"
        print(f"{live:6} {tcp:5} {size:8} {total:7}  {verdict:8} {name}")

    print(f"\n{drop} источник(ов) с нулевым выходом -- кандидаты на удаление "
          f"из {args.sources}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
