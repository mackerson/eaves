#!/usr/bin/env bash
# Kill orphaned Electron and Vite dev processes, excluding our own process tree.
MY_PID=$$
MY_PPID=$(ps -o ppid= -p $MY_PID | tr -d ' ')

killed=0
for pid in $(pgrep -f 'electron.*enclave|vite.*enclave' 2>/dev/null); do
  # Skip our own process tree
  if [ "$pid" = "$MY_PID" ] || [ "$pid" = "$MY_PPID" ]; then
    continue
  fi
  # Skip if pid is an ancestor of us
  ancestor=$MY_PPID
  is_ancestor=false
  while [ "$ancestor" != "1" ] && [ -n "$ancestor" ]; do
    if [ "$pid" = "$ancestor" ]; then
      is_ancestor=true
      break
    fi
    ancestor=$(ps -o ppid= -p "$ancestor" 2>/dev/null | tr -d ' ')
  done
  if $is_ancestor; then
    continue
  fi

  cmd=$(ps -o args= -p "$pid" 2>/dev/null)
  kill "$pid" 2>/dev/null && {
    echo "Killed PID $pid: $cmd"
    killed=$((killed + 1))
  }
done

if [ $killed -eq 0 ]; then
  echo "No orphaned dev processes found."
fi
