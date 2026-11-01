"""Generates a long PDF to test that the app opens a many-page document.

Page count is what this exercises: rasterizing every page, streaming progress for every
page, and then holding them all in the UI. Content is deliberately plain so the file
itself stays small and the test is about the page count, not the byte count.

    python scripts\\make-test-pdf.py 800 E:\\tmp\\pulan_800page_test.pdf

Then load it through the real UI:

    npx electron . --remote-debugging-port=9222
    node scripts\\test-large-file.cjs E:\\tmp\\pulan_800page_test.pdf
"""
import os
import sys
import tempfile

from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.pdfgen import canvas

PAGES = int(sys.argv[1]) if len(sys.argv) > 1 else 800
# Defaults to the system temp folder rather than a fixed drive, so the script works
# unchanged on any machine.
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(
    tempfile.gettempdir(), f"pulan_{PAGES}page_test.pdf"
)

doc = canvas.Canvas(OUT, pagesize=letter)
width, height = letter
body = "The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. "

for page in range(1, PAGES + 1):
    doc.setFont("Helvetica-Bold", 26)
    doc.drawString(inch, height - 1.4 * inch, f"Pulan Tamil OCR test document - page {page} of {PAGES}")
    doc.setFont("Helvetica", 11)
    for line in range(34):
        doc.drawString(inch, height - 2.1 * inch - line * 0.22 * inch, body)
    doc.setFont("Helvetica-Oblique", 9)
    doc.drawString(inch, 0.8 * inch, f"page {page}")
    doc.showPage()

doc.save()
print(f"wrote {OUT} with {PAGES} pages")
