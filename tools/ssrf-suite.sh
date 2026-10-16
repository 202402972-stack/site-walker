#!/usr/bin/env bash
# SSRF suite — plan A6. Run against local or deployed API.
# Usage: BASE=http://localhost:8080 TOKEN=... bash tools/ssrf-suite.sh
set -u
BASE="${BASE:-http://localhost:8080}"
TOKEN="${TOKEN:-test-token}"
pass=0; fail=0
check() {
  local url="$1"; local expect="$2"; local label="$3"
  code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/jobs" -H "Content-Type: application/json" -H "Cookie: session=$TOKEN" -d "{\"url\":\"$url\"}")
  if [ "$code" = "$expect" ]; then echo "PASS $label ($code)"; pass=$((pass+1)); else echo "FAIL $label (got $code, want $expect)"; fail=$((fail+1)); fi
}
for u in "http://127.0.0.1/" "http://localhost/" "http://[::1]/" "http://169.254.169.254/" "http://10.0.0.5/" "http://172.16.0.1/" "http://192.168.1.1/" "http://2130706433/" "http://0x7f.0x0.0x0.0x1/" "http://[::ffff:127.0.0.1]/" "http://x.railway.internal/" "file:///etc/passwd"; do
  check "$u" "403" "blocked $u"
done
echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
