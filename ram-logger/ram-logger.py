#!/usr/bin/env python3
"""
FiberQuest RAM Logger
=====================
Connects to RetroArch via UDP network commands, polls RAM addresses from a
game JSON config, and logs everything to a JSONL session file.

Usage:
  python3 ram-logger.py --game goldeneye-007 --poll 500
  python3 ram-logger.py --game tetris-nes --poll 250 --host 192.168.68.88

Controls (while running):
  q       Quit
  s       Save a snapshot (manual bookmark)
  p       Pause/resume polling
  ?       Print current values

Output:
  sessions/<game>_<timestamp>.jsonl   — one JSON object per poll
  sessions/<game>_<timestamp>.log     — human-readable log

Requires:
  pip3 install curses   (usually built-in)
"""

import socket
import json
import time
import argparse
import sys
import os
import threading
import struct
from datetime import datetime
from pathlib import Path

# ── RetroArch UDP interface ───────────────────────────────────────────────────

RA_PORT = 55355
RA_TIMEOUT = 0.5  # seconds

def ra_send(sock, host, cmd):
    """Send a RetroArch network command, return response string."""
    try:
        sock.sendto(cmd.encode(), (host, RA_PORT))
        data, _ = sock.recvfrom(4096)
        return data.decode().strip()
    except socket.timeout:
        return None
    except Exception as e:
        return None

def ra_read_memory(sock, host, address, size):
    """
    Read `size` bytes from RetroArch RAM at `address`.
    Uses READ_CORE_MEMORY command (RetroArch 1.9+).
    Returns list of ints, or None on failure.
    """
    cmd = f"READ_CORE_MEMORY {address:#x} {size}"
    resp = ra_send(sock, host, cmd)
    if not resp:
        return None
    # Response: "READ_CORE_MEMORY 0x1234 ff 00 ab cd"
    parts = resp.split()
    if len(parts) < 3 or parts[0] != "READ_CORE_MEMORY":
        return None
    try:
        return [int(b, 16) for b in parts[2:]]
    except ValueError:
        return None

def ra_get_game_id(sock, host):
    """Return current running game info."""
    info = {}
    for cmd in ["GET_STATUS", "GET_CONFIG_PARAM game_path"]:
        resp = ra_send(sock, host, cmd)
        if resp:
            info[cmd] = resp
    return info

# ── Address decoding ──────────────────────────────────────────────────────────

def decode_value(raw_bytes, addr_spec):
    """Decode raw bytes per the address spec."""
    if not raw_bytes:
        return None
    enc = addr_spec.get("encoding", "decimal")
    t   = addr_spec.get("type", "uint8")

    if t == "uint8":
        v = raw_bytes[0]
    elif t == "uint16_be":
        v = (raw_bytes[0] << 8) | raw_bytes[1] if len(raw_bytes) >= 2 else raw_bytes[0]
    elif t == "uint16_le":
        v = raw_bytes[0] | (raw_bytes[1] << 8) if len(raw_bytes) >= 2 else raw_bytes[0]
    elif t == "uint32_be":
        v = int.from_bytes(raw_bytes[:4], "big")
    elif t == "uint32_le":
        v = int.from_bytes(raw_bytes[:4], "little")
    elif t == "bcd":
        # BCD decode: each nibble is a decimal digit
        v = 0
        for b in raw_bytes:
            v = v * 100 + ((b >> 4) * 10 + (b & 0xF))
    else:
        v = raw_bytes[0]

    if enc == "hex":
        return hex(v)
    return v

# ── Session logger ────────────────────────────────────────────────────────────

class RAMLogger:
    def __init__(self, game_config, host, poll_ms, output_dir):
        self.config = game_config
        self.host = host
        self.poll_interval = poll_ms / 1000.0
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)

        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        game_id = game_config.get("id", "unknown")
        self.jsonl_path = self.output_dir / f"{game_id}_{ts}.jsonl"
        self.log_path   = self.output_dir / f"{game_id}_{ts}.log"

        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.settimeout(RA_TIMEOUT)

        self.paused = False
        self.running = True
        self.snapshot_requested = False
        self.poll_count = 0
        self.last_values = {}
        self.changes = []  # track state changes

        self._log(f"FiberQuest RAM Logger started")
        self._log(f"Game:    {game_config.get('title', 'Unknown')}")
        self._log(f"Host:    {host}:{RA_PORT}")
        self._log(f"Poll:    {poll_ms}ms")
        self._log(f"Output:  {self.jsonl_path}")
        self._log(f"")

    def _log(self, msg):
        ts = datetime.now().strftime("%H:%M:%S.%f")[:-3]
        line = f"[{ts}] {msg}"
        print(line)
        with open(self.log_path, "a") as f:
            f.write(line + "\n")

    def _write_jsonl(self, record):
        with open(self.jsonl_path, "a") as f:
            f.write(json.dumps(record) + "\n")

    def poll(self):
        """Single poll cycle — read all addresses, return dict of values."""
        addrs = self.config.get("ram_addresses", {})
        values = {}
        raw_map = {}

        for name, spec in addrs.items():
            addr_str = spec.get("address", "0x0000")
            size     = spec.get("size", 1)
            try:
                addr_int = int(addr_str, 16)
            except ValueError:
                continue

            raw = ra_read_memory(self.sock, self.host, addr_int, size)
            raw_map[name] = raw
            values[name] = decode_value(raw, spec)

        return values, raw_map

    def run(self):
        """Main polling loop."""
        self._log("Connecting to RetroArch...")

        # Verify connection
        status = ra_send(self.sock, self.host, "GET_STATUS")
        if not status:
            self._log(f"ERROR: No response from RetroArch at {self.host}:{RA_PORT}")
            self._log("Make sure RetroArch is running with network_cmd_enable=true")
            self._log("and a game is loaded.")
            return

        self._log(f"Connected! Status: {status}")
        self._log("")
        self._log("Polling... press Ctrl+C to stop, 's' + Enter for snapshot")
        self._log("")

        # Print header
        addr_names = list(self.config.get("ram_addresses", {}).keys())
        header = f"{'POLL':>6} | {'TIME':>12} | " + " | ".join(f"{n:>12}" for n in addr_names)
        self._log(header)
        self._log("-" * len(header))

        try:
            while self.running:
                if self.paused:
                    time.sleep(0.1)
                    continue

                t_start = time.time()
                values, raw_map = self.poll()
                self.poll_count += 1
                now = datetime.now()
                ts_ms = int(now.timestamp() * 1000)

                # Detect changes
                changed = {}
                for k, v in values.items():
                    if k not in self.last_values or self.last_values[k] != v:
                        changed[k] = {"from": self.last_values.get(k), "to": v}
                self.last_values = values.copy()

                # Build record
                record = {
                    "ts": ts_ms,
                    "poll": self.poll_count,
                    "game": self.config.get("id"),
                    "values": values,
                    "raw": {k: v for k, v in raw_map.items() if v is not None},
                    "changed": changed,
                    "snapshot": self.snapshot_requested,
                }
                if self.snapshot_requested:
                    record["snapshot_note"] = "manual"
                    self.snapshot_requested = False
                    self._log("📸 SNAPSHOT saved")

                self._write_jsonl(record)

                # Log changed values (always log first poll, then changes)
                if self.poll_count == 1 or changed:
                    row = f"{self.poll_count:>6} | {now.strftime('%H:%M:%S.%f')[:-3]:>12} | "
                    row += " | ".join(
                        f"{str(values.get(n, '?')):>12}"
                        for n in addr_names
                    )
                    marker = " ◀ CHANGE" if (changed and self.poll_count > 1) else ""
                    self._log(row + marker)

                    if changed and self.poll_count > 1:
                        for k, delta in changed.items():
                            self._log(f"         → {k}: {delta['from']} → {delta['to']}")

                # Sleep for remainder of interval
                elapsed = time.time() - t_start
                sleep_time = max(0, self.poll_interval - elapsed)
                time.sleep(sleep_time)

        except KeyboardInterrupt:
            self._log("")
            self._log(f"Stopped. {self.poll_count} polls written to {self.jsonl_path}")

    def request_snapshot(self):
        self.snapshot_requested = True

    def toggle_pause(self):
        self.paused = not self.paused
        state = "PAUSED" if self.paused else "RESUMED"
        self._log(f"Polling {state}")

    def print_current(self):
        values, _ = self.poll()
        self._log("Current values:")
        for k, v in values.items():
            self._log(f"  {k}: {v}")


# ── CLI ───────────────────────────────────────────────────────────────────────

def load_game_config(game_id, games_dir):
    """Load game JSON by id or partial match."""
    games_dir = Path(games_dir)
    # Try exact filename first
    exact = games_dir / f"{game_id}.json"
    if exact.exists():
        with open(exact) as f:
            return json.load(f)
    # Search by id field
    for p in games_dir.glob("*.json"):
        with open(p) as f:
            try:
                cfg = json.load(f)
                if cfg.get("id", "") == game_id or game_id in p.stem:
                    return cfg
            except json.JSONDecodeError:
                continue
    return None

def list_games(games_dir):
    games_dir = Path(games_dir)
    print("\nAvailable games:")
    for p in sorted(games_dir.glob("*.json")):
        try:
            with open(p) as f:
                cfg = json.load(f)
            addrs = cfg.get("ram_addresses", {})
            conf = cfg.get("confidence", "?")
            print(f"  {cfg.get('id','?'):35s}  {len(addrs):2d} addrs  [{conf}]  {cfg.get('title','')}")
        except Exception:
            print(f"  {p.stem} (parse error)")
    print()


def main():
    parser = argparse.ArgumentParser(
        description="FiberQuest RAM Logger — poll RetroArch memory addresses and log to JSONL"
    )
    parser.add_argument("--game", "-g", help="Game ID (e.g. goldeneye-007, tetris-nes)")
    parser.add_argument("--list", "-l", action="store_true", help="List available games")
    parser.add_argument("--host", default="localhost", help="RetroArch host (default: localhost)")
    parser.add_argument("--port", type=int, default=55355, help="RetroArch UDP port (default: 55355)")
    parser.add_argument("--poll", type=int, default=500, help="Poll interval in ms (default: 500)")
    parser.add_argument("--games-dir", default="./games", help="Path to game JSON files")
    parser.add_argument("--output-dir", default="./sessions", help="Output directory for logs")
    args = parser.parse_args()

    if args.list or not args.game:
        list_games(args.games_dir)
        if not args.game:
            print("Usage: python3 ram-logger.py --game <game-id> [--host 192.168.68.88]")
            sys.exit(0)

    # Load game config
    config = load_game_config(args.game, args.games_dir)
    if not config:
        print(f"ERROR: Game '{args.game}' not found in {args.games_dir}")
        list_games(args.games_dir)
        sys.exit(1)

    print(f"\n{'='*60}")
    print(f"  FiberQuest RAM Logger")
    print(f"  Game:  {config.get('title')} ({config.get('platform')})")
    print(f"  Addrs: {', '.join(config.get('ram_addresses', {}).keys())}")
    print(f"{'='*60}\n")

    global RA_PORT
    RA_PORT = args.port

    logger = RAMLogger(
        game_config=config,
        host=args.host,
        poll_ms=args.poll,
        output_dir=args.output_dir,
    )

    # Input thread for interactive commands
    def input_thread():
        while logger.running:
            try:
                cmd = input()
                if cmd.strip().lower() in ("q", "quit", "exit"):
                    logger.running = False
                elif cmd.strip().lower() == "s":
                    logger.request_snapshot()
                elif cmd.strip().lower() == "p":
                    logger.toggle_pause()
                elif cmd.strip().lower() == "?":
                    logger.print_current()
            except EOFError:
                break

    t = threading.Thread(target=input_thread, daemon=True)
    t.start()

    logger.run()


if __name__ == "__main__":
    main()
