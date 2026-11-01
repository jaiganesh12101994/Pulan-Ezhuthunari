# Verified reference text for accuracy measurement

Accuracy is never claimed without a verified reference. This directory is where
those references live.

## How to add one

1. Pick a sample scan from `public/samples/` (for example `11.jpg`).
2. Transcribe its text **by hand** into `backend/tests/reference/11.txt`
   (same base name as the image, `.txt` extension).
   * Keep the original spelling, including historical forms and Siddha terms.
   * One line per text line, blank line between paragraphs.
   * Save as UTF-8.
3. Run the measurement:

   ```
   python -m pytest backend/tests/test_ocr_diagnostics.py::test_reference_based_accuracy_when_available -v -s
   ```

The test prints the measured character error rate (CER), word error rate (WER)
and the engine's mean word confidence for every reference that matches a sample
image, and fails when the CER exceeds the documented acceptance threshold of
0.60 for a scanned journal page.

`measure_cer_wer()` in `test_ocr_diagnostics.py` computes both rates with the
Levenshtein distance over characters and over words, so any change to the OCR
pipeline can be compared against the same baseline.

Without any `.txt` file here the test skips with this message instead of
reporting an invented number.
