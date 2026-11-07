import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

type Rgba = [number, number, number, number];

export interface PxoFixtureLayer {
    name: string;
    /** 0 = pixel, 1 = group, 2 = 3D, 3 = tilemap, 4 = audio. */
    type?: number;
    visible?: boolean;
    opacity?: number;
    /** -2 = pass through (groups only), 0 = normal. */
    blendMode?: number;
    clippingMask?: boolean;
    parent?: number;
    effects?: { enabled?: boolean }[];
    animatedParams?: string;
}

export interface PxoFixtureCel {
    /** Cel pixels in row order, `width * height` entries. Omit for an empty 1x1 cel. */
    pixels?: Rgba[];
    width?: number;
    height?: number;
    x?: number;
    y?: number;
    opacity?: number;
    zIndex?: number;
}

export interface PxoFixtureOptions {
    width: number;
    height: number;
    fps?: number;
    colorMode?: number;
    layers: PxoFixtureLayer[];
    /** One entry per frame; `cels` has one entry per layer. */
    frames: { duration?: number; cels: PxoFixtureCel[] }[];
    /** Tags use Pixelorama's 1-based frame numbers. */
    tags?: { name: string; from: number; to: number }[];
    /** Full-canvas pre-blended frames, as saved with "Include blended images". */
    blendedImages?: Rgba[][];
}

/** Builds a minimal Pixelorama 1.0+ project (`.pxo`) in memory. */
export function buildPixelorama(options: PxoFixtureOptions): Buffer {
    const files: Record<string, Uint8Array> = {};
    const frames = options.frames.map((frame, frameIndex) => ({
        duration: frame.duration ?? 1,
        metadata: {},
        cels: frame.cels.map((cel, layerIndex) => {
            const width = cel.width ?? 1;
            const height = cel.height ?? 1;
            const pixels = cel.pixels ?? Array.from({ length: width * height }, () => [0, 0, 0, 0]);
            if (pixels.length !== width * height) throw new Error("Fixture cel size mismatch.");
            files[`image_data/frames/${frameIndex + 1}/layer_${layerIndex + 1}`] = new Uint8Array(
                pixels.flat(),
            );
            return {
                image_size: `Vector2i(${width}, ${height})`,
                offset: `(${cel.x ?? 0}, ${cel.y ?? 0})`,
                opacity: cel.opacity ?? 1,
                z_index: cel.zIndex ?? 0,
                metadata: {},
            };
        }),
    }));
    options.blendedImages?.forEach((pixels, index) => {
        files[`image_data/final_images/${index + 1}`] = new Uint8Array(pixels.flat());
    });
    const data = {
        pxo_version: 8,
        pixelorama_version: "v1.2.3-stable",
        size_x: options.width,
        size_y: options.height,
        color_mode: options.colorMode ?? 5,
        fps: options.fps ?? 6,
        include_blended_images: Boolean(options.blendedImages),
        layers: options.layers.map((layer) => ({
            name: layer.name,
            type: layer.type ?? 0,
            visible: layer.visible ?? true,
            opacity: layer.opacity ?? 1,
            blend_mode: layer.blendMode ?? 0,
            clipping_mask: layer.clippingMask ?? false,
            parent: layer.parent ?? -1,
            effects: layer.effects ?? [],
            animated_params:
                layer.animatedParams ?? 'Dictionary[String, Dictionary]({\n"opacity": {}\n})',
        })),
        frames,
        tags: (options.tags ?? []).map((tag) => ({ ...tag, color: "(1, 0, 0, 1)" })),
    };
    files["data.json"] = strToU8(JSON.stringify(data));
    files.mimetype = strToU8("application/x-pixelorama");
    return Buffer.from(zipSync(files));
}

/** Rewrites the `data.json` of an existing project. */
export function editPixelorama(
    buffer: Buffer,
    edit: (data: Record<string, unknown>) => void,
): Buffer {
    const files = unzipSync(new Uint8Array(buffer));
    const data = JSON.parse(strFromU8(files["data.json"]));
    edit(data);
    files["data.json"] = strToU8(JSON.stringify(data));
    return Buffer.from(zipSync(files));
}
