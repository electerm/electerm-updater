#!/bin/sh
set -eu
# All operands are passed as separate arguments, including across elevation.
apply() {
  case "$kind" in
    deb) /usr/bin/apt-get install -y "$payload"; return ;;
    rpm)
      if command -v dnf >/dev/null; then dnf -y install "$payload"
      elif command -v zypper >/dev/null; then zypper --non-interactive install "$payload"
      else rpm -U "$payload"; fi
      return ;;
  esac
  parent=$(dirname "$target")
  if [ "$kind" = tar.gz ]; then parent=$target; fi
  if [ "$kind" != dmg ]; then
    exec 9<"$parent"
    flock -n 9 || { echo 'Another update is running'; return 1; }
  fi
  stage=$(mktemp -d "$parent/.electerm-update.XXXXXXXX")
  if [ "$kind" = tar.gz ]; then
    # Swap each shipped top-level entry. The installation may share its
    # directory with a profile or unrelated files.
    mkdir "$stage/new" "$stage/old" "$stage/installed"
    cp -R "$payload/." "$stage/new/"
    rollback() {
      for entry in "$stage/installed/"* "$stage/installed/".[!.]* "$stage/installed/"..?*; do
        [ -e "$entry" ] || continue
        name=${entry##*/}
        mv "$target/$name" "$stage/new/$name" || return 1
      done
      for entry in "$stage/old/"* "$stage/old/".[!.]* "$stage/old/"..?*; do
        [ -e "$entry" ] || [ -L "$entry" ] || continue
        mv "$entry" "$target/"
      done
    }
    for entry in "$stage/new/"* "$stage/new/".[!.]* "$stage/new/"..?*; do
      [ -e "$entry" ] || [ -L "$entry" ] || continue
      name=${entry##*/}
      if [ -e "$target/$name" ] || [ -L "$target/$name" ]; then
        mv "$target/$name" "$stage/old/" || { rollback; return 1; }
      fi
      touch "$stage/installed/$name" || { rollback; return 1; }
      if ! mv "$entry" "$target/$name"; then
        rm -f "$stage/installed/$name"
        rollback
        return 1
      fi
    done
  elif [ "$kind" = dmg ]; then
    /usr/bin/ditto "$payload" "$stage/new"
    mv "$target" "$stage/old"
    mv "$stage/new" "$target" || { mv "$stage/old" "$target"; return 1; }
  else
    cp "$payload" "$stage/new"
    chmod 755 "$stage/new"
    mv -f "$stage/new" "$target"
  fi
  rm -rf "$stage"
}

if [ "$1" = --apply ]; then
  shift
  kind=$1 payload=$2 target=$3
  apply "$@"
  exit
fi
kind=$1 payload=$2 target=$3 pid=$4
dir=$(dirname "$0")
case "${dir##*/}" in electerm-update-*) ;; *) echo 'Invalid updater directory'; exit 1 ;; esac
case "$payload" in "$dir"/*) ;; *) echo 'Invalid staged payload'; exit 1 ;; esac
failed() {
  title=$(cat "$dir/title.txt")
  msg="$(cat "$dir/failure.txt") — $dir/install.log"
  if [ "$kind" = dmg ]; then
    /usr/bin/osascript -e 'on run argv' -e 'display alert (item 1 of argv)' -e 'end run' "$msg"
  elif command -v notify-send >/dev/null; then
    notify-send "$title" "$msg"
  fi
}
trap 'if [ "$?" != 0 ]; then failed; fi' EXIT
if [ "$pid" -gt 0 ]; then touch "$dir/ready"; fi
i=0
while [ "$pid" -gt 0 ] && kill -0 "$pid" 2>/dev/null; do
  [ "$i" -lt 120 ] || { echo 'Timed out waiting for Electerm to close'; exit 1; }
  sleep 1
  i=$((i+1))
done
parent=$(dirname "$target")
if [ "$kind" = tar.gz ]; then parent=$target; fi
set -- /bin/sh "$0" --apply "$kind" "$payload" "$target"
case "$kind" in
  deb|rpm) privileged=yes ;;
  *) if [ -w "$parent" ]; then privileged=no; else privileged=yes; fi ;;
esac
if [ "$privileged" = no ] || [ "$(id -u)" = 0 ]; then
  "$@"
elif [ "$kind" = dmg ]; then
  /usr/bin/osascript -e 'on run argv' -e 'set cmd to ""' \
    -e 'repeat with a in argv' -e 'set cmd to cmd & " " & quoted form of a' \
    -e 'end repeat' -e 'do shell script cmd with administrator privileges' -e 'end run' "$@"
else
  pkexec "$@"
fi
cd /
case "$kind" in
  dmg) /usr/bin/open "$target" ;;
  tar.gz) "$target/electerm" </dev/null >/dev/null 2>&1 & ;;
  deb|rpm)
    # Launch through the desktop session after pkexec returns to the user.
    if command -v gtk-launch >/dev/null && gtk-launch electerm; then :
    else
      nohup "$target" </dev/null >>"$dir/install.log" 2>&1 &
      app_pid=$!
      sleep 1
      if ! kill -0 "$app_pid" 2>/dev/null; then wait "$app_pid"; fi
    fi ;;
  AppImage) "$target" </dev/null >/dev/null 2>&1 & ;;
esac
rm -rf "$dir"
