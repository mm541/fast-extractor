/* @ts-self-types="./wasm_extractor.d.ts" */

export class AudioExtractor {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        AudioExtractorFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_audioextractor_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get_progress() {
        const ret = wasm.audioextractor_get_progress(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {any} handle
     */
    constructor(handle) {
        const ret = wasm.audioextractor_new(handle);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0] >>> 0;
        AudioExtractorFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {number} max_bytes
     * @returns {Uint8Array}
     */
    pull_chunk(max_bytes) {
        const ret = wasm.audioextractor_pull_chunk(this.__wbg_ptr, max_bytes);
        return ret;
    }
}
if (Symbol.dispose) AudioExtractor.prototype[Symbol.dispose] = AudioExtractor.prototype.free;

/**
 * ACCURATE STABILITY: Compares Current (B) vs Previous (Prev)
 * @param {bigint} stability_threshold
 * @returns {boolean}
 */
export function check_stability(stability_threshold) {
    const ret = wasm.check_stability(stability_threshold);
    return ret !== 0;
}

/**
 * Compare Baseline (A) vs Current (B). mask=0 to compare all blocks.
 * @param {number} edge_threshold
 * @param {number} density_num
 * @param {bigint} mask
 * @returns {number}
 */
export function compare_frames(edge_threshold, density_num, mask) {
    const ret = wasm.compare_frames(edge_threshold, density_num, mask);
    return ret >>> 0;
}

/**
 * Consecutive frame drift: edge-density comparison of Prev vs B.
 * Same algorithm as compare_frames but uses raw_prev instead of raw_a.
 * Returns number of grid blocks that changed (0-64).
 * Compare Previous (Prev) vs Current (B). mask=0 to compare all blocks.
 * @param {number} edge_threshold
 * @param {number} density_num
 * @param {bigint} mask
 * @returns {number}
 */
export function compare_prev_current(edge_threshold, density_num, mask) {
    const ret = wasm.compare_prev_current(edge_threshold, density_num, mask);
    return ret >>> 0;
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
        __wbg___wbindgen_throw_81fc77679af83bc6: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_error_a6fa202b58aa1cd3: function(arg0, arg1) {
            let deferred0_0;
            let deferred0_1;
            try {
                deferred0_0 = arg0;
                deferred0_1 = arg1;
                console.error(getStringFromWasm0(arg0, arg1));
            } finally {
                wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
            }
        },
        __wbg_getSize_0c6244c75acdd5ae: function(arg0) {
            const ret = arg0.getSize();
            return ret;
        },
        __wbg_length_0c32cb8543c8e4c8: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_new_227d7c05414eb861: function() {
            const ret = new Error();
            return ret;
        },
        __wbg_new_4f9fafbb3909af72: function() {
            const ret = new Object();
            return ret;
        },
        __wbg_new_from_slice_2580ff33d0d10520: function(arg0, arg1) {
            const ret = new Uint8Array(getArrayU8FromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_with_length_9cedd08484b73942: function(arg0) {
            const ret = new Uint8Array(arg0 >>> 0);
            return ret;
        },
        __wbg_prototypesetcall_3e05eb9545565046: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbg_read_f3755ebe795ba2b5: function(arg0, arg1, arg2) {
            const ret = arg0.read(arg1, arg2);
            return ret;
        },
        __wbg_set_8ee2d34facb8466e: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Reflect.set(arg0, arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_stack_3b0d974bbf31e44f: function(arg0, arg1) {
            const ret = arg1.stack;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_subarray_0f98d3fb634508ad: function(arg0, arg1, arg2) {
            const ret = arg0.subarray(arg1 >>> 0, arg2 >>> 0);
            return ret;
        },
        __wbindgen_cast_0000000000000001: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_cast_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
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

const AudioExtractorFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_audioextractor_free(ptr >>> 0, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasm;
function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedUint8ArrayMemory0 = null;
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
