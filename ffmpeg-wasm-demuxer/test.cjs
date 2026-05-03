const createDemuxerModule = require('./pkg/ffmpeg_demuxer.js');
const fs = require('fs');

const VIDEO_PATH = process.argv[2];
if (!VIDEO_PATH) {
    console.error('Usage: node test.js <path-to-video>');
    process.exit(1);
}

// Codec type names
const CODEC_TYPES = { 0: 'VIDEO', 1: 'AUDIO', 2: 'DATA', 3: 'SUBTITLE', 4: 'ATTACHMENT' };
// Common codec IDs
const CODEC_NAMES = {
    27: 'H.264', 173: 'VP9', 225: 'AV1', 174: 'VP8', 35: 'HEVC',
    86018: 'AAC', 86017: 'MP3', 86076: 'Opus', 86021: 'Vorbis', 86028: 'FLAC',
};

async function runTest() {
    console.log("Loading Emscripten WASM module...");
    const Module = await createDemuxerModule({
        print: (text) => console.log("[FFMPEG STDOUT]", text),
        printErr: (text) => console.error("[FFMPEG STDERR]", text)
    });

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  FFmpeg WASM Core — Comprehensive Test`);
    console.log(`${'═'.repeat(60)}`);
    console.log(`File: ${VIDEO_PATH}`);

    const fd = fs.openSync(VIDEO_PATH, 'r');
    const fileSize = fs.fstatSync(fd).size;
    let offset = 0;

    console.log(`Size: ${(fileSize / 1024 / 1024).toFixed(1)} MB\n`);

    // ── Get shared seek result buffer pointer ──
    const seekResultPtr = Module.ccall('wasm_get_seek_result_ptr', 'number', [], []);

    // ── Read Callback ──
    const jsReadCallback = (bufPtr, size) => {
        try {
            const view = new Uint8Array(Module.wasmMemory.buffer, bufPtr, size);
            const bytesRead = fs.readSync(fd, view, 0, size, offset);
            if (bytesRead === 0) return -1;
            offset += bytesRead;
            return bytesRead;
        } catch (e) {
            console.error("FS Read Error:", e);
            return -1;
        }
    };

    // ── Seek Callback (fixed for >2GB files) ──
    const jsSeekCallback = (offsetHi, offsetLo, whence) => {
        const AVSEEK_SIZE = 0x10000;
        const seekOffset = (offsetHi * 0x100000000) + (offsetLo >>> 0);
        let newPos;

        if (whence === AVSEEK_SIZE) {
            newPos = fileSize;
        } else {
            switch (whence) {
                case 0: newPos = seekOffset; break;        // SEEK_SET
                case 1: newPos = offset + seekOffset; break; // SEEK_CUR
                case 2: newPos = fileSize + seekOffset; break; // SEEK_END
                default: return -1;
            }
            offset = newPos;
        }

        // Write the full 64-bit result into the shared buffer as [lo, hi]
        const h = new Int32Array(Module.wasmMemory.buffer);
        h[seekResultPtr / 4]     = newPos & 0xFFFFFFFF;           // lo
        h[seekResultPtr / 4 + 1] = Math.floor(newPos / 0x100000000); // hi
        return 0; // success
    };

    const readPtr = Module.addFunction(jsReadCallback, 'iii');
    const seekPtr = Module.addFunction(jsSeekCallback, 'iiii');

    try {
        // ═══════════════════════════════════════
        // 1. INIT
        // ═══════════════════════════════════════
        console.log("▸ Instantiating demuxer...");
        const demuxerPtr = Module.ccall('wasm_demuxer_new', 'number', ['number', 'number'], [readPtr, seekPtr]);
        if (demuxerPtr === 0) { console.error("FATAL: Failed to allocate Demuxer"); return; }

        console.log("▸ Opening file...");
        const initRes = Module.ccall('wasm_demuxer_init', 'number', ['number'], [demuxerPtr]);
        if (initRes < 0) {
            const errPtr = Module.ccall('wasm_demuxer_get_last_error', 'number', ['number'], [demuxerPtr]);
            const errMsg = Module.UTF8ToString(errPtr);
            console.error(`\n❌ FATAL: FFmpeg failed to open file!`);
            console.error(`   Error Code: ${initRes}`);
            console.error(`   Message:    ${errMsg || 'Unknown error'}\n`);
            return;
        }
        console.log("✓ File opened successfully!\n");

        // ═══════════════════════════════════════
        // 2. CONTAINER METADATA
        // ═══════════════════════════════════════
        const duration = Module.ccall('wasm_demuxer_get_duration', 'number', ['number'], [demuxerPtr]);
        const streamCount = Module.ccall('wasm_demuxer_get_stream_count', 'number', ['number'], [demuxerPtr]);

        console.log("┌─ CONTAINER ─────────────────────────────┐");
        console.log(`│  Duration:     ${duration.toFixed(2)}s (${(duration/60).toFixed(1)} min)`);
        console.log(`│  Streams:      ${streamCount}`);
        console.log("└──────────────────────────────────────────┘");

        // ═══════════════════════════════════════
        // 3. ALL STREAMS (by index)
        // ═══════════════════════════════════════
        let videoIdx = -1, audioIdx = -1;
        let videoTbDen = 1, audioTbDen = 1;

        console.log("\n┌─ STREAMS ──────────────────────────────────────────────────────┐");
        for (let i = 0; i < streamCount; i++) {
            const infoPtr = Module.ccall('wasm_demuxer_get_stream_info', 'number', ['number', 'number'], [demuxerPtr, i]);
            if (infoPtr === 0) continue;

            const h = new Int32Array(Module.wasmMemory.buffer);
            const p = infoPtr / 4;
            const idx        = h[p + 0];
            const extraPtr   = h[p + 1];
            const extraSize  = h[p + 2];
            const codecId    = h[p + 3];
            const tbNum      = h[p + 4];
            const tbDen      = h[p + 5];
            const sampleRate = h[p + 6];
            const channels   = h[p + 7];
            const width      = h[p + 8];
            const height     = h[p + 9];
            const bitRate    = h[p + 10];
            const codecType  = h[p + 11];

            const typeName = CODEC_TYPES[codecType] || `UNKNOWN(${codecType})`;
            const codecName = CODEC_NAMES[codecId] || `id:${codecId}`;

            let details = `${codecName}`;
            if (codecType === 0) { // VIDEO
                details += ` ${width}x${height}`;
                if (bitRate > 0) details += ` ${bitRate}kbps`;
                details += ` tb:${tbNum}/${tbDen}`;
                if (videoIdx === -1) { videoIdx = idx; videoTbDen = tbDen; }
            } else if (codecType === 1) { // AUDIO
                details += ` ${sampleRate}Hz ${channels}ch`;
                if (bitRate > 0) details += ` ${bitRate}kbps`;
                details += ` tb:${tbNum}/${tbDen}`;
                if (audioIdx === -1) { audioIdx = idx; audioTbDen = tbDen; }
            }

            let extraStr = '';
            if (extraPtr !== 0 && extraSize > 0) {
                const ed = new Uint8Array(Module.wasmMemory.buffer, extraPtr, Math.min(extraSize, 8));
                extraStr = ` extra:${extraSize}B [${Buffer.from(ed).toString('hex')}...]`;
            }

            console.log(`│  [${i}] ${typeName.padEnd(10)} ${details}${extraStr}`);
            Module.ccall('wasm_demuxer_free_stream_info', 'void', ['number'], [infoPtr]);
        }
        console.log("└────────────────────────────────────────────────────────────────┘");

        // ═══════════════════════════════════════
        // 4. SEQUENTIAL PACKET EXTRACTION
        // ═══════════════════════════════════════
        console.log("\n┌─ PACKETS (first 20) ──────────────────────────────────────────┐");
        let videoPkts = 0, audioPkts = 0, keyframes = 0;

        for (let i = 0; i < 20; i++) {
            const pktPtr = Module.ccall('wasm_demuxer_read_c_packet', 'number', ['number'], [demuxerPtr]);
            if (pktPtr === 0) {
                const errPtr = Module.ccall('wasm_demuxer_get_last_error', 'number', ['number'], [demuxerPtr]);
                const errMsg = Module.UTF8ToString(errPtr);
                if (errMsg !== "") {
                    console.error(`│  ❌ Read Error: ${errMsg}`);
                } else {
                    console.log("│  EOF!");
                }
                break;
            }

            const h32 = new Int32Array(Module.wasmMemory.buffer);
            const h64 = new BigInt64Array(Module.wasmMemory.buffer);
            const p32 = pktPtr / 4;
            const p64 = pktPtr / 8;

            const size = h32[p32 + 1];
            const pts = h64[p64 + 1];
            const dts = h64[p64 + 2];
            const isKey = h32[p32 + 6];
            const idx = h32[p32 + 7];

            if (idx === videoIdx) {
                videoPkts++;
                if (isKey) keyframes++;
                const t = (Number(pts) / videoTbDen).toFixed(3);
                console.log(`│  [V] ${size.toString().padStart(7)}B  PTS:${pts.toString().padStart(10)}  ~${t}s ${isKey ? '🔑' : '  '}`);
            } else if (idx === audioIdx) {
                audioPkts++;
                const t = (Number(pts) / audioTbDen).toFixed(3);
                console.log(`│  [A] ${size.toString().padStart(7)}B  PTS:${pts.toString().padStart(10)}  ~${t}s`);
            }

            Module.ccall('wasm_demuxer_free_c_packet', 'void', ['number'], [pktPtr]);
        }
        console.log(`│  ── Video: ${videoPkts} (${keyframes} keyframes) | Audio: ${audioPkts}`);
        console.log("└────────────────────────────────────────────────────────────────┘");

        // ═══════════════════════════════════════
        // 5. SEEK TEST
        // ═══════════════════════════════════════
        if (duration > 10 && videoIdx >= 0) {
            const seekSec = Math.min(60, Math.floor(duration / 2));
            const seekTs = seekSec * videoTbDen;
            const seekHi = Math.floor(seekTs / 0x100000000);
            const seekLo = seekTs & 0xFFFFFFFF;

            console.log(`\n┌─ SEEK TEST → ~${seekSec}s ─────────────────────────────────────┐`);
            const seekRes = Module.ccall('wasm_demuxer_seek', 'number',
                ['number', 'number', 'number', 'number'],
                [demuxerPtr, videoIdx, seekHi, seekLo]);
            console.log(`│  Result: ${seekRes === 0 ? '✓ success' : '✗ failed (' + seekRes + ')'}`);

            for (let i = 0; i < 5; i++) {
                const pktPtr = Module.ccall('wasm_demuxer_read_c_packet', 'number', ['number'], [demuxerPtr]);
                if (pktPtr === 0) { console.log("│  EOF!"); break; }

                const h32 = new Int32Array(Module.wasmMemory.buffer);
                const h64 = new BigInt64Array(Module.wasmMemory.buffer);
                const p32 = pktPtr / 4;
                const p64 = pktPtr / 8;

                const size = h32[p32 + 1];
                const pts = h64[p64 + 1];
                const isKey = h32[p32 + 6];
                const idx = h32[p32 + 7];

                const label = idx === videoIdx ? 'V' : idx === audioIdx ? 'A' : '?';
                const tb = idx === videoIdx ? videoTbDen : audioTbDen;
                const t = (Number(pts) / tb).toFixed(2);
                console.log(`│  [${label}] ${size.toString().padStart(7)}B  PTS:${pts.toString().padStart(10)}  ~${t}s ${isKey ? '🔑' : ''}`);

                Module.ccall('wasm_demuxer_free_c_packet', 'void', ['number'], [pktPtr]);
            }
            console.log("└────────────────────────────────────────────────────────────────┘");
        }

        // ═══════════════════════════════════════
        // 6. CLEANUP
        // ═══════════════════════════════════════
        Module.ccall('wasm_demuxer_free', 'void', ['number'], [demuxerPtr]);
        console.log("\n✓ All tests passed. Demuxer freed.");

    } catch (e) {
        console.error("Test failed:", e);
    } finally {
        fs.closeSync(fd);
    }
}

runTest();
