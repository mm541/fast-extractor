/* tslint:disable */
/* eslint-disable */
export const memory: WebAssembly.Memory;
export const compare_frames: (a: number, b: number, c: bigint) => number;
export const compare_prev_current: (a: number, b: number, c: bigint) => number;
export const compute_dhash: (a: number) => bigint;
export const copy_rgba_to_gray: (a: number) => void;
export const get_buffer_a_ptr: () => number;
export const get_buffer_b_ptr: () => number;
export const get_buffer_prev_ptr: () => number;
export const get_rgba_buffer_ptr: () => number;
export const init_arena: () => void;
export const shift_current_to_prev: () => void;
export const __wbindgen_externrefs: WebAssembly.Table;
export const __wbindgen_start: () => void;
