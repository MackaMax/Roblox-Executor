# Download

## Windows (x64)

**`RobloxExecutorLab-win-x64.zip`** — 31.5 MB, contains a single 83.6 MB `.exe`.

1. Click the file above, then **Download** (the ⤓ button).
2. Unzip it anywhere.
3. Double-click **`RobloxExecutorLab-win-x64.exe`**.

Your browser opens at <http://localhost:5173>. Close the console window to stop it.

Nothing else is needed — no Node.js, no `npm install`, no folder to keep next to
it. The Lua engine and the whole UI are inside that one file.

### Windows will warn you

SmartScreen shows *"Windows protected your PC"* because the exe is **not
code-signed**. Choose **More info → Run anyway**. A signing certificate costs
money and this is a free educational project.

### If a port is busy

The app starts on port 5173 and automatically moves up to the next free port if
that one is taken. It prints the URL it chose in the console window.

---

**Educational purposes only.** This sandbox never attaches to Roblox, never
injects into another process, and never contacts Roblox's servers. It is a
simulation built to teach how script executors and the client/server boundary
work.

Build it yourself with `npm run exe:win` — see the [main README](../README.md).
