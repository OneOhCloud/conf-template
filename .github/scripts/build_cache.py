#!/usr/bin/env python3
"""
Build sing-box rule cache databases from mixed-global.jsonc configs.

Expects:
  - ENV_BRANCH env var (dev / beta / stable)
  - Config files at _source/conf/{version}/{locale}/mixed-rules.jsonc
  - Output goes to database/{env}/{version}/{locale}/*.db

For each config:
  1. Convert JSONC to JSON
  2. Set experimental.cache_file.path = "data.db"
  3. Download the matching sing-box binary for that version
  4. Run sing-box to populate the cache
  5. Copy data.db → database/{env}/{version}/{locale}/mixed-cache-rule-v1.db
                   database/{env}/{version}/{locale}/tun-cache-rule-v1.db
"""

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import time
import urllib.request


def strip_jsonc(text: str) -> str:
    """Strip // comments and trailing commas from JSONC text."""
    result = []
    i = 0
    in_string = False
    while i < len(text):
        c = text[i]
        if c == '"' and (i == 0 or text[i - 1] != "\\"):
            in_string = not in_string
        elif not in_string and text[i : i + 2] == "//":
            # Skip to end of line
            while i < len(text) and text[i] != "\n":
                i += 1
            continue
        result.append(c)
        i += 1
    cleaned = "".join(result)
    # Remove trailing commas before } or ]
    cleaned = re.sub(r",\s*([\]}])", r"\1", cleaned)
    return cleaned


def get_latest_singbox_version(minor: str) -> str:
    """Query GitHub API for the latest stable sing-box release matching minor version."""
    token = os.environ.get("GITHUB_TOKEN", "")
    headers = {"User-Agent": "github-actions/build-cache"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    url = "https://api.github.com/repos/SagerNet/sing-box/releases?per_page=100"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as resp:
        releases = json.load(resp)

    pattern = re.compile(r"^" + re.escape(minor) + r"\.")
    for release in releases:
        if release.get("prerelease") or release.get("draft"):
            continue
        tag_clean = release["tag_name"].lstrip("v")
        if pattern.match(tag_clean):
            return release["tag_name"]  # e.g. "v1.13.0"

    raise RuntimeError(f"No stable sing-box release found for {minor}.x")


def download_singbox(version: str, dest_dir: str) -> str:
    """Download and extract sing-box binary, return path to the binary."""
    version_clean = version.lstrip("v")
    filename = f"sing-box-{version_clean}-linux-amd64"
    archive_url = (
        f"https://github.com/SagerNet/sing-box/releases/download/"
        f"{version}/{filename}.tar.gz"
    )

    os.makedirs(dest_dir, exist_ok=True)
    archive_path = os.path.join(dest_dir, f"{filename}.tar.gz")

    print(f"  Downloading sing-box {version} ...")
    token = os.environ.get("GITHUB_TOKEN", "")
    headers = {"User-Agent": "github-actions/build-cache"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    req = urllib.request.Request(archive_url, headers=headers)
    with urllib.request.urlopen(req, timeout=120) as resp, open(archive_path, "wb") as f:
        shutil.copyfileobj(resp, f)

    with tarfile.open(archive_path) as tar:
        tar.extractall(dest_dir, filter="data")

    binary = os.path.join(dest_dir, filename, "sing-box")
    os.chmod(binary, 0o755)
    print(f"  sing-box binary ready: {binary}")
    return binary


def build_config(jsonc_path: str, output_path: str) -> None:
    """Convert JSONC config to JSON, set cache_file path, and ensure outbounds are valid."""
    with open(jsonc_path, encoding="utf-8") as f:
        raw = f.read()

    config = json.loads(strip_jsonc(raw))
    config.setdefault("experimental", {})["cache_file"] = {"enabled": True, "path": "data.db"}

    # sing-box rejects urltest/selector outbounds with an empty outbounds list.
    # Patch them to include "direct" so the process can start successfully.
    for ob in config.get("outbounds", []):
        if ob.get("type") in ("urltest", "selector") and not ob.get("outbounds"):
            ob["outbounds"] = ["direct"]

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)


def run_singbox(binary: str, config_path: str, work_dir: str, timeout: int = 300) -> None:
    """Start sing-box and stop it once 'sing-box started' appears in the log.

    sing-box logs this line only after all remote rule sets have been downloaded
    and cached, so the DB is fully populated at that point.
    Max wait is `timeout` seconds (default 5 min) in case of slow networks.
    """
    log_path = os.path.join(work_dir, "singbox.log")
    print(f"  Starting sing-box (log → {log_path}, max {timeout}s) ...")

    with open(log_path, "w") as log_f:
        proc = subprocess.Popen(
            [binary, "run", "-c", config_path],
            cwd=work_dir,
            stdout=log_f,
            stderr=subprocess.STDOUT,
        )

    deadline = time.monotonic() + timeout
    ready = False

    with open(log_path) as log_r:
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                # Process exited on its own
                break
            line = log_r.readline()
            if not line:
                time.sleep(0.5)
                continue
            print(f"  [sing-box] {line.rstrip()}")
            if "sing-box started" in line.lower():
                ready = True
                break

    if ready:
        print("  sing-box started — all rule sets cached, stopping ...")
    elif proc.poll() is not None:
        rc = proc.returncode
        print(f"  sing-box exited with code {rc}")
        # Print tail of log for diagnosis
        with open(log_path) as f:
            tail = f.readlines()[-30:]
        for l in tail:
            print(f"  [sing-box] {l.rstrip()}")
    else:
        print(f"  Timeout ({timeout}s) reached, stopping sing-box ...")

    if proc.poll() is None:
        proc.send_signal(signal.SIGTERM)
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()

    print("  sing-box stopped.")


def process(env_branch: str, version: str, locale: str, singbox_binary: str) -> bool:
    """Process one env/version/locale combination. Returns True on success."""
    jsonc_path = os.path.join("_source", "conf", version, locale, "mixed-rules.jsonc")
    if not os.path.exists(jsonc_path):
        print(f"  Skipping: {jsonc_path} not found")
        return False

    work_dir = f"/tmp/singbox-work-{env_branch}-{version}-{locale}"
    os.makedirs(work_dir, exist_ok=True)

    config_path = os.path.join(work_dir, "config.json")
    db_path = os.path.join(work_dir, "data.db")

    print(f"  Converting {jsonc_path} → {config_path}")
    build_config(jsonc_path, config_path)

    run_singbox(singbox_binary, config_path, work_dir)

    if not os.path.exists(db_path):
        print(f"  WARNING: data.db not found in {work_dir}, skipping copy")
        return False

    out_dir = os.path.join("database", env_branch, version, locale)
    os.makedirs(out_dir, exist_ok=True)

    mixed_db = os.path.join(out_dir, "mixed-cache-rule-v1.db")
    tun_db = os.path.join(out_dir, "tun-cache-rule-v1.db")
    shutil.copy2(db_path, mixed_db)
    shutil.copy2(db_path, tun_db)
    print(f"  Copied data.db → {mixed_db}")
    print(f"  Copied data.db → {tun_db}")
    return True


def main() -> None:
    env_branch = os.environ.get("ENV_BRANCH", "")
    if not env_branch:
        print("ERROR: ENV_BRANCH environment variable is required.", file=sys.stderr)
        sys.exit(1)

    conf_base = os.path.join("_source", "conf")
    if not os.path.isdir(conf_base):
        print(f"ERROR: '{conf_base}' directory not found.", file=sys.stderr)
        sys.exit(1)

    print(f"Building cache for environment: {env_branch}")

    versions = sorted(
        d for d in os.listdir(conf_base) if os.path.isdir(os.path.join(conf_base, d))
    )
    if not versions:
        print("No version directories found under conf/", file=sys.stderr)
        sys.exit(1)

    # Cache downloaded binaries: one per minor version
    binaries: dict[str, str] = {}
    download_base = "/tmp/singbox-downloads"

    for version in versions:
        print(f"\n{'='*50}")
        print(f"Version: {version}")
        print(f"{'='*50}")

        # Download sing-box once per version
        if version not in binaries:
            try:
                sb_version = get_latest_singbox_version(version)
                print(f"  Latest sing-box for {version}.x: {sb_version}")
                binaries[version] = download_singbox(
                    sb_version, os.path.join(download_base, version)
                )
            except Exception as exc:
                print(f"  ERROR: Could not obtain sing-box for {version}: {exc}", file=sys.stderr)
                continue

        singbox_binary = binaries[version]

        # Process each locale
        version_dir = os.path.join(conf_base, version)
        locales = sorted(
            d for d in os.listdir(version_dir) if os.path.isdir(os.path.join(version_dir, d))
        )
        for locale in locales:
            print(f"\n  Locale: {locale}")
            ok = process(env_branch, version, locale, singbox_binary)
            if ok:
                print(f"  Done: {env_branch}/{version}/{locale}")
            else:
                print(f"  FAILED: {env_branch}/{version}/{locale}")


if __name__ == "__main__":
    main()
