#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import random
import subprocess
import sys
import time
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
PROBE_SCRIPT = SCRIPT_DIR / "wa_code_param_probe.py"
DEFAULT_PATCHES = [
    "client-metrics-google-play",
    "db-zero",
    "gpia-error-minus-two",
    "gpia-data-digest-ghcr",
    "gpia-source-ghcr",
    "gpia-json-no-slash-escape",
    "wamsys-order-ghcr",
    "wamsys-values-ghcr",
    "no-sim-signal",
    "device-ghcr-defaults",
    "operator-co-732101",
]
CRITICAL_PATCHES = ["gpia-error-minus-two", "no-sim-signal", "db-zero", "wamsys-values-ghcr"]


def parse_patches(value: str) -> list[str]:
    value = value.strip()
    if value == "all":
        return list(DEFAULT_PATCHES)
    if value == "critical":
        return list(CRITICAL_PATCHES)
    return [item.strip() for item in value.split(",") if item.strip()]


def classify(row: dict[str, Any]) -> str:
    if row.get("error"):
        return "transport_error"
    status = str(row.get("status") or "").lower()
    reason = str(row.get("reason") or "").lower()
    if status in {"sent", "ok"}:
        return "sent"
    if reason == "no_routes":
        return "no_routes"
    if reason == "blocked":
        return "blocked"
    if reason == "too_recent":
        return "too_recent"
    if row.get("request_failed"):
        return "request_failed"
    if status == "fail":
        return "other_fail"
    return "unknown"


def run_probe_once(args: argparse.Namespace, label: str, patch: str, variant: str) -> dict[str, Any]:
    cmd = [
        sys.executable,
        str(PROBE_SCRIPT),
        "--country",
        args.country,
        "--count",
        "1",
        "--variant",
        variant,
        "--timeout",
        str(args.timeout),
        "--sleep",
        "0",
    ]
    if patch:
        cmd.extend(["--patch", patch])
    if args.proxy:
        cmd.extend(["--proxy", args.proxy])
    if args.dry_run:
        cmd.append("--dry-run")
    if args.show_fields:
        cmd.append("--show-fields")
    env = os.environ.copy()
    if args.proxy:
        env["WA_PROBE_PROXY_URL"] = args.proxy
    proc = subprocess.run(cmd, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env, check=False)
    row: dict[str, Any] | None = None
    for line in proc.stdout.splitlines():
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict) and "summary" not in parsed:
            row = parsed
            break
    if row is None:
        row = {"error": "probe produced no JSON row", "stdout_tail": proc.stdout[-500:]}
    if proc.returncode != 0 and "error" not in row:
        row["error"] = f"probe exited with {proc.returncode}"
    row["label"] = label
    row["patch"] = patch
    row["base_variant"] = variant
    row["outcome"] = classify(row)
    return row


def rate(numerator: int, denominator: int) -> float | None:
    if denominator <= 0:
        return None
    return round(numerator / denominator, 4)


def summarize(rows: list[dict[str, Any]]) -> dict[str, Any]:
    labels = sorted({str(row.get("label") or "") for row in rows})
    summary: dict[str, Any] = {}
    for label in labels:
        group = [row for row in rows if row.get("label") == label]
        counts = {key: 0 for key in ["sent", "no_routes", "blocked", "too_recent", "request_failed", "transport_error", "other_fail", "unknown"]}
        for row in group:
            outcome = str(row.get("outcome") or "unknown")
            counts[outcome] = counts.get(outcome, 0) + 1
        total = len(group)
        target = counts["sent"] + counts["no_routes"]
        summary[label] = {
            "total": total,
            **counts,
            "target_decisions": target,
            "sent_rate": rate(counts["sent"], total),
            "no_routes_rate": rate(counts["no_routes"], total),
            "sent_rate_on_target": rate(counts["sent"], target),
            "no_routes_rate_on_target": rate(counts["no_routes"], target),
        }
    return summary


def markdown_table(summary: dict[str, Any]) -> str:
    headers = ["variant", "total", "sent", "no_routes", "blocked", "too_recent", "errors", "sent_rate", "no_routes_rate"]
    lines = ["| " + " | ".join(headers) + " |", "|" + "---|" * len(headers)]
    for label, item in sorted(summary.items(), key=lambda pair: pair[0]):
        errors = int(item.get("transport_error", 0)) + int(item.get("request_failed", 0))
        values = [
            label,
            str(item.get("total", 0)),
            str(item.get("sent", 0)),
            str(item.get("no_routes", 0)),
            str(item.get("blocked", 0)),
            str(item.get("too_recent", 0)),
            str(errors),
            str(item.get("sent_rate")),
            str(item.get("no_routes_rate")),
        ]
        lines.append("| " + " | ".join(values) + " |")
    return "\n".join(lines)


def output_paths(args: argparse.Namespace) -> tuple[Path, Path]:
    run_id = args.run_id or time.strftime("%Y%m%d-%H%M%S")
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    return out_dir / f"{run_id}.ndjson", out_dir / f"{run_id}.summary.json"


def main() -> int:
    parser = argparse.ArgumentParser(description="Run one-variable WA /v2/code experiments with randomized order and fresh random phones.")
    parser.add_argument("--country", default="CO", help="random phone country; default CO")
    parser.add_argument("--samples", type=int, default=10, help="samples per variant")
    parser.add_argument("--patches", default="all", help="all, critical, or comma-separated wa_code_param_probe patch names")
    parser.add_argument("--include-ghcr", action="store_true", help="also run full ghcr-shaped request as a sanity arm")
    parser.add_argument("--timeout", type=float, default=25)
    parser.add_argument("--sleep", type=float, default=0.8, help="base sleep between individual requests")
    parser.add_argument("--jitter", type=float, default=0.5, help="extra random sleep between requests")
    parser.add_argument("--proxy", default="", help="HTTP proxy URL; WA_PROBE_PROXY_URL is used when omitted")
    parser.add_argument("--allow-direct", action="store_true", help="allow running without proxy")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--show-fields", action="store_true")
    parser.add_argument("--out-dir", default=".temp/wa-code-param-experiments")
    parser.add_argument("--run-id", default="")
    args = parser.parse_args()

    args.proxy = args.proxy or os.environ.get("WA_PROBE_PROXY_URL", "")
    if not args.proxy and not args.allow_direct and not args.dry_run:
        print(json.dumps({"error": "set WA_PROBE_PROXY_URL or pass --proxy; use --allow-direct only intentionally"}, ensure_ascii=False), file=sys.stderr)
        return 2

    patches = parse_patches(args.patches)
    arms = [("current", "", "current")]
    arms.extend(("current+" + patch, patch, "current") for patch in patches)
    if args.include_ghcr:
        arms.append(("ghcr", "", "ghcr"))

    ndjson_path, summary_path = output_paths(args)
    rows: list[dict[str, Any]] = []
    with ndjson_path.open("w", encoding="utf-8") as handle:
        for round_index in range(1, args.samples + 1):
            round_arms = list(arms)
            random.shuffle(round_arms)
            for label, patch, variant in round_arms:
                row = run_probe_once(args, label, patch, variant)
                row["round"] = round_index
                rows.append(row)
                line = json.dumps(row, ensure_ascii=False, sort_keys=True)
                print(line, flush=True)
                handle.write(line + "\n")
                handle.flush()
                if not args.dry_run and args.sleep > 0:
                    time.sleep(args.sleep + random.random() * max(args.jitter, 0))

    summary = summarize(rows)
    payload = {"samples_per_variant": args.samples, "country": args.country, "arms": [arm[0] for arm in arms], "summary": summary}
    summary_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"result_file": str(ndjson_path), "summary_file": str(summary_path), "summary": summary}, ensure_ascii=False, sort_keys=True))
    print(markdown_table(summary))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
