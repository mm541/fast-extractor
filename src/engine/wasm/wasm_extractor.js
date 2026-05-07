/* @ts-self-types="./wasm_extractor.d.ts" */

/**
 * Compare Baseline (A) vs Current (B). mask=0 to compare all blocks.
 * Caches B's edge map — subsequent calls with the same B skip recomputation.
 * @param {number} edge_threshold
 * @param {number} density_num
 * @param {bigint} mask
 * @returns {number}
 */
export function compare_frames(edge_threshold, density_num, mask) {
    const ret = wasm.compare_frames(edge_threshold, density_num, mask);
    return ret;
}

/**
 * Consecutive frame drift: edge-density comparison of Prev vs B.
 * Same algorithm as compare_frames but uses raw_prev instead of raw_a.
 * Returns a weighted float score of changed blocks (0.0 - 64.0).
 * Reuses B's cached edge map from compare_frames if available.
 * @param {number} edge_threshold
 * @param {number} density_num
 * @param {bigint} mask
 * @returns {number}
 */
export function compare_prev_current(edge_threshold, density_num, mask) {
    const ret = wasm.compare_prev_current(edge_threshold, density_num, mask);
    return ret;
}

/**
 * Compute average color signature from the RGBA buffer.
 * Returns packed u64: [avgR: u16 | avgG: u16 | avgB: u16 | unused: u16]
 * Samples every 64th pixel (~1590 samples from 424×240) — fast and representative.
 * Must be called AFTER pixel ingestion but BEFORE copy_rgba_to_gray().
 * @returns {bigint}
 */
export function compute_color_signature() {
    const ret = wasm.compute_color_signature();
    return BigInt.asUintN(64, ret);
}

/**
 * @param {boolean} is_buffer_b
 * @returns {bigint}
 */
export function compute_dhash(is_buffer_b) {
    const ret = wasm.compute_dhash(is_buffer_b);
    return BigInt.asUintN(64, ret);
}

/**
 * Hardware-accelerated grayscale conversion in Rust.
 * Uses zipped iterators so LLVM can prove slice bounds at compile time,
 * eliminating all per-pixel bounds checks and enabling SIMD auto-vectorization.
 * @param {boolean} is_target_b
 */
export function copy_rgba_to_gray(is_target_b) {
    wasm.copy_rgba_to_gray(is_target_b);
}

/**
 * Average brightness of buffer B (0-255). Detects blank/black frames.
 * @returns {number}
 */
export function get_avg_brightness() {
    const ret = wasm.get_avg_brightness();
    return ret >>> 0;
}

/**
 * @returns {number}
 */
export function get_buffer_a_ptr() {
    const ret = wasm.get_buffer_a_ptr();
    return ret >>> 0;
}

/**
 * @returns {number}
 */
export function get_buffer_b_ptr() {
    const ret = wasm.get_buffer_b_ptr();
    return ret >>> 0;
}

/**
 * @returns {number}
 */
export function get_buffer_prev_ptr() {
    const ret = wasm.get_buffer_prev_ptr();
    return ret >>> 0;
}

/**
 * @returns {number}
 */
export function get_rgba_buffer_ptr() {
    const ret = wasm.get_rgba_buffer_ptr();
    return ret >>> 0;
}

export function init_arena() {
    wasm.init_arena();
}

/**
 * Efficient rotation: Current becomes Previous
 */
export function shift_current_to_prev() {
    wasm.shift_current_to_prev();
}

function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./wasm_extractor_bg.js": import0,
    };
}

let wasmModule, wasm;
function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    wasmModule = module;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('wasm_extractor_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
