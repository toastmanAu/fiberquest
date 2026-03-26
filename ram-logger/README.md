# FiberQuest RAM Logger

Poll RetroArch memory addresses live and log to JSONL.

## Setup

RetroArch must be running with a game loaded. Config required in `~/.config/retroarch/retroarch.cfg`:
```
network_cmd_enable = "true"
network_cmd_port = "55355"
```

## Usage

```bash
cd ~/fiberquest/ram-logger

# List available games
python3 ram-logger.py --list

# Log Tetris NES (RetroArch on this machine)
python3 ram-logger.py --game tetris-nes

# Log GoldenEye (RetroArch on same machine, 500ms poll)
python3 ram-logger.py --game goldeneye-007 --poll 500

# Log from Pi to driveThree
python3 ram-logger.py --game tetris-nes --host 192.168.68.88
```

## Interactive commands (type + Enter while running)
- `s` — save a snapshot/bookmark in the log
- `p` — pause/resume polling
- `?` — print current values
- `q` — quit

## Output
Sessions are saved to `sessions/<game>_<timestamp>.jsonl` — one record per poll.

Each record:
```json
{
  "ts": 1773241404051,
  "poll": 42,
  "game": "tetris-nes",
  "values": {"score": 1200, "level": 3, "lines": 8},
  "raw": {"score": [18, 0, 0]},
  "changed": {"score": {"from": 1100, "to": 1200}},
  "snapshot": false
}
```

## Finding unknown addresses (Simpsons arcade, etc.)

1. Load game in RetroArch
2. Run logger with a placeholder game config that polls a range of addresses
3. Play, watch the log for values that change when you expect them to
4. Confirm address → update game JSON

## Games directory

Point to `~/fiberquest/games/` — all 23 game configs live there.
```bash
python3 ram-logger.py --game simpsons-arcade --games-dir ~/fiberquest/games
```
