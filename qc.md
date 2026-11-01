# Pulan Ezhuthunari — OCR Diagnostics, Quality Control & Smart Retry Implementation

## Objective

Enhance the existing Pulan Ezhuthunari application with a comprehensive OCR Diagnostics & Quality Control system.

You developed this application and already know its architecture, codebase, UI, OCR integrations, and existing workflows. Build on that knowledge. Do not conduct an unnecessary general architecture audit, redesign the application, or rewrite working modules.

The primary issue to resolve is inconsistent Tamil OCR output: manually selecting a paragraph using a rectangle produces accurate results, but processing the same paragraph through a multipage scanned PDF produces incorrect terms. This occurs with both Tesseract and Surya.

The goal is to fix the underlying cause, make OCR processing traceable, automatically detect suspicious results, retry problematic regions intelligently, and provide an image-assisted text correction workflow.

## 1. Fix the underlying OCR inconsistency

Trace the existing manual-selection and full-document OCR workflows.

Identify and fix actual differences in:

- PDF page rendering, DPI, resolution, and scaling.
- Page rotation and selection-coordinate transformations.
- Crop extraction and boundary handling.
- Image preprocessing and resizing.
- Tesseract and Surya configuration, model versions, and recognition paths.
- Raw OCR output handling.
- Line ordering, paragraph assembly, Unicode normalization, terminology correction, and export.

Use the same canonical rendered page image and shared processing services wherever applicable.

Preserve the original rendered image and ensure that manually selected and automatically detected regions are extracted from the correct source-image coordinates.

Do not blindly increase DPI, change OCR engines, or introduce preprocessing transformations without testing their effect.

Add a regression test that processes the same paragraph through manual selection and full-document OCR and compares the actual crop, effective settings, raw OCR output, and final assembled text.

## 2. Implement a persistent diagnostic system

Capture diagnostic information for every document, page, region, and OCR attempt.

Record:

- Document and page identifiers.
- PDF page number, rendering DPI, pixel dimensions, rotation, and render duration.
- Region identifier, region type, bounding-box coordinates, and crop dimensions.
- Original page image, detected region, exact OCR crop, and preprocessed crop.
- Image hashes and preprocessing profile.
- Applied image transformations and their parameters.
- OCR engine, version, model identifier, and effective settings.
- Raw OCR output and available confidence information.
- Recognition duration, warnings, exceptions, and processing status.
- Quality-check findings and Tesseract–Surya disagreements.
- Retry count, retry reason, changed parameters, and output from each attempt.
- Final assembled text, corrections, verification status, and error details.

Reuse the existing persistence mechanism. Store large image artifacts efficiently using safe file references or caching, avoiding unnecessary duplication.

Diagnostics must remain available when a document is reopened, subject to the application's existing persistence and storage design.

Keep raw engine output immutable. Store normalized text, assembled text, and user corrections as separate, traceable stages.

## 3. Implement the OCR diagnostic workspace

Integrate the workspace into the existing Pulan Ezhuthunari UI and follow its current design system.

Provide the following views:

### A. Original page viewer

- Display the original rendered PDF page.
- Support zoom, pan, and page navigation.
- Overlay detected text regions and crop boundaries.
- Highlight the region currently under investigation.

### B. Image comparison

Allow users to inspect:

- Original rendered page.
- Automatically detected region.
- Exact crop supplied to the OCR engine.
- Preprocessed crop.

Show crop coordinates, image dimensions, preprocessing profile, and relevant processing metadata.

### C. OCR result comparison

Display independent raw results from Tesseract and Surya when available.

Display the final assembled text in an editable panel beside the source image.

Clearly distinguish raw output, automatically processed text, and user-corrected text.

### D. Diagnostic information

Show:

- Page and region identifiers.
- Render DPI and pixel dimensions.
- Crop coordinates and dimensions.
- Engine, model/version, and effective settings.
- Processing time, warnings, and errors.
- Quality-check results.
- Retry history and correction history.

### E. User actions

Provide functional controls to:

- Retry OCR for the selected region.
- Compare alternative preprocessing results.
- Accept a provisional result.
- Edit recognized text.
- Mark text as verified.
- Mark a region as unresolved.
- Navigate to the next or previous region requiring review.

All actions must operate on the selected document and region. Prevent stale results when users switch pages, documents, or OCR jobs.

## 4. Implement automated quality checks

Build modular checks that identify:

- Low resolution or insufficient character size.
- Blur, low contrast, and excessive skew where measurable.
- Clipped characters and incomplete crops.
- Overlapping regions, missing lines, or duplicated text.
- Suspicious Tamil text patterns and unusual Unicode sequences.
- Differences between available OCR engine outputs.
- Recoverable OCR failures, timeouts, and incomplete processing.

Treat these as diagnostic signals, not proof of incorrect text.

Do not flag legitimate historical Tamil spelling, valid Tamil Unicode, or rare Siddha terminology as automatically incorrect merely because they are uncommon.

Use available engine confidence values only when provided. Do not invent confidence scores or present heuristic quality scores as verified OCR accuracy.

Use clear processing states:

- Provisional — OCR completed but not verified.
- Review Required — quality checks indicate possible problems.
- Verified — explicitly verified by the user or an appropriately defined verification process.
- Failed — processing could not complete successfully.

## 5. Implement intelligent, bounded retries

When quality checks identify a problem, retry only the affected region.

Support a configurable retry budget, defaulting to two additional attempts per region.

Choose the retry strategy based on the diagnosed problem:

- Low contrast: alternative conservative contrast enhancement.
- Clipped characters: expand the crop within the page boundaries.
- Skew: apply corrected orientation or conservative deskewing.
- Poor recognition: test a validated alternative preprocessing profile.
- Engine disagreement: compare both raw results and retry the problematic region.
- Missing or duplicated lines: inspect region detection and reading order.
- Recoverable engine error: retry only when appropriate.

Log every attempt, including the reason for retry, preprocessing parameters, engine settings, duration, and resulting output.

Prevent infinite retry loops, duplicate processing, uncontrolled concurrency, and accidental overwriting of previous results.

If retries do not resolve the problem, mark the region Review Required and present it in the correction workspace.

Do not automatically replace an OCR result simply because a later attempt looks more fluent.

## 6. Preserve Siddha terminology and Tamil Unicode

Pulan Ezhuthunari is intended for Tamil documents, including historical Siddha medical books.

- Preserve the original OCR output.
- Preserve valid Tamil characters, combining marks, pulli marks, punctuation, and historical spelling.
- Apply Unicode normalization only through a carefully tested and documented process.
- Keep text assembly, spelling suggestions, terminology verification, and user corrections separate.
- Reuse existing Siddha terminology resources where available.
- Flag suspicious medicinal ingredient names, formulations, and disease names for review.
- Never silently substitute terminology based on a dictionary, language model, or presumed medical context.

Any future terminology-assisted correction must remain transparent, reversible, and traceable to the source image.

## 7. Implement a reliable correction workflow

Users must be able to view the original source image beside editable OCR text.

When a user corrects text:

- Preserve the original raw OCR result.
- Save the corrected text separately.
- Record the correction timestamp and relevant page/region identifiers.
- Retain correction history.
- Allow the user to mark the result verified.
- Ensure corrected text is used in the final assembled document.
- Prevent later automatic retries from silently overwriting verified corrections.

Maintain page boundaries, paragraph order, and existing editing capabilities.

## 8. Testing and regression protection

Add appropriate automated and integration tests for:

- Manual versus full-document crop consistency.
- Correct PDF coordinate mapping.
- Rendering DPI and image dimensions.
- Image hashes and diagnostic artifact integrity.
- Engine settings and model/version recording.
- Raw OCR output versus assembled output.
- Quality-check rules and retry budgets.
- Error handling and cancellation.
- Tamil Unicode preservation.
- Correction history and verified text protection.
- Multipage PDF processing and reading order.
- Existing TXT, DOCX, and PDF export functionality.
- Regression testing for previously misrecognized Siddha terms.

Use deterministic mocked OCR adapters when the real engines are unavailable. Clearly identify tests that use mocks versus real Tesseract or Surya execution.

Do not claim accuracy improvements without measurements against verified reference text. Where possible, measure character error rate and word error rate before and after the changes.

## 9. Performance and reliability

- Process multipage PDFs without unnecessarily loading every full-resolution page into memory simultaneously.
- Reuse the existing job queue and worker architecture.
- Cache rendered pages and image artifacts safely.
- Preserve page and region identity across asynchronous jobs.
- Keep progress, failures, and retries visible.
- Support cancellation without corrupting completed results.
- Ensure that concurrent jobs cannot mix diagnostic records or overwrite one another's data.

Keep the implementation compatible with the existing deployment environment and CPU-only processing requirements.

## 10. Implementation rules

- Use the existing codebase, services, UI components, and coding conventions.
- Do not ask for architecture details that are already available in the repository.
- Do not create a parallel OCR pipeline when existing services can be extended.
- Do not perform unrelated refactoring.
- Do not remove or regress existing features.
- Do not add major dependencies without a clear technical justification.
- Implement functional controls rather than placeholders.
- Make changes incrementally and run relevant tests.
- If a requirement conflicts with the existing architecture, choose the least disruptive solution and document the limitation.
- Do not fabricate test results or claim unverified success.

## 11. Completion requirements

Complete the implementation, not merely a proposal or UI mockup.

At completion, report:

1. Root cause or causes actually identified for inconsistent OCR results.
2. Fixes applied to manual and multipage OCR processing.
3. Files created and modified.
4. Diagnostic data and image artifacts captured.
5. Quality-check rules and retry behavior implemented.
6. Diagnostic workspace and correction workflow completed.
7. Tests executed and their actual results.
8. Whether real Tesseract and Surya integration tests were performed.
9. Remaining limitations and recommended next steps.

Begin by tracing the existing OCR execution paths, fix the demonstrated inconsistency, and then implement the diagnostic system, comparison workspace, quality checks, retries, and verification workflow.