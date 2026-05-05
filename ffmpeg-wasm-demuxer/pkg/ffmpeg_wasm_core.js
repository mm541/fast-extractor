/* @ts-self-types="./ffmpeg_wasm_core.d.ts" */

class WasmDemuxer {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmDemuxerFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmdemuxer_free(ptr, 0);
    }
    init() {
        const ret = wasm.wasmdemuxer_init(this.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {Function} read_callback
     */
    constructor(read_callback) {
        const ret = wasm.wasmdemuxer_new(read_callback);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        WasmDemuxerFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {number} ptr
     * @param {Uint8Array} chunk
     */
    write_buffer(ptr, chunk) {
        const ptr0 = passArray8ToWasm0(chunk, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.wasmdemuxer_write_buffer(this.__wbg_ptr, ptr, ptr0, len0);
    }
}
if (Symbol.dispose) WasmDemuxer.prototype[Symbol.dispose] = WasmDemuxer.prototype.free;
exports.WasmDemuxer = WasmDemuxer;
const import1 = require("env");
const import2 = require("env");
const import3 = require("env");
const import4 = require("env");
const import5 = require("env");
const import6 = require("env");
const import7 = require("env");
const import8 = require("env");
const import9 = require("env");
const import10 = require("env");
const import11 = require("env");
const import12 = require("env");
const import13 = require("env");
const import14 = require("env");
const import15 = require("env");
const import16 = require("env");
const import17 = require("env");
const import18 = require("env");
const import19 = require("env");
const import20 = require("env");
const import21 = require("env");
const import22 = require("env");
const import23 = require("env");
const import24 = require("env");
const import25 = require("env");
const import26 = require("env");
const import27 = require("env");
const import28 = require("env");
const import29 = require("env");
const import30 = require("env");
const import31 = require("env");
const import32 = require("env");
const import33 = require("env");
const import34 = require("env");
const import35 = require("env");
const import36 = require("env");
const import37 = require("env");
const import38 = require("env");
const import39 = require("env");
const import40 = require("env");
const import41 = require("env");
const import42 = require("env");
const import43 = require("env");
const import44 = require("env");
const import45 = require("env");
const import46 = require("env");
const import47 = require("env");
const import48 = require("env");
const import49 = require("env");
const import50 = require("env");
const import51 = require("env");

function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_number_get_dd6d69a6079f26f1: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'number' ? obj : undefined;
            getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_throw_9c75d47bf9e7731e: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_call_a6d9545202d34317: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = arg0.call(arg1, arg2, arg3);
            return ret;
        }, arguments); },
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
        "./ffmpeg_wasm_core_bg.js": import0,
        "env": import1,
        "env": import2,
        "env": import3,
        "env": import4,
        "env": import5,
        "env": import6,
        "env": import7,
        "env": import8,
        "env": import9,
        "env": import10,
        "env": import11,
        "env": import12,
        "env": import13,
        "env": import14,
        "env": import15,
        "env": import16,
        "env": import17,
        "env": import18,
        "env": import19,
        "env": import20,
        "env": import21,
        "env": import22,
        "env": import23,
        "env": import24,
        "env": import25,
        "env": import26,
        "env": import27,
        "env": import28,
        "env": import29,
        "env": import30,
        "env": import31,
        "env": import32,
        "env": import33,
        "env": import34,
        "env": import35,
        "env": import36,
        "env": import37,
        "env": import38,
        "env": import39,
        "env": import40,
        "env": import41,
        "env": import42,
        "env": import43,
        "env": import44,
        "env": import45,
        "env": import46,
        "env": import47,
        "env": import48,
        "env": import49,
        "env": import50,
        "env": import51,
    };
}

const WasmDemuxerFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmdemuxer_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
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

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
function decodeText(ptr, len) {
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let WASM_VECTOR_LEN = 0;

const wasmPath = `${__dirname}/ffmpeg_wasm_core_bg.wasm`;
const wasmBytes = require('fs').readFileSync(wasmPath);
const wasmModule = new WebAssembly.Module(wasmBytes);
let wasmInstance = new WebAssembly.Instance(wasmModule, __wbg_get_imports());
let wasm = wasmInstance.exports;
wasm.__wbindgen_start();
