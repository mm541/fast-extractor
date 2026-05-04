use std::env;
use std::path::PathBuf;

fn main() {
    let dir = env::var("CARGO_MANIFEST_DIR").unwrap();
    let ffmpeg_include = PathBuf::from(&dir).join("ffmpeg_build").join("ffmpeg-8.1");
    let lib_dir = PathBuf::from(&dir).join("lib");

    // 1. Tell Cargo to link the pre-compiled FFmpeg static libraries
    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    println!("cargo:rustc-link-lib=static=avformat");
    println!("cargo:rustc-link-lib=static=avcodec");
    println!("cargo:rustc-link-lib=static=avutil");

    // 2. Compile our custom C demuxer wrapper using emcc explicitly
    // We bypass the `cc` crate because it tries to pass `--target=wasm32-unknown-unknown`
    // which emcc doesn't accept, and we need emcc's sysroot for <stdio.h>
    let out_dir = env::var("OUT_DIR").unwrap();
    let demuxer_o = PathBuf::from(&out_dir).join("demuxer.o");
    let demuxer_a = PathBuf::from(&out_dir).join("libcustom_demuxer.a");

    let status = std::process::Command::new("emcc")
        .args(&[
            "-O3",
            "-I", ffmpeg_include.to_str().unwrap(),
            "-c", "src/demuxer.c",
            "-o", demuxer_o.to_str().unwrap(),
        ])
        .status()
        .expect("Failed to execute emcc");

    if !status.success() {
        panic!("emcc failed to compile demuxer.c");
    }

    let ar_status = std::process::Command::new("emar")
        .args(&[
            "rcs",
            demuxer_a.to_str().unwrap(),
            demuxer_o.to_str().unwrap(),
        ])
        .status()
        .expect("Failed to execute emar");

    if !ar_status.success() {
        panic!("emar failed to archive libcustom_demuxer.a");
    }

    println!("cargo:rustc-link-search=native={}", out_dir);
    println!("cargo:rustc-link-lib=static=custom_demuxer");

    // 3. Re-run this script if demuxer.c changes
    println!("cargo:rerun-if-changed=src/demuxer.c");
}
