#!/usr/bin/env python3
"""Convert your own subscription (including JSON/Xray format) into URIs locally.

Nothing is uploaded anywhere. The output file is git-ignored, so a private
subscription never reaches the repository or GitHub Pages.

Usage:
    python scripts/private_uri.py --url "https://example.tld/TOKEN" --out local_private.txt

The URL is read from --url or from the PRIVATE_SUB_URL environment variable.
The token is never printed: only counts are shown.
"""

from __future__ import annotations

import argparse
import os
import sys

import merge


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--url", default=os.getenv("PRIVATE_SUB_URL", ""))
    ap.add_argument("--out", default="local_private.txt")
    ap.add_argument("--allow-protocols", default="vless,vmess,trojan,ss,hysteria2")
    args = ap.parse_args(argv)

    if not args.url:
        print("no URL: pass --url or set PRIVATE_SUB_URL", file=sys.stderr)
        return 2

    try:
        text = merge.fetch_text(args.url)
    except merge.FetchError as exc:
        print(f"download failed: {exc}", file=sys.stderr)
        return 1

    lines = merge.decode_payload(text)
    allowed = {p.strip().lower() for p in args.allow_protocols.split(",") if p.strip()}
    good, bad = [], 0
    for line in lines:
        if "://" not in line:
            continue
        try:
            if merge.validate_uri(line, allowed):
                good.append(line)
            else:
                bad += 1
        except Exception:                                  # noqa: BLE001
            bad += 1

    if not good:
        print(f"no usable configs found (raw lines={len(lines)}, rejected={bad})",
              file=sys.stderr)
        return 1

    with open(args.out, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(good) + "\n")

    print(f"written {len(good)} config(s) to {args.out} (rejected {bad}).")
    print("Import the file in v2rayNG: (+) -> Import config from file.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
