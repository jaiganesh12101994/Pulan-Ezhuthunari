# Build resources

electron-builder looks here for the icons it bakes into the app and the installer:

| File | Used for |
|---|---|
| `icon.ico` | the .exe, the taskbar, the desktop shortcut and the installer |

**It must contain a 256×256 entry.** Windows requires one for an executable, and
electron-builder stops the build with `Icon must be at least 256x256 pixels, provided:
32x32` if the file only holds a small size. The shell picks a different entry per context
— 16 in the taskbar, 32 in lists, 48 on the desktop, 256 in the installer and in
Explorer's large-icon views — so the file needs all of them.

To (re)build it:

```powershell
cd electron\build-resources
python make-icon.py
```

`make-icon.py` prefers `icon-source.png` in this folder if present, otherwise the
original artwork in `icon-original-32.ico`, and writes `icon.ico` with the full size
range. A source smaller than 256 px gets upscaled for the large entries and will look
soft in Explorer's large-icon views, so drop a 256 px (or larger) square PNG in here as
`icon-source.png` when you have one.

`installerIcon.ico` and `uninstallerIcon.ico` are optional and override the installer's
own icon if you add them.

