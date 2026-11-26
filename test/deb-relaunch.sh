#!/bin/sh
set -eu
[ "$(id -u)" != 0 ] || { echo 'Run this fixture as an unprivileged user'; exit 1; }
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
dir="$root/electerm-update-test"
mkdir "$dir" "$root/bin"
cp "$(dirname "$0")/../src/install.sh" "$dir/"
touch "$dir/update.deb"
printf '%s\n' 'Update failed' > "$dir/failure.txt"
printf '%s\n' Electerm > "$dir/title.txt"
# Simulate the privilege boundary without installing a system package.
cat > "$root/bin/pkexec" <<'SH'
#!/bin/sh
set -eu
[ "$3" = --apply ] && [ "$4" = deb ] && [ -f "$5" ]
touch "$RESULT/installed"
SH
cat > "$root/bin/gtk-launch" <<'SH'
#!/bin/sh
set -eu
[ "$1" = electerm ] && [ -f "$RESULT/installed" ] && [ "$(id -u)" = "$ORIGINAL_UID" ]
touch "$RESULT/reopened"
SH
chmod +x "$root/bin/"*
RESULT=$root ORIGINAL_UID=$(id -u) PATH="$root/bin:$PATH" /bin/sh "$dir/install.sh" deb "$dir/update.deb" "$root/electerm" 0
test -f "$root/reopened"
