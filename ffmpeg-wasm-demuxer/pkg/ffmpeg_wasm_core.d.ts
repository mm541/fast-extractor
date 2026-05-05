/* tslint:disable */
/* eslint-disable */

export class WasmDemuxer {
    free(): void;
    [Symbol.dispose](): void;
    init(): void;
    constructor(read_callback: Function);
    write_buffer(ptr: number, chunk: Uint8Array): void;
}
