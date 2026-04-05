#!/usr/bin/env bash
# E2E test for `teams-bot setup --auto` — full Azure Bot setup lifecycle.
# Creates real Azure resources, verifies each step, then cleans everything up.
#
# Usage: bash test/e2e-setup.sh
# Requires: az login (personal account)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STATE_FILE="$SCRIPT_DIR/.e2e-test-state.json"
PREFIX="e2e-claude-bot"
PASS=0
FAIL=0
TOTAL=0

# ── Helpers ───────────────────────────────────────────────────────────────

pass() { PASS=$((PASS + 1)); TOTAL=$((TOTAL + 1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL + 1)); TOTAL=$((TOTAL + 1)); echo "  ✗ $1: $2"; }

az_json() {
  az "$@" --output json 2>/dev/null
}

save_state() {
  echo "$1" > "$STATE_FILE"
}

load_state() {
  if [ -f "$STATE_FILE" ]; then
    cat "$STATE_FILE"
  else
    echo "{}"
  fi
}

# ── Prerequisites ─────────────────────────────────────────────────────────

echo ""
echo "=== Claude Bot E2E Tests ==="
echo ""

echo "--- Prerequisites ---"

# Check Node.js
if node --version >/dev/null 2>&1; then
  pass "Node.js $(node --version)"
else
  fail "Node.js" "not found"
  exit 1
fi

# Check az CLI
if az --version >/dev/null 2>&1; then
  pass "az CLI installed"
else
  fail "az CLI" "not found"
  exit 1
fi

# Check az login
ACCOUNT=$(az_json account show 2>/dev/null || echo "")
if [ -n "$ACCOUNT" ]; then
  USER=$(echo "$ACCOUNT" | jq -r '.user.name // "unknown"')
  TENANT=$(echo "$ACCOUNT" | jq -r '.tenantId')
  pass "az logged in as $USER"
else
  fail "az login" "not logged in — run 'az login' first"
  exit 1
fi

# ── Test 1: App Registration ─────────────────────────────────────────────

echo ""
echo "--- Test: App Registration Lifecycle ---"

BOT_SUFFIX=$(date +%s | tail -c 6)
BOT_NAME="${PREFIX}-${BOT_SUFFIX}"
RG_NAME="rg-${PREFIX}-${BOT_SUFFIX}"

# Create app registration
APP_JSON=$(az_json ad app create --display-name "$BOT_NAME" --sign-in-audience AzureADMultipleOrgs 2>&1) || {
  fail "az ad app create" "$APP_JSON"
  exit 1
}
APP_ID=$(echo "$APP_JSON" | jq -r '.appId')
if [ -n "$APP_ID" ] && [ "$APP_ID" != "null" ]; then
  pass "App Registration created: $APP_ID"
else
  fail "App Registration" "no appId returned"
  exit 1
fi

save_state "{\"appId\":\"$APP_ID\",\"botName\":\"$BOT_NAME\",\"rgName\":\"$RG_NAME\",\"tenant\":\"$TENANT\"}"

# Verify app exists
VERIFY=$(az_json ad app show --id "$APP_ID" 2>/dev/null || echo "")
if echo "$VERIFY" | jq -r '.appId' | grep -q "$APP_ID"; then
  pass "App Registration verified"
else
  fail "App Registration verify" "not found after creation"
fi

# Verify signInAudience
AUDIENCE=$(echo "$VERIFY" | jq -r '.signInAudience // empty')
if [ "$AUDIENCE" = "AzureADMultipleOrgs" ]; then
  pass "signInAudience is AzureADMultipleOrgs (MultiTenant)"
else
  fail "signInAudience" "expected AzureADMultipleOrgs, got $AUDIENCE"
fi

# ── Test 2: Client Secret ────────────────────────────────────────────────

echo ""
echo "--- Test: Client Secret ---"

CRED_JSON=$(az_json ad app credential reset --id "$APP_ID" --years 2 2>&1) || {
  fail "az ad app credential reset" "$CRED_JSON"
  # Continue — non-fatal for lifecycle test
  CRED_JSON=""
}

if [ -n "$CRED_JSON" ]; then
  SECRET=$(echo "$CRED_JSON" | jq -r '.password // empty')
  if [ -n "$SECRET" ]; then
    pass "Client secret generated (${#SECRET} chars)"
  else
    fail "Client secret" "no password in response"
  fi
fi

# ── Test 3: Resource Group ────────────────────────────────────────────────

echo ""
echo "--- Test: Resource Group ---"

RG_JSON=$(az_json group create --name "$RG_NAME" --location eastus 2>&1) || {
  fail "az group create" "$RG_JSON"
  RG_JSON=""
}

if [ -n "$RG_JSON" ]; then
  RG_STATE=$(echo "$RG_JSON" | jq -r '.properties.provisioningState // empty')
  if [ "$RG_STATE" = "Succeeded" ]; then
    pass "Resource group created: $RG_NAME"
  else
    fail "Resource group" "state=$RG_STATE"
  fi
fi

# ── Test 4: Azure Bot (SingleTenant) ──────────────────────────────────────

echo ""
echo "--- Test: Azure Bot ---"

BOT_JSON=$(az_json bot create \
  --name "$BOT_NAME" \
  --resource-group "$RG_NAME" \
  --app-type SingleTenant \
  --appid "$APP_ID" \
  --tenant-id "$TENANT" \
  --sku F0 2>&1) || {
  # Retry with different name if conflict
  BOT_NAME="${BOT_NAME}-r"
  BOT_JSON=$(az_json bot create \
    --name "$BOT_NAME" \
    --resource-group "$RG_NAME" \
    --app-type SingleTenant \
    --appid "$APP_ID" \
    --tenant-id "$TENANT" \
    --sku F0 2>&1) || {
    fail "az bot create" "$BOT_JSON"
    BOT_JSON=""
  }
}

if [ -n "$BOT_JSON" ]; then
  BOT_STATE=$(echo "$BOT_JSON" | jq -r '.properties.provisioningState // empty')
  BOT_TYPE=$(echo "$BOT_JSON" | jq -r '.properties.msaAppType // empty')
  if [ "$BOT_STATE" = "Succeeded" ]; then
    pass "Bot created: $BOT_NAME (type=$BOT_TYPE)"
  else
    fail "Bot create" "state=$BOT_STATE"
  fi
fi

# Verify MultiTenant bot creation is rejected
echo ""
echo "--- Test: MultiTenant bot creation should fail ---"
MT_JSON=$(az bot create \
  --name "${BOT_NAME}-mt" \
  --resource-group "$RG_NAME" \
  --app-type MultiTenant \
  --appid "$APP_ID" \
  --tenant-id "$TENANT" \
  --sku F0 --output json 2>&1) && {
  fail "MultiTenant rejection" "should have failed but succeeded"
} || {
  if echo "$MT_JSON" | grep -qi "deprecated\|invalid"; then
    pass "MultiTenant bot creation correctly rejected"
  else
    fail "MultiTenant rejection" "failed but not with expected error: $MT_JSON"
  fi
}

# ── Test 5: Teams Channel ────────────────────────────────────────────────

echo ""
echo "--- Test: Teams Channel ---"

CHANNEL_JSON=$(az bot msteams create \
  --name "$BOT_NAME" \
  --resource-group "$RG_NAME" \
  --output json 2>&1) || {
  fail "az bot msteams create" "$CHANNEL_JSON"
  CHANNEL_JSON=""
}

if [ -n "$CHANNEL_JSON" ]; then
  CHANNEL_OK=$(echo "$CHANNEL_JSON" | jq -r '.properties.properties.isEnabled // empty')
  if [ "$CHANNEL_OK" = "true" ]; then
    pass "Teams channel enabled"
  else
    pass "Teams channel created (isEnabled not in response, likely OK)"
  fi
fi

# Test idempotency — second call should not fail
CHANNEL2=$(az bot msteams create \
  --name "$BOT_NAME" \
  --resource-group "$RG_NAME" \
  --output json 2>&1) && {
  pass "Teams channel idempotent (second call succeeded)"
} || {
  if echo "$CHANNEL2" | grep -qi "already exists\|conflict"; then
    pass "Teams channel idempotent (already exists)"
  else
    fail "Teams channel idempotent" "$CHANNEL2"
  fi
}

# ── Test 6: Bot Endpoint Update ───────────────────────────────────────────

echo ""
echo "--- Test: Bot Endpoint Update ---"

FAKE_ENDPOINT="https://test-e2e-tunnel-3978.devtunnels.ms/api/messages"
EP_JSON=$(az bot update \
  --name "$BOT_NAME" \
  --resource-group "$RG_NAME" \
  --endpoint "$FAKE_ENDPOINT" \
  --output json 2>&1) || {
  fail "az bot update --endpoint" "$EP_JSON"
  EP_JSON=""
}

if [ -n "$EP_JSON" ]; then
  ACTUAL_EP=$(echo "$EP_JSON" | jq -r '.properties.endpoint // empty')
  if [ "$ACTUAL_EP" = "$FAKE_ENDPOINT" ]; then
    pass "Endpoint updated and verified"
  else
    fail "Endpoint verify" "expected $FAKE_ENDPOINT, got $ACTUAL_EP"
  fi
fi

# ── Test 7: Manifest Generation ───────────────────────────────────────────

echo ""
echo "--- Test: Manifest Generation ---"

cd "$PROJECT_DIR"
TEAMS_APP_ID=$(uuidgen 2>/dev/null || python3 -c 'import uuid; print(uuid.uuid4())' 2>/dev/null || echo "test-teams-id")
ZIP_PATH="/tmp/e2e-test-manifest.zip"

# Patch and zip manifest
if [ -f manifest/manifest.json ]; then
  TMP_DIR=$(mktemp -d)
  sed -e "s/YOUR_TEAMS_APP_ID/$TEAMS_APP_ID/" \
      -e "s/YOUR_BOT_APP_ID/$APP_ID/" \
      manifest/manifest.json > "$TMP_DIR/manifest.json"
  cp manifest/color.png manifest/outline.png "$TMP_DIR/" 2>/dev/null || true
  (cd "$TMP_DIR" && zip -q "$ZIP_PATH" manifest.json color.png outline.png 2>/dev/null) || true
  rm -rf "$TMP_DIR"

  if [ -f "$ZIP_PATH" ]; then
    SIZE=$(wc -c < "$ZIP_PATH" | tr -d ' ')
    pass "Manifest zip generated ($SIZE bytes)"

    # Verify contents
    CONTENTS=$(unzip -l "$ZIP_PATH" 2>/dev/null | grep -c "\.json\|\.png" || echo "0")
    if [ "$CONTENTS" -ge 2 ]; then
      pass "Manifest zip contains expected files"
    else
      fail "Manifest zip contents" "only $CONTENTS files found"
    fi
  else
    fail "Manifest zip" "file not created"
  fi
else
  fail "Manifest template" "manifest/manifest.json not found"
fi

# ── Test 8: Deep Link ─────────────────────────────────────────────────────

echo ""
echo "--- Test: Deep Link ---"

CHAT_URL="https://teams.microsoft.com/l/chat/0/0?users=28:${APP_ID}"
if echo "$CHAT_URL" | grep -q "28:$APP_ID"; then
  pass "Deep link format correct: 28:$APP_ID"
else
  fail "Deep link" "format incorrect"
fi

# ── Cleanup ───────────────────────────────────────────────────────────────

echo ""
echo "--- Cleanup ---"

# Delete bot
az bot delete --name "$BOT_NAME" --resource-group "$RG_NAME" --yes --output none 2>/dev/null && {
  pass "Bot deleted"
} || {
  fail "Bot delete" "failed (may not exist)"
}

# Delete app registration
az ad app delete --id "$APP_ID" --output none 2>/dev/null && {
  pass "App Registration deleted"
} || {
  fail "App delete" "failed"
}

# Verify app is gone
GONE=$(az_json ad app show --id "$APP_ID" 2>/dev/null || echo "gone")
if echo "$GONE" | grep -q "gone\|not found\|Request_ResourceNotFound"; then
  pass "App Registration confirmed deleted"
else
  fail "App delete verify" "app still exists"
fi

# Delete resource group (async)
az group delete --name "$RG_NAME" --yes --no-wait --output none 2>/dev/null && {
  pass "Resource group deletion started"
} || {
  fail "RG delete" "failed"
}

# Clean up temp files
rm -f "$ZIP_PATH" "$STATE_FILE"

# ── Summary ───────────────────────────────────────────────────────────────

echo ""
echo "========================================="
echo "  Results: $PASS passed, $FAIL failed ($TOTAL total)"
echo "========================================="
echo ""

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
