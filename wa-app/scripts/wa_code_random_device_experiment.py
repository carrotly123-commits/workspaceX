#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import random
import string
import subprocess
import sys
import time
from dataclasses import dataclass
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
PROBE_SCRIPT = SCRIPT_DIR / "wa_code_param_probe.py"
APP_VERSION = "2.26.23.71"


@dataclass(frozen=True)
class DeviceProfile:
    label: str
    vendor: str
    model: str
    android: str
    display_id: str
    ram_gib: str

    @property
    def user_agent(self) -> str:
        return f"WhatsApp/{APP_VERSION} Android/{self.android} Device/{self.vendor}-{self.model}"


CONTROL_DEVICES = {
    "oppo-known-a12": DeviceProfile("oppo-known-a12", "OPPO", "CPH2305", "12", "CPH2305_12.1.0.210(EX1)", "5.42"),
    "xiaomi-known-a11": DeviceProfile("xiaomi-known-a11", "Xiaomi", "M2007J3SC", "11", "M2007J3SC_11.0.14(CN01)", "6.58"),
    "oneplus-known-a14": DeviceProfile("oneplus-known-a14", "OnePlus", "LE2100", "14", "LE2100_14.0.0.605(CN01)", "11.24"),
}
GENERIC_VENDOR = "VANTADigital"
GENERIC_MODEL = "A3820WF"
GENERIC_RAM = "5.50"
XIAOMI_MODEL = "M2007J3SC"
XIAOMI_RAM = "6.58"


def fixed_generic_profile(label: str, android: str, ram_gib: str = GENERIC_RAM, display_android: str | None = None) -> DeviceProfile:
    did_android = display_android or android
    return DeviceProfile(
        label=label,
        vendor=GENERIC_VENDOR,
        model=GENERIC_MODEL,
        android=android,
        display_id=f"{GENERIC_MODEL}_{did_android}.0.4.210(GL01)",
        ram_gib=ram_gib,
    )


def fixed_xiaomi_profile(label: str, android: str, ram_gib: str = XIAOMI_RAM, display_android: str | None = None) -> DeviceProfile:
    did_android = display_android or android
    return DeviceProfile(
        label=label,
        vendor="Xiaomi",
        model=XIAOMI_MODEL,
        android=android,
        display_id=f"{XIAOMI_MODEL}_{did_android}.0.14(CN01)",
        ram_gib=ram_gib,
    )


def fixed_generic_with_xiaomi_display(label: str) -> DeviceProfile:
    return DeviceProfile(label, GENERIC_VENDOR, GENERIC_MODEL, "11", f"{XIAOMI_MODEL}_11.0.14(CN01)", GENERIC_RAM)


def fixed_xiaomi_with_generic_display(label: str) -> DeviceProfile:
    return DeviceProfile(label, "Xiaomi", XIAOMI_MODEL, "11", f"{GENERIC_MODEL}_11.0.4.210(GL01)", XIAOMI_RAM)


def rand_digits(length: int) -> str:
    return "".join(random.choice(string.digits) for _ in range(length))


def rand_upper(length: int) -> str:
    return "".join(random.choice(string.ascii_uppercase) for _ in range(length))


def random_ram(min_value: float, max_value: float) -> str:
    return f"{random.uniform(min_value, max_value):.2f}"


def random_brand() -> str:
    prefixes = ["NOVA", "AERO", "ORBI", "LYRA", "VANTA", "ZENO", "NIMO", "KORA", "ALTO", "MEGA"]
    suffixes = ["Mobile", "Phone", "Tech", "One", "Digital", "Comms", "Labs", "Link"]
    return random.choice(prefixes) + random.choice(suffixes)


def random_generic_profile(label: str, android: str) -> DeviceProfile:
    model = random.choice(["X", "A", "M", "N", "Z"]) + rand_digits(4) + rand_upper(2)
    branch = random.choice(["GX", "GL", "EEA", "IN", "LA"])
    return DeviceProfile(
        label=label,
        vendor=random_brand(),
        model=model,
        android=android,
        display_id=f"{model}_{android}.0.{random.randint(1, 9)}.{random.randint(10, 999)}({branch}01)",
        ram_gib=random_ram(3.5, 7.8),
    )


def random_oppo_like_profile(label: str) -> DeviceProfile:
    model = "CPH" + rand_digits(4)
    return DeviceProfile(
        label=label,
        vendor="OPPO",
        model=model,
        android="12",
        display_id=f"{model}_12.1.{random.randint(0, 5)}.{random.randint(100, 999)}(EX1)",
        ram_gib=random_ram(3.6, 7.4),
    )


def random_xiaomi_like_profile(label: str) -> DeviceProfile:
    model = "M" + rand_digits(7) + random.choice(["C", "G", "I", "K"])
    return DeviceProfile(
        label=label,
        vendor="Xiaomi",
        model=model,
        android="11",
        display_id=f"{model}_11.0.{random.randint(1, 14)}(CN01)",
        ram_gib=random_ram(5.5, 7.8),
    )


def build_device(label: str) -> DeviceProfile:
    if label in CONTROL_DEVICES:
        return CONTROL_DEVICES[label]
    if label.startswith("generic-a") and label[9:].isdigit():
        android = label[9:]
        return fixed_generic_profile(label, android)
    if label.startswith("xiaomi-a") and label[8:].isdigit():
        android = label[8:]
        return fixed_xiaomi_profile(label, android)
    if label.startswith("ram-a11-"):
        raw = label.removeprefix("ram-a11-")
        if raw.isdigit():
            return fixed_generic_profile(label, "11", f"{int(raw) / 100:.2f}")
    if label == "consistent-generic-a11":
        return fixed_generic_profile(label, "11")
    if label == "ua-a11-did-a12":
        return fixed_generic_profile(label, "11", display_android="12")
    if label == "ua-a12-did-a11":
        return fixed_generic_profile(label, "12", display_android="11")
    if label == "generic-ua-xiaomi-did-a11":
        return fixed_generic_with_xiaomi_display(label)
    if label == "xiaomi-ua-generic-did-a11":
        return fixed_xiaomi_with_generic_display(label)
    if label == "random-generic-a12":
        return random_generic_profile(label, "12")
    if label == "random-generic-a11":
        return random_generic_profile(label, "11")
    if label == "random-oppo-like-a12":
        return random_oppo_like_profile(label)
    if label == "random-xiaomi-like-a11":
        return random_xiaomi_like_profile(label)
    raise ValueError(f"unknown device label: {label}")


PRESET_LABELS = {
    "all": [
        "oppo-known-a12",
        "xiaomi-known-a11",
        "oneplus-known-a14",
        "random-oppo-like-a12",
        "random-xiaomi-like-a11",
        "random-generic-a12",
        "random-generic-a11",
    ],
    "random": ["random-oppo-like-a12", "random-xiaomi-like-a11", "random-generic-a12", "random-generic-a11"],
    "android-sweep": ["generic-a10", "generic-a11", "generic-a12", "generic-a13", "generic-a14"],
    "ram-sweep": ["ram-a11-350", "ram-a11-450", "ram-a11-550", "ram-a11-650", "ram-a11-750", "ram-a11-1124"],
    "xiaomi-android": ["xiaomi-a10", "xiaomi-a11", "xiaomi-a12", "xiaomi-a13", "xiaomi-a14"],
    "consistency": [
        "consistent-generic-a11",
        "ua-a11-did-a12",
        "ua-a12-did-a11",
        "generic-ua-xiaomi-did-a11",
        "xiaomi-ua-generic-did-a11",
    ],
}
PRESET_LABELS["factor-all"] = (
    PRESET_LABELS["android-sweep"]
    + PRESET_LABELS["ram-sweep"]
    + PRESET_LABELS["xiaomi-android"]
    + PRESET_LABELS["consistency"]
)


def parse_labels(value: str) -> list[str]:
    labels: list[str] = []
    for item in [part.strip() for part in value.strip().split(",") if part.strip()]:
        labels.extend(PRESET_LABELS.get(item, [item]))
    return labels


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
    if reason == "bad_token":
        return "bad_token"
    if row.get("request_failed"):
        return "request_failed"
    if status == "fail":
        return "other_fail"
    return "unknown"


def run_probe_once(args: argparse.Namespace, device: DeviceProfile) -> dict[str, Any]:
    cmd = [
        sys.executable,
        str(PROBE_SCRIPT),
        "--country",
        args.country,
        "--count",
        "1",
        "--variant",
        args.variant,
        "--timeout",
        str(args.timeout),
        "--sleep",
        "0",
        "--user-agent",
        device.user_agent,
        "--device-display-id",
        device.display_id,
        "--device-ram",
        device.ram_gib,
    ]
    if args.patch:
        cmd.extend(["--patch", args.patch])
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
    row["label"] = device.label
    row["vendor"] = device.vendor
    row["model"] = device.model
    row["android"] = device.android
    row["display_id_hash"] = row.get("display_id_hash") or short_hash(device.display_id)
    row["ram_gib"] = device.ram_gib
    row["outcome"] = classify(row)
    return row


def short_hash(value: str) -> str:
    import hashlib

    return hashlib.sha256(value.encode()).hexdigest()[:16]


def rate(numerator: int, denominator: int) -> float | None:
    if denominator <= 0:
        return None
    return round(numerator / denominator, 4)


def summarize(rows: list[dict[str, Any]]) -> dict[str, Any]:
    labels = sorted({str(row.get("label") or "") for row in rows})
    summary: dict[str, Any] = {}
    for label in labels:
        group = [row for row in rows if row.get("label") == label]
        counts = {
            key: 0
            for key in [
                "sent",
                "no_routes",
                "blocked",
                "bad_token",
                "too_recent",
                "request_failed",
                "transport_error",
                "other_fail",
                "unknown",
            ]
        }
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
            "sent_rate_on_target": rate(counts["sent"], target),
        }
    return summary


def markdown_table(summary: dict[str, Any]) -> str:
    headers = ["variant", "total", "sent", "no_routes", "blocked", "bad_token", "target", "sent/target"]
    lines = ["| " + " | ".join(headers) + " |", "|" + "---|" * len(headers)]
    for label, item in sorted(summary.items(), key=lambda pair: pair[0]):
        values = [
            label,
            str(item.get("total", 0)),
            str(item.get("sent", 0)),
            str(item.get("no_routes", 0)),
            str(item.get("blocked", 0)),
            str(item.get("bad_token", 0)),
            str(item.get("target_decisions", 0)),
            str(item.get("sent_rate_on_target")),
        ]
        lines.append("| " + " | ".join(values) + " |")
    return "\n".join(lines)


def output_paths(args: argparse.Namespace) -> tuple[Path, Path]:
    run_id = args.run_id or time.strftime("%Y%m%d-%H%M%S")
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    return out_dir / f"{run_id}.ndjson", out_dir / f"{run_id}.summary.json"


def main() -> int:
    parser = argparse.ArgumentParser(description="Run SMS-only /v2/code experiments with known and random-generated Android device models.")
    parser.add_argument("--country", default="CO", help="random phone country; default CO")
    parser.add_argument("--samples", type=int, default=6, help="samples per device label")
    parser.add_argument("--labels", default="all", help="all, random, android-sweep, ram-sweep, xiaomi-android, consistency, factor-all, or comma-separated labels")
    parser.add_argument("--variant", choices=["current", "ghcr"], default="current")
    parser.add_argument("--patch", default="", help="comma-separated wa_code_param_probe patch names")
    parser.add_argument("--timeout", type=float, default=25)
    parser.add_argument("--sleep", type=float, default=0.8)
    parser.add_argument("--jitter", type=float, default=0.5)
    parser.add_argument("--proxy", default="", help="HTTP proxy URL; WA_PROBE_PROXY_URL is used when omitted")
    parser.add_argument("--allow-direct", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--show-fields", action="store_true")
    parser.add_argument("--out-dir", default=".temp/wa-code-param-experiments")
    parser.add_argument("--run-id", default="")
    args = parser.parse_args()

    args.proxy = args.proxy or os.environ.get("WA_PROBE_PROXY_URL", "")
    if not args.proxy and not args.allow_direct and not args.dry_run:
        print(json.dumps({"error": "set WA_PROBE_PROXY_URL or pass --proxy; use --allow-direct only intentionally"}, ensure_ascii=False), file=sys.stderr)
        return 2

    labels = parse_labels(args.labels)
    ndjson_path, summary_path = output_paths(args)
    rows: list[dict[str, Any]] = []
    with ndjson_path.open("w", encoding="utf-8") as handle:
        for round_index in range(1, args.samples + 1):
            round_labels = list(labels)
            random.shuffle(round_labels)
            for label in round_labels:
                device = build_device(label)
                row = run_probe_once(args, device)
                row["round"] = round_index
                rows.append(row)
                line = json.dumps(row, ensure_ascii=False, sort_keys=True)
                print(line, flush=True)
                handle.write(line + "\n")
                handle.flush()
                if not args.dry_run and args.sleep > 0:
                    time.sleep(args.sleep + random.random() * max(args.jitter, 0))

    summary = summarize(rows)
    payload = {"samples_per_label": args.samples, "country": args.country, "labels": labels, "summary": summary}
    summary_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"result_file": str(ndjson_path), "summary_file": str(summary_path), "summary": summary}, ensure_ascii=False, sort_keys=True))
    print(markdown_table(summary))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
