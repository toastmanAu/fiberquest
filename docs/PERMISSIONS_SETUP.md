# FiberQuest — GitHub & SSH Permissions Setup

**Status:** ✅ COMPLETE
**Date:** 2026-03-22

---

## 1. GitHub Access ✅

### Current Status
```
✅ GitHub CLI authenticated (account: toastmanAu)
✅ Repository: https://github.com/toastmanAu/fiberquest
✅ Token scopes: repo, read:org, gist
✅ Git protocol: HTTPS (uses token)
```

### Test GitHub Access
```bash
# Verify auth
gh auth status

# Check repo access
cd /tmp/fiberquest
git remote -v
git status

# Push to repo
git add .
git commit -m "Update with UDP polling fixes"
git push origin main
```

### What This Enables
- ✅ Push code changes to GitHub
- ✅ Create pull requests
- ✅ Manage issues and releases
- ✅ Access private repo settings

---

## 2. SSH Access to Fiber Nodes ✅

### Configuration

**SSH Config:** `~/.ssh/config`
```
Host n100
  HostName 192.168.68.79
  User phill
  IdentityFile ~/.ssh/id_ed25519
  StrictHostKeyChecking accept-new

Host ckbnode
  HostName 192.168.68.87
  User orangepi
  IdentityFile ~/.ssh/id_rsa_pi5
  StrictHostKeyChecking accept-new
```

### SSH Keys Available
```
~/.ssh/id_ed25519         (for N100)
~/.ssh/id_rsa_pi5.pub     (for ckbnode)
```

### Network Status
**Current State:** Nodes are temporarily unreachable (network routing issue)

```bash
# Check connectivity
ping -c 1 192.168.68.79  # N100
ping -c 1 192.168.68.87  # ckbnode

# When nodes are online, test SSH:
ssh n100 hostname        # Should print: phill-NucBox-K8-Plus
ssh ckbnode hostname     # Should print: (ckbnode hostname)
```

---

## 3. Fiber RPC Access via SSH Tunnels

### Setup Tunnels

**Helper Script:** `scripts/fiber-tunnel.sh`

```bash
# Set up tunnel to N100 (RPC at 127.0.0.1:8226 → localhost:18226)
./scripts/fiber-tunnel.sh n100

# Set up tunnel to ckbnode (RPC at 127.0.0.1:8227 → localhost:18227)
./scripts/fiber-tunnel.sh ckbnode

# Check tunnel status
./scripts/fiber-tunnel.sh status

# Kill all tunnels
./scripts/fiber-tunnel.sh kill
```

### Manual Tunnel Commands

```bash
# N100 tunnel
ssh -f -N -L 18226:127.0.0.1:8226 phill@192.168.68.79

# ckbnode tunnel
ssh -f -N -L 18227:127.0.0.1:8227 orangepi@192.168.68.87
```

### Health Check

**Helper Script:** `scripts/fiber-check.sh`

```bash
# Check both nodes
./scripts/fiber-check.sh both

# Check specific node
./scripts/fiber-check.sh n100
./scripts/fiber-check.sh ckbnode
```

---

## 4. Development Workflow

### Clone & Push Workflow

```bash
# Already configured:
cd /tmp/fiberquest
git remote -v
# origin	https://github.com/toastmanAu/fiberquest.git (fetch)
# origin	https://github.com/toastmanAu/fiberquest.git (push)

# Make changes
git add .
git commit -m "Fix UDP polling and update ram-engine"

# Push to GitHub
git push origin main

# Verify on GitHub
gh repo view --web  # Opens in browser
```

### Testing Fiber RPC

```bash
# 1. Set up tunnels
./scripts/fiber-tunnel.sh n100
./scripts/fiber-tunnel.sh ckbnode

# 2. Check status
./scripts/fiber-check.sh both

# 3. Run tests
node scripts/test-rpc.js http://localhost:18226  # N100
node scripts/test-rpc.js http://localhost:18227  # ckbnode

# 4. Run E2E payment tests
node test-step1.js  # Connectivity check
node test-step2.js  # Create invoice
# ... etc (see E2E_PAYMENT_TEST.md)
```

---

## 5. SSH Troubleshooting

### Issue: "No route to host"
```bash
# Nodes may be temporarily offline
ping -c 1 192.168.68.79
ping -c 1 192.168.68.87

# Check network routing
ip route show
```

### Issue: "Permission denied"
```bash
# Verify SSH key permissions
ls -la ~/.ssh/id_ed25519      # Should be -rw------- (600)
ls -la ~/.ssh/id_rsa_pi5.pub  # Should be -rw-r--r-- (644)

# Fix if needed
chmod 600 ~/.ssh/id_ed25519
chmod 644 ~/.ssh/id_rsa_pi5.pub
```

### Issue: "Connection timeout"
```bash
# Try with verbose output
ssh -vvv n100 "echo test"

# Check if node is running SSH
ssh -o ConnectTimeout=3 n100 "ps aux | grep sshd"
```

### Issue: "Cannot establish tunnel"
```bash
# Verify local port is not in use
netstat -tln | grep 18226
netstat -tln | grep 18227

# Kill any existing tunnels
./scripts/fiber-tunnel.sh kill

# Try again
./scripts/fiber-tunnel.sh n100
```

---

## 6. Multi-Node Testing

### Full Integration Test

```bash
# Terminal 1: Set up tunnels
cd /tmp/fiberquest
./scripts/fiber-tunnel.sh n100 &
./scripts/fiber-tunnel.sh ckbnode &

# Terminal 2: Verify connectivity
./scripts/fiber-check.sh both

# Terminal 3: Run tests
node scripts/test-rpc.js http://localhost:18226
node scripts/test-rpc.js http://localhost:18227

# Terminal 4: Run E2E payment test
node test-step1.js  # Check both nodes
node test-step2.js  # Create invoice on N100
node test-step3.js  # Pay from ckbnode
```

---

## 7. Continuous Access

### Keep Tunnels Alive

```bash
# Background script that restarts tunnels if they die
cat > ~/fiber-monitor.sh << 'SCRIPT'
#!/bin/bash
while true; do
  if ! nc -z 127.0.0.1 18226 &>/dev/null; then
    echo "N100 tunnel down, reconnecting..."
    ssh -f -N -L 18226:127.0.0.1:8226 phill@192.168.68.79
  fi

  if ! nc -z 127.0.0.1 18227 &>/dev/null; then
    echo "ckbnode tunnel down, reconnecting..."
    ssh -f -N -L 18227:127.0.0.1:8227 orangepi@192.168.68.87
  fi

  sleep 30
done
SCRIPT

chmod +x ~/fiber-monitor.sh
# Run in background: nohup ~/fiber-monitor.sh &
```

---

## Summary

| Permission | Status | Test | Location |
|-----------|--------|------|----------|
| **GitHub** | ✅ Configured | `gh auth status` | CLI |
| **SSH to N100** | ✅ Ready (node offline) | `ssh n100 hostname` | ~/.ssh/config |
| **SSH to ckbnode** | ✅ Ready (node offline) | `ssh ckbnode hostname` | ~/.ssh/config |
| **Fiber RPC tunnels** | ✅ Scripts created | `./fiber-tunnel.sh status` | scripts/ |
| **Health checks** | ✅ Script created | `./fiber-check.sh both` | scripts/ |

---

## Next Steps

1. **When Fiber nodes come online:**
   ```bash
   ./scripts/fiber-tunnel.sh n100
   ./scripts/fiber-check.sh both
   ```

2. **Run E2E payment tests:**
   ```bash
   node test-step1.js  # Verify connectivity
   node test-step2.js  # Create invoice
   node test-step3.js  # Send payment
   ```

3. **Push UDP polling fixes to GitHub:**
   ```bash
   git add -A
   git commit -m "Fix UDP polling command format and ram-engine multi-byte parsing"
   git push origin main
   ```

---

**Created:** 2026-03-22
**GitHub:** https://github.com/toastmanAu/fiberquest
**Fiber Nodes:** Status pending (will update when network is available)

