declare module 'mp4box' {
    export interface MP4FileInfo {
        duration: number;
        timescale: number;
        isFragmented: boolean;
        isProgressive: boolean;
        hasIOD: boolean;
        brands: string[];
        created: Date;
        modified: Date;
        tracks: MP4Track[];
        videoTracks: MP4VideoTrack[];
        audioTracks: MP4AudioTrack[];
    }

    export interface MP4Track {
        id: number;
        created: Date;
        modified: Date;
        movie_duration: number;
        layer: number;
        alternate_group: number;
        volume: number;
        track_width: number;
        track_height: number;
        timescale: number;
        duration: number;
        codec: string;
        language: string;
        nb_samples: number;
    }

    export interface MP4VideoTrack extends MP4Track {
        video: {
            width: number;
            height: number;
        };
    }

    export interface MP4AudioTrack extends MP4Track {
        audio: {
            sample_rate: number;
            channel_count: number;
            sample_size: number;
        };
    }

    export interface MP4Sample {
        track_id: number;
        description: unknown;
        units: unknown[];
        number: number;
        cts: number;
        dts: number;
        duration: number;
        is_sync: boolean;
        is_leading: number;
        depends_on: number;
        is_depended_on: number;
        has_redundancy: number;
        degradation_priority: number;
        offset: number;
        size: number;
        data: ArrayBuffer;
        timescale: number;
    }

    export interface MP4BoxFile {
        onReady?: (info: MP4FileInfo) => void;
        onSamples?: (id: number, user: unknown, samples: MP4Sample[]) => void;
        onFlush?: () => void;
        onError?: (e: string) => void;
        appendBuffer(buffer: ArrayBuffer, file_offset?: number): number;
        flush(): void;
        setExtractionConfig(id: number, user: unknown, config: { nb_samples: number }): void;
        releaseUsedSamples(id: number, sampleNumber: number): void;
        start(): void;
        stop(): void;
    }

    export function createFile(): MP4BoxFile;

    const MP4Box: {
        createFile: typeof createFile;
    };

    export default MP4Box;
}
