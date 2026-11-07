import { deflateSync } from "node:zlib";

type Rgba = [number, number, number, number];

export interface FixtureLayer {
    name: string;
    /** 0 = image, 1 = group, 2 = tilemap. */
    type?: number;
    childLevel?: number;
    visible?: boolean;
    reference?: boolean;
    blendMode?: number;
    opacity?: number;
}

export interface FixtureCel {
    layer: number;
    x?: number;
    y?: number;
    opacity?: number;
    zIndex?: number;
    /** Pixels in row order; `width * height` entries. Omit with `linkedFrame`. */
    pixels?: Rgba[];
    width?: number;
    height?: number;
    /** Creates a linked cel that reuses the cel of the same layer in this frame. */
    linkedFrame?: number;
}

export interface FixtureTag {
    name: string;
    from: number;
    to: number;
    /** 0 = forward, 1 = reverse, 2 = ping-pong, 3 = ping-pong reverse. */
    direction?: number;
    repeat?: number;
}

export interface FixtureFrame {
    duration: number;
    cels: FixtureCel[];
}

export interface FixtureOptions {
    width: number;
    height: number;
    colorDepth?: number;
    /** Header flags: 1 = layer opacity is valid, 2 = group opacity/blend mode is valid. */
    headerFlags?: number;
    layers: FixtureLayer[];
    tags?: FixtureTag[];
    frames: FixtureFrame[];
}

function word(value: number): Buffer {
    const result = Buffer.alloc(2);
    result.writeUInt16LE(value);
    return result;
}

function short(value: number): Buffer {
    const result = Buffer.alloc(2);
    result.writeInt16LE(value);
    return result;
}

function text(value: string): Buffer {
    const bytes = Buffer.from(value);
    return Buffer.concat([word(bytes.length), bytes]);
}

function chunk(type: number, body: Buffer): Buffer {
    const header = Buffer.alloc(6);
    header.writeUInt32LE(body.length + 6);
    header.writeUInt16LE(type, 4);
    return Buffer.concat([header, body]);
}

function layerChunk(layer: FixtureLayer): Buffer {
    const flags = (layer.visible === false ? 0 : 1) | (layer.reference ? 64 : 0);
    return chunk(
        0x2004,
        Buffer.concat([
            word(flags),
            word(layer.type ?? 0),
            word(layer.childLevel ?? 0),
            Buffer.alloc(4),
            word(layer.blendMode ?? 0),
            Buffer.from([layer.opacity ?? 255]),
            Buffer.alloc(3),
            text(layer.name),
            // Tilemap layers end with the tileset index.
            layer.type === 2 ? Buffer.alloc(4) : Buffer.alloc(0),
        ]),
    );
}

function celChunk(cel: FixtureCel): Buffer {
    const head = Buffer.concat([
        word(cel.layer),
        short(cel.x ?? 0),
        short(cel.y ?? 0),
        Buffer.from([cel.opacity ?? 255]),
    ]);
    if (cel.linkedFrame !== undefined) {
        return chunk(
            0x2005,
            Buffer.concat([
                head,
                word(1),
                short(cel.zIndex ?? 0),
                Buffer.alloc(5),
                word(cel.linkedFrame),
            ]),
        );
    }
    const pixels = cel.pixels ?? [];
    const width = cel.width ?? 1;
    const height = cel.height ?? 1;
    if (pixels.length !== width * height) throw new Error("Fixture cel pixel count mismatch.");
    return chunk(
        0x2005,
        Buffer.concat([
            head,
            word(2),
            short(cel.zIndex ?? 0),
            Buffer.alloc(5),
            word(width),
            word(height),
            deflateSync(Buffer.from(pixels.flat())),
        ]),
    );
}

function tagsChunk(tags: FixtureTag[]): Buffer {
    return chunk(
        0x2018,
        Buffer.concat([
            word(tags.length),
            Buffer.alloc(8),
            ...tags.map((tag) =>
                Buffer.concat([
                    word(tag.from),
                    word(tag.to),
                    Buffer.from([tag.direction ?? 0]),
                    word(tag.repeat ?? 0),
                    Buffer.alloc(6),
                    Buffer.from([255, 0, 0, 0]),
                    text(tag.name),
                ]),
            ),
        ]),
    );
}

function frameBuffer(chunks: Buffer[], duration: number): Buffer {
    const body = Buffer.concat(chunks);
    const header = Buffer.alloc(16);
    header.writeUInt32LE(header.length + body.length, 0);
    header.writeUInt16LE(0xf1fa, 4);
    header.writeUInt16LE(Math.min(chunks.length, 0xffff), 6);
    header.writeUInt16LE(duration, 8);
    header.writeUInt32LE(chunks.length, 12);
    return Buffer.concat([header, body]);
}

/** Builds a minimal valid Aseprite file in memory. */
export function buildAseprite(options: FixtureOptions): Buffer {
    const frames = options.frames.map((frame, index) => {
        const chunks: Buffer[] = [];
        if (index === 0) {
            chunks.push(...options.layers.map(layerChunk));
            if (options.tags?.length) chunks.push(tagsChunk(options.tags));
        }
        chunks.push(...frame.cels.map(celChunk));
        return frameBuffer(chunks, frame.duration);
    });
    const header = Buffer.alloc(128);
    header.writeUInt16LE(0xa5e0, 4);
    header.writeUInt16LE(frames.length, 6);
    header.writeUInt16LE(options.width, 8);
    header.writeUInt16LE(options.height, 10);
    header.writeUInt16LE(options.colorDepth ?? 32, 12);
    header.writeUInt32LE(options.headerFlags ?? 3, 14);
    header.writeUInt8(1, 34);
    header.writeUInt8(1, 35);
    const result = Buffer.concat([header, ...frames]);
    result.writeUInt32LE(result.length, 0);
    return result;
}

/** A 2x1 sprite with three frames, a hidden group, and an optional ping-pong "walk" tag. */
export function makeAsepriteFixture({ withTags = true }: { withTags?: boolean } = {}): Buffer {
    return buildAseprite({
        width: 2,
        height: 1,
        layers: [
            { name: "body" },
            { name: "hidden-group", type: 1, visible: false },
            { name: "overlay", childLevel: 1 },
        ],
        tags: withTags ? [{ name: "walk", from: 0, to: 2, direction: 2 }] : [],
        frames: [
            {
                duration: 80,
                cels: [
                    { layer: 0, pixels: [[255, 0, 0, 255]] },
                    { layer: 2, x: 1, pixels: [[255, 255, 0, 255]] },
                ],
            },
            { duration: 120, cels: [{ layer: 0, x: 1, pixels: [[0, 255, 0, 255]] }] },
            { duration: 200, cels: [{ layer: 0, pixels: [[0, 0, 255, 255]] }] },
        ],
    });
}
