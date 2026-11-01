"""Builds the multi-size icon.ico that electron-builder requires.

Windows wants at least 256x256 for the executable and the installer, and the shell picks
a different size for each context (16 in the taskbar, 32 in lists, 48 on the desktop,
256 in the installer and in Explorer's large-icon views). A single 32x32 file is rejected
outright with "Icon must be at least 256x256 pixels, provided: 32x32".

Source of truth is icon-source.png if it exists (any size, square), otherwise the 32x32
original kept in this folder.
"""
import os
import sys

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.join(HERE, "icon.ico")
SOURCE_PNG = os.path.join(HERE, "icon-source.png")
ORIGINAL = os.path.join(HERE, "icon-original-32.ico")
SIZES = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)]

if os.path.isfile(SOURCE_PNG):
    source = SOURCE_PNG
elif os.path.isfile(ORIGINAL):
    source = ORIGINAL
elif os.path.isfile(TARGET):
    source = TARGET
else:
    sys.exit("no icon source found in " + HERE)

image = Image.open(source).convert("RGBA")
print("source :", os.path.basename(source), image.size)

# Work at the largest size we ship, then let Pillow emit each entry from it.
largest = max(w for w, _ in SIZES)
canvas = image.resize((largest, largest), Image.LANCZOS)
canvas.save(TARGET, format="ICO", sizes=SIZES)

written = Image.open(TARGET)
print("written:", os.path.basename(TARGET), "with sizes", sorted(written.ico.sizes()))
if image.size[0] < 256:
    print(
        f"note   : the source is {image.size[0]}px, so the larger entries are upscaled and\n"
        "         will look soft in Explorer's large-icon views. Drop a 256px (or bigger)\n"
        "         square PNG in here as icon-source.png for a crisp result."
    )
