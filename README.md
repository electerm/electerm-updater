# electerm-updater

A Node.js CLI and installer library for Electerm desktop releases. In Electerm’s desktop integration, the app supplies the progress window and the installed release source. The **Upgrade** button opens a progress window. You can cancel while the download is in progress. Once the file is verified and prepared, **Close Electerm and install** ends open sessions and hands installation to a separate process. Archive installations keep adjacent files, including the Windows portable profile.

| Installation source | Installation |
| --- | --- |
| Windows tar.gz, including portable, loose and Windows 7 | Replace application files in the current directory and reopen Electerm. |
| Windows installer.exe | Run the release installer. |
| macOS dmg, including mac10 | Mount the image read-only, stage the app bundle, replace the installed bundle and reopen it. |
| Linux tar.gz or AppImage | Replace files in the extracted directory or replace the original AppImage and reopen Electerm. |
| Linux deb or rpm | Install the release through the system package manager and reopen Electerm. |

APPX and Snap updates belong to their stores. Blockmaps are release metadata. The updater selects the exact GitHub asset for the requested tag and installation source, including architecture and legacy suffixes. Downloads from mirrors must match the size and SHA-256 digest published by GitHub.

## Standalone use

The CLI requires Node.js 18 or later. Close Electerm first, or pass its process ID and close it when ready. The installer waits up to two minutes for that process to exit.

```sh
npx --package=@electerm/updater electerm-updater v5.15.0 linux-x64.tar.gz /opt/electerm/electerm
```

The optional fourth argument is the Electerm PID. For AppImage installations, pass the installed AppImage path. For macOS, pass the executable inside the installed app bundle. The desktop integration supplies these values automatically and uses the existing mirror and proxy preferences.

Linux uses a graphical PolicyKit prompt for protected destinations or package installation. Windows requests elevation through UAC when needed, and macOS uses its administrator prompt. A failed installation retains its temporary directory and installation log for diagnosis.

## Development and release

Run `npm ci` and `npm test` from the repository root. Use `npm run pack:check` to inspect the package contents.

The maintainer publishes version 0.1.0 manually with `npm publish --access public`. Configure the npm trusted publisher for GitHub organization `electerm`, repository `electerm-updater`, and workflow filename `npm-publish.yml`. Subsequent version bumps on `main` run tests and a packed CLI smoke test before publishing with provenance.
