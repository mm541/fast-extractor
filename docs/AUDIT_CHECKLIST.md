# Extractor.ts Audit Checklist

Apply these 7 checks to **every section** during the line-by-line audit.

## Checks

| # | Goal | What to look for |
|---|------|-----------------|
| 1 | **Correctness** | Is the logic actually right? Any edge cases missed? |
| 2 | **Performance** | Any redundant work, unnecessary allocations, blocking calls? |
| 3 | **Debug Mode** | Does `debug: true` give the library user enough info to diagnose issues? Should we log more — frame timestamps, block counts, emit reasons? |
| 4 | **Error Quality** | Are `console.warn` messages actionable? Can a user actually fix the problem from the error message alone? Should we include error codes? |
| 5 | **Decoupling** | Can this piece be tested independently? Can it be swapped? |
| 6 | **Extensibility** | If someone wants to add a 5th emit condition, or a different hash algorithm, how hard is it? |
| 7 | **API Surface** | Are the `ExtractionOptions` well-named? Are defaults sensible? Is anything confusingly exposed or missing? |

## Audit Progress

| Lines | Section | Status |
|-------|---------|--------|
| 1-100 | Header comments | `[ ]` |
| 100-230 | ExtractionOptions + defaults | `[ ]` |
| 230-350 | Class properties + constructor | `[ ]` |
| 350-600 | extractSlides() — turbo + accurate | `[ ]` |
| 600-830 | processFrameSync() — 4 emit conditions | `[ ]` |
| 830-976 | Helpers — capture, calibration, emit | `[ ]` |

## Findings Log

Track every issue found during audit here.

| Line | Check # | Finding | Action |
|------|---------|---------|--------|
| | | | |
