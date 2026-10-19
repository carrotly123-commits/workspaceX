#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import random
import re
import secrets
import string
import time
import uuid
import warnings
from dataclasses import dataclass
from pathlib import Path

warnings.filterwarnings("ignore", message="urllib3 v2 only supports OpenSSL.*")

import requests
import urllib3
import xeddsa
from cryptography.hazmat.primitives.asymmetric import x25519
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat, PublicFormat

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

SERVER_PUBLIC_KEY_HEX = "8e8c0f74c3ebc5d7a6865c6c3c843856b06121cce8ea774d22fb6f122512302d"
USER_AGENT = "WhatsApp/2.26.21.73 Android/7.0 Device/HUAWEI-TRT-AL00A"
EXIST_URL = "https://y9yrsygcg6.execute-api.us-east-1.amazonaws.com/s/s?_=/v2/exist&"
CODE_URL = "https://y9yrsygcg6.execute-api.us-east-1.amazonaws.com/s/s?_=/v2/code&"
FORM_SAFE = set(string.ascii_letters + string.digits + "-._~")
SKEY_SELF_TEST = b"ctf-wa-skey-self-test"
OPERATORS_BY_CC = {
    "1": [("310", "260"), ("310", "410"), ("311", "480")],
    "48": [("260", "01"), ("260", "02"), ("260", "06")],
    "86": [("460", "00"), ("460", "01"), ("460", "11")],
}


@dataclass(frozen=True)
class ProbeState:
    cc: str
    national: str
    fdid: str
    expid: str
    access_session_id: str
    raw_id: bytes
    raw_backup_token: bytes
    token: str
    authkey: str
    key_bundle: dict[str, str]
    device_map: dict[str, str]
    fingerprint_id: str
    fingerprint_summary: dict[str, str]


def b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def pct_bytes(raw: bytes) -> str:
    out: list[str] = []
    for value in raw:
        ch = chr(value)
        if ch in FORM_SAFE:
            out.append(ch)
        else:
            out.append(f"%{value:02X}")
    return "".join(out)


def quote_form(value: str) -> str:
    return pct_bytes(value.encode("utf-8"))


def short_hash(value: str | bytes) -> str:
    raw = value if isinstance(value, bytes) else value.encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:16]


def load_registration_token_material(repo_root: Path) -> tuple[bytes, bytes]:
    source = (repo_root / "internal/app/native_registration_params.go").read_text(encoding="utf-8")
    key_match = re.search(r'defaultRegistrationTokenHMACKeyHex\s*=\s*"([0-9a-fA-F]+)"', source)
    if not key_match:
        raise SystemExit("defaultRegistrationTokenHMACKeyHex not found")
    prefix_block = source.split("const defaultRegistrationTokenMessagePrefixHex", 1)[1].split("func deriveDefaultRegistrationToken", 1)[0]
    prefix_hex = "".join(re.findall(r'"([0-9a-fA-F]*)"', prefix_block))
    return bytes.fromhex(key_match.group(1)), bytes.fromhex(prefix_hex)


def derive_token(repo_root: Path, national: str) -> str:
    key, prefix = load_registration_token_material(repo_root)
    return base64.b64encode(hmac.new(key, prefix + national.encode("ascii"), hashlib.sha1).digest()).decode("ascii")


def parse_phone(value: str, default_cc: str) -> tuple[str, str]:
    digits = re.sub(r"\D+", "", value)
    if value.strip().startswith("+"):
        if digits.startswith("86") and len(digits) > 2:
            return "86", digits[2:]
        if digits.startswith(default_cc) and len(digits) > len(default_cc):
            return default_cc, digits[len(default_cc):]
    if digits.startswith(default_cc) and len(digits) > 11:
        return default_cc, digits[len(default_cc):]
    return default_cc, digits


def uuid_pair() -> tuple[str, str]:
    value = uuid.uuid4()
    return str(value), b64u(value.bytes)


def clamp_curve_private(raw: bytes) -> bytes:
    if len(raw) != 32:
        raise ValueError("Curve25519 private key must be 32 bytes")
    out = bytearray(raw)
    out[0] &= 248
    out[31] &= 127
    out[31] |= 64
    return bytes(out)


def can_sign_with_default_ed_pub(private_key: bytes, public_key: bytes) -> bool:
    signature = xeddsa.ed25519_priv_sign(private_key, SKEY_SELF_TEST)
    verify_key = xeddsa.curve25519_pub_to_ed25519_pub(public_key, False)
    return bool(xeddsa.ed25519_verify(signature, verify_key, SKEY_SELF_TEST))


def generate_curve_keypair(require_default_ed_pub: bool = False) -> tuple[bytes, bytes]:
    while True:
        private = clamp_curve_private(secrets.token_bytes(32))
        public = xeddsa.priv_to_curve25519_pub(private)
        if not require_default_ed_pub or can_sign_with_default_ed_pub(private, public):
            return private, public


def generate_authkey() -> str:
    private = x25519.X25519PrivateKey.generate()
    _ = private.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())
    public = private.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    return b64u(public)


def generate_key_bundle() -> dict[str, str]:
    identity_private, identity_public = generate_curve_keypair(require_default_ed_pub=True)
    signed_private, signed_public = generate_curve_keypair()
    _ = signed_private
    signed_public_with_prefix = b"\x05" + signed_public
    signature = xeddsa.ed25519_priv_sign(identity_private, signed_public_with_prefix)
    verify_key = xeddsa.curve25519_pub_to_ed25519_pub(identity_public, False)
    if not xeddsa.ed25519_verify(signature, verify_key, signed_public_with_prefix):
        raise SystemExit("generated e_skey_sig failed local verification")
    regid = secrets.randbelow(0x7FFFFFFE) + 1
    spk_id = secrets.randbelow(0xFFFFFE) + 1
    return {
        "authkey": generate_authkey(),
        "e_ident": b64u(identity_public),
        "e_keytype": b64u(b"\x05"),
        "e_regid": b64u(regid.to_bytes(4, "big")),
        "e_skey_id": b64u(spk_id.to_bytes(3, "big")),
        "e_skey_val": b64u(signed_public),
        "e_skey_sig": b64u(signature),
    }


def operator_pair(cc: str) -> tuple[tuple[str, str], tuple[str, str], str]:
    operators = OPERATORS_BY_CC.get(cc) or [("", "")]
    network = random.choice(operators)
    sim = random.choice(operators)
    simnum = "1" if sim[0] else "0"
    return network, sim, simnum


def fixture_key_bundle(path: str) -> dict[str, str]:
    if not path:
        return {}
    fixture = json.loads(Path(path).read_text(encoding="utf-8"))
    params = fixture.get("params") if isinstance(fixture, dict) else None
    if not isinstance(params, dict):
        raise SystemExit(f"fixture has no params map: {path}")
    keys = ["authkey", "e_ident", "e_keytype", "e_regid", "e_skey_id", "e_skey_val", "e_skey_sig"]
    missing = [key for key in keys if not params.get(key)]
    if missing:
        raise SystemExit(f"fixture missing key bundle fields: {missing}")
    return {key: str(params[key]) for key in keys}


def new_probe_state(repo_root: Path, phone: str, default_cc: str, operator_mode: str, key_bundle_fixture: dict[str, str]) -> ProbeState:
    cc, national = parse_phone(phone, default_cc)
    expid_uuid, expid = uuid_pair()
    access_uuid, access_session_id = uuid_pair()
    raw_id = secrets.token_bytes(20)
    raw_backup = secrets.token_bytes(20)
    key_bundle = dict(key_bundle_fixture) if key_bundle_fixture else generate_key_bundle()
    authkey = key_bundle.pop("authkey")
    network_operator, sim_operator, simnum = operator_pair(cc)
    device_map = {
        "network_radio_type": "1",
        "simnum": "0" if operator_mode != "mapped" else simnum,
        "hasinrc": "1",
        "rc": "0",
        "device_ram": "3.53",
        "db": "1",
        "recaptcha": '{"stage":"ABPROP_DISABLED"}',
        "feo2_query_status": "error_security_exception",
        "network_operator_name": "",
        "sim_operator_name": "",
    }
    if operator_mode == "mapped":
        device_map.update({
            "mcc": network_operator[0],
            "mnc": network_operator[1],
            "sim_mcc": sim_operator[0],
            "sim_mnc": sim_operator[1],
        })
    if operator_mode == "empty":
        device_map.update({"mcc": "", "mnc": "", "sim_mcc": "", "sim_mnc": ""})
    material = {
        "cc": cc,
        "national": national,
        "fdid": str(uuid.uuid4()),
        "expid": expid,
        "expid_uuid": expid_uuid,
        "access_session_id": access_session_id,
        "access_uuid": access_uuid,
        "id_hex": raw_id.hex(),
        "backup_token_hex": raw_backup.hex(),
        "authkey": authkey,
        **key_bundle,
        "device_map": device_map,
    }
    fingerprint_id = short_hash(json.dumps(material, sort_keys=True, separators=(",", ":")))
    summary = {
        "fingerprint_id": fingerprint_id,
        "fdid_sha256": short_hash(material["fdid"]),
        "expid_sha256": short_hash(expid),
        "access_session_id_sha256": short_hash(access_session_id),
        "id_sha256": short_hash(raw_id),
        "backup_token_sha256": short_hash(raw_backup),
        "authkey_sha256": short_hash(authkey),
        "e_ident_sha256": short_hash(key_bundle["e_ident"]),
        "e_skey_val_sha256": short_hash(key_bundle["e_skey_val"]),
        "e_skey_sig_sha256": short_hash(key_bundle["e_skey_sig"]),
    }
    return ProbeState(
        cc=cc,
        national=national,
        fdid=material["fdid"],
        expid=expid,
        access_session_id=access_session_id,
        raw_id=raw_id,
        raw_backup_token=raw_backup,
        token=derive_token(repo_root, national),
        authkey=authkey,
        key_bundle=key_bundle,
        device_map=device_map,
        fingerprint_id=fingerprint_id,
        fingerprint_summary=summary,
    )


def exist_device_map(state: ProbeState) -> dict[str, str]:
    return {
        "mistyped": "7",
        "offline_ab": '{"exposure":[],"exp_hash":[],"metrics":{}}',
        "client_metrics": '{"attempts":1,"app_campaign_download_source":"unknown|unknown","was_activated_from_stub":false}',
        "read_phone_permission_granted": "0",
        "sim_state": "1",
        "network_operator_name": state.device_map["network_operator_name"],
        "sim_operator_name": state.device_map["sim_operator_name"],
        "device_name": "HWTRT-Q",
        "feo2_query_status": state.device_map["feo2_query_status"],
        "is_foa_fdid_app_installed": "false",
        "device_ram": state.device_map["device_ram"],
        "language_selector_time_spent": "0",
        "language_selector_clicked_count": "0",
        "db": state.device_map["db"],
        "recaptcha": state.device_map["recaptcha"],
        "network_radio_type": state.device_map["network_radio_type"],
        "simnum": state.device_map["simnum"],
        "hasinrc": state.device_map["hasinrc"],
        "rc": state.device_map["rc"],
        "_ge": '{"sb":false,"sv":false}',
    }


def base_params(state: ProbeState) -> dict[str, str]:
    params = {
        "cc": state.cc,
        "in": state.national,
        "lg": "en",
        "lc": "US",
        "fdid": state.fdid,
        "expid": state.expid,
        "access_session_id": state.access_session_id,
        "id": pct_bytes(state.raw_id),
        "backup_token": pct_bytes(state.raw_backup_token),
        "token": state.token,
        "authkey": state.authkey,
    }
    params.update(state.key_bundle)
    return params


def build_plain(state: ProbeState, kind: str) -> tuple[str, list[str]]:
    params = base_params(state)
    raw_keys = {"id", "backup_token"}
    if kind == "code":
        params["method"] = "sms"
        device_fields = state.device_map
    elif kind == "exist":
        device_fields = exist_device_map(state)
    else:
        raise ValueError(f"unsupported request kind: {kind}")
    for key, value in device_fields.items():
        params[key] = pct_bytes(value.encode("utf-8"))
        raw_keys.add(key)
    preferred = [
        "cc", "in", "method", "lg", "lc", "fdid", "expid", "access_session_id", "id", "backup_token", "token",
        "authkey", "e_ident", "e_keytype", "e_regid", "e_skey_id", "e_skey_val", "e_skey_sig",
    ]
    ordered = [key for key in preferred if key in params] + sorted(key for key in params if key not in set(preferred))
    plain = "&".join(f"{quote_form(key)}={params[key] if key in raw_keys else quote_form(params[key])}" for key in ordered)
    return plain, ordered


def encrypt_wasafe(plain: str) -> str:
    server = x25519.X25519PublicKey.from_public_bytes(bytes.fromhex(SERVER_PUBLIC_KEY_HEX))
    private = x25519.X25519PrivateKey.generate()
    public = private.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    shared = private.exchange(server)
    sealed = AESGCM(shared).encrypt(b"\x00" * 12, plain.encode("utf-8"), None)
    return b64u(public + sealed)


def normalize_proxy(value: str) -> str:
    value = value.strip()
    if not value:
        return ""
    if "://" not in value:
        return "http://" + value
    return value


def summarize_exist(data: dict[str, object]) -> dict[str, object]:
    methods = data.get("fallback_methods") if isinstance(data.get("fallback_methods"), list) else []
    login = str(data.get("login") or "")
    reason = str(data.get("reason") or data.get("failure_reason") or "")
    status = str(data.get("status") or "")
    request_failed = (reason == "incorrect" and not login) or reason in {"missing_param", "bad_param", "bad_token", "old_version", "invalid_skey"}
    return {
        "status": status,
        "reason": reason,
        "login": login,
        "registered": bool(login),
        "request_failed": request_failed,
        "fallback_methods": methods,
        "sms_wait": data.get("sms_wait"),
        "send_sms_wait": data.get("send_sms_wait"),
        "voice_wait": data.get("voice_wait"),
        "wa_old_wait": data.get("wa_old_wait"),
        "email_otp_wait": data.get("email_otp_wait"),
        "flash_wait": data.get("flash_wait"),
    }


def summarize_code(data: dict[str, object]) -> dict[str, object]:
    reason = str(data.get("reason") or data.get("failure_reason") or "")
    status = str(data.get("status") or "")
    return {
        "status": status,
        "reason": reason,
        "request_failed": reason in {"missing_param", "bad_param", "bad_token", "old_version", "invalid_skey"},
        "length": data.get("length"),
        "sms_wait": data.get("sms_wait"),
        "send_sms_wait": data.get("send_sms_wait"),
        "voice_wait": data.get("voice_wait"),
        "wa_old_wait": data.get("wa_old_wait"),
        "email_otp_wait": data.get("email_otp_wait"),
        "flash_wait": data.get("flash_wait"),
    }


def post_once(state: ProbeState, kind: str, proxy: str, timeout: float) -> dict[str, object]:
    url = EXIST_URL if kind == "exist" else CODE_URL
    plain, keys = build_plain(state, kind)
    enc = encrypt_wasafe(plain)
    body = "ENC=" + enc + "&H="
    headers = {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
        "WaMsysRequest": "1",
        "X-Forwarded-Host": "v.whatsapp.net",
    }
    proxies = {"http": proxy, "https": proxy} if proxy else None
    response = requests.post(url, headers=headers, data=body, proxies=proxies, timeout=timeout, verify=False)
    try:
        parsed = response.json()
    except ValueError:
        parsed = {"raw": response.text[:500]}
    summary = summarize_exist(parsed) if kind == "exist" else summarize_code(parsed)
    return {
        "kind": kind,
        "http_status": response.status_code,
        "cc": state.cc,
        "in": state.national,
        "fingerprint_id": state.fingerprint_id,
        "plain_len": len(plain),
        "body_len": len(body),
        "param_count": len(keys),
        "summary": summary,
        "raw": parsed,
    }


def run_probe(repo_root: Path, args: argparse.Namespace, key_bundle_fixture: dict[str, str], previous_fingerprint_id: str) -> tuple[dict[str, object], str]:
    state = new_probe_state(repo_root, args.phone, args.cc, args.operator_mode, key_bundle_fixture)
    exist = post_once(state, "exist", args.proxy, args.timeout)
    time.sleep(args.sleep_between_requests + random.random() * 0.1)
    code = post_once(state, "code", args.proxy, args.timeout)
    result = {
        "probe": args.current_probe,
        "fingerprint": state.fingerprint_summary,
        "changed_from_previous_probe": bool(previous_fingerprint_id) and previous_fingerprint_id != state.fingerprint_id,
        "same_fingerprint_between_requests": exist["fingerprint_id"] == code["fingerprint_id"] == state.fingerprint_id,
        "exist": exist,
        "code": code,
    }
    return result, state.fingerprint_id


def main() -> None:
    parser = argparse.ArgumentParser(description="Send one or more WA probe lifecycles through a proxy. Each lifecycle uses one fresh fingerprint for both /v2/exist and /v2/code.")
    parser.add_argument("--phone", default="+8600000000000")
    parser.add_argument("--cc", default="86")
    parser.add_argument("--proxy", default="http://127.0.0.1:10814")
    parser.add_argument("--probes", "--repeat", dest="probes", type=int, default=1)
    parser.add_argument("--sleep-between-requests", type=float, default=0.35)
    parser.add_argument("--sleep-between-probes", type=float, default=0.7)
    parser.add_argument("--timeout", type=float, default=20)
    parser.add_argument("--operator-mode", choices=["mapped", "omit", "empty"], default="mapped", help="mapped includes mcc/mnc/sim_mcc/sim_mnc; omit excludes them; empty sends empty values for comparison")
    parser.add_argument("--key-bundle-json", default="", help="optional local fixture JSON containing authkey/e_* params; omit this to generate a fresh self-consistent key bundle per probe")
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parents[1]
    args.proxy = normalize_proxy(args.proxy)
    key_bundle_fixture = fixture_key_bundle(args.key_bundle_json)
    previous = ""
    registered_values = []
    fingerprint_ids = []
    for index in range(args.probes):
        args.current_probe = index + 1
        result, previous = run_probe(repo_root, args, key_bundle_fixture, previous)
        fingerprint_ids.append(previous)
        exist_summary = result["exist"].get("summary") if isinstance(result.get("exist"), dict) else {}
        if isinstance(exist_summary, dict):
            registered_values.append(exist_summary.get("registered"))
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        if index + 1 < args.probes:
            time.sleep(args.sleep_between_probes + random.random() * 0.2)
    print(json.dumps({
        "probes": args.probes,
        "unique_fingerprints": len(set(fingerprint_ids)),
        "all_probe_fingerprints_unique": len(set(fingerprint_ids)) == len(fingerprint_ids),
        "registered_values": registered_values,
        "consistent_registered": len(set(registered_values)) == 1 if registered_values else None,
    }, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
