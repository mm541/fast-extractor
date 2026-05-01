/* tslint:disable */
/* eslint-disable */

export class AudioExtractor {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Build the manifest as a JSON string. Returns empty string if disabled.
     *
     * Uses a pre-allocated String buffer and writes directly into it to avoid
     * intermediate allocations.
     */
    build_manifest(): string;
    /**
     * Write the Ogg End-of-Stream page. Must be called after the last pull_chunk().
     * Returns the final bytes (EOS page) for Opus/Vorbis, or empty for AAC/MP3.
     */
    finalize(): Uint8Array;
    /**
     * File extension for the output audio file ("aac", "mp3", "ogg").
     */
    get_extension(): string;
    /**
     * MIME type for the output audio ("audio/aac", "audio/mpeg", etc).
     */
    get_mime(): string;
    /**
     * Progress as percentage (0.0 - 100.0), based on bytes read from OPFS.
     */
    get_progress(): number;
    /**
     * Create a new AudioExtractor from an OPFS SyncAccessHandle.
     *
     * # Arguments
     * * `handle` — OPFS SyncAccessHandle for zero-copy reads
     * * `build_manifest` — if true, preallocate per-second byte index
     * * `duration_sec` — total video duration in seconds (for index preallocation)
     */
    constructor(handle: any, build_manifest: boolean, duration_sec: number);
    /**
     * Pull up to `max_bytes` of framed audio data.
     *
     * Each codec is framed appropriately:
     *   AAC    → 7-byte ADTS header injected per packet
     *   MP3    → direct passthrough (self-framing)
     *   Opus   → wrapped in Ogg pages with correct granule_pos
     *   Vorbis → wrapped in Ogg pages with correct granule_pos
     *
     * Uses a pre-allocated internal buffer to guarantee zero allocations
     * during the extraction loop.
     */
    pull_chunk(max_bytes: number): Uint8Array;
}

/**
 * Compare Baseline (A) vs Current (B). mask=0 to compare all blocks.
 * Caches B's edge map — subsequent calls with the same B skip recomputation.
 */
export function compare_frames(edge_threshold: number, density_num: number, mask: bigint): number;

/**
 * Consecutive frame drift: edge-density comparison of Prev vs B.
 * Same algorithm as compare_frames but uses raw_prev instead of raw_a.
 * Returns number of grid blocks that changed (0-64).
 * Reuses B's cached edge map from compare_frames if available.
 */
export function compare_prev_current(edge_threshold: number, density_num: number, mask: bigint): number;

/**
 * Compute average color signature from the RGBA buffer.
 * Returns packed u64: [avgR: u16 | avgG: u16 | avgB: u16 | unused: u16]
 * Samples every 64th pixel (~1590 samples from 424×240) — fast and representative.
 * Must be called AFTER pixel ingestion but BEFORE copy_rgba_to_gray().
 */
export function compute_color_signature(): bigint;

export function compute_dhash(is_buffer_b: boolean): bigint;

/**
 * Hardware-accelerated grayscale conversion in Rust.
 * Uses zipped iterators so LLVM can prove slice bounds at compile time,
 * eliminating all per-pixel bounds checks and enabling SIMD auto-vectorization.
 */
export function copy_rgba_to_gray(is_target_b: boolean): void;

/**
 * Average brightness of buffer B (0-255). Detects blank/black frames.
 */
export function get_avg_brightness(): number;

export function get_buffer_a_ptr(): number;

export function get_buffer_b_ptr(): number;

export function get_buffer_prev_ptr(): number;

export function get_rgba_buffer_ptr(): number;

export function init_arena(): void;

/**
 * Efficient rotation: Current becomes Previous
 */
export function shift_current_to_prev(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_audioextractor_free: (a: number, b: number) => void;
    readonly audioextractor_build_manifest: (a: number) => [number, number];
    readonly audioextractor_finalize: (a: number) => any;
    readonly audioextractor_get_extension: (a: number) => [number, number];
    readonly audioextractor_get_mime: (a: number) => [number, number];
    readonly audioextractor_get_progress: (a: number) => number;
    readonly audioextractor_new: (a: any, b: number, c: number) => [number, number, number];
    readonly audioextractor_pull_chunk: (a: number, b: number) => any;
    readonly compare_frames: (a: number, b: number, c: bigint) => number;
    readonly compare_prev_current: (a: number, b: number, c: bigint) => number;
    readonly compute_color_signature: () => bigint;
    readonly compute_dhash: (a: number) => bigint;
    readonly copy_rgba_to_gray: (a: number) => void;
    readonly get_avg_brightness: () => number;
    readonly get_buffer_a_ptr: () => number;
    readonly get_buffer_b_ptr: () => number;
    readonly get_buffer_prev_ptr: () => number;
    readonly get_rgba_buffer_ptr: () => number;
    readonly init_arena: () => void;
    readonly shift_current_to_prev: () => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
