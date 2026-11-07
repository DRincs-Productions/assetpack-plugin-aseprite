import { deflateSync } from "node:zlib";

function word(value: number): Buffer {
    const result = Buffer.alloc(2);
    result.writeUInt16LE(value);
    return result;
}

function chunk(type: number, body: Buffer): Buffer {
    const header = Buffer.alloc(6);
    header.writeUInt32LE(body.length + 6);
    header.writeUInt16LE(type, 4);
    return Buffer.concat([header, body]);
}

function layerChunk(name: string, type = 0, childLevel = 0, visible = true): Buffer {
    const text = Buffer.from(name);
    const body = Buffer.concat([
        word(visible ? 1 : 0),
        word(type),
        word(childLevel),
        Buffer.alloc(4),
        word(0),
        Buffer.from([255]),
        Buffer.alloc(3),
        word(text.length),
        text,
    ]);
    return chunk(0x2004, body);
}

function celChunk(
    color: [number, number, number, number],
    x: number,
    y: number,
    layerIndex = 0,
): Buffer {
    const cel = Buffer.from(color);
    const body = Buffer.concat([
        word(layerIndex),
        Buffer.from([x, 0, y, 0, 255]),
        word(2),
        Buffer.alloc(2),
        Buffer.alloc(5),
        word(1),
        word(1),
        deflateSync(cel),
    ]);
    return chunk(0x2005, body);
}

function tagChunk(): Buffer {
    const name = Buffer.from("walk");
    const body = Buffer.concat([
        word(1),
        Buffer.alloc(8),
        word(0),
        word(2),
        Buffer.from([2]),
        word(0),
        Buffer.alloc(6),
        Buffer.from([255, 0, 0, 0]),
        word(name.length),
        name,
    ]);
    return chunk(0x2018, body);
}

function frame(chunks: Buffer[], duration: number): Buffer {
    const body = Buffer.concat(chunks);
    const header = Buffer.alloc(16);
    header.writeUInt32LE(header.length + body.length, 0);
    header.writeUInt16LE(0xf1fa, 4);
    header.writeUInt16LE(chunks.length, 6);
    header.writeUInt16LE(duration, 8);
    header.writeUInt32LE(chunks.length, 12);
    return Buffer.concat([header, body]);
}

export function makeAsepriteFixture({ withTags = true }: { withTags?: boolean } = {}): Buffer {
    const frames = [
        frame(
            [
                layerChunk("body"),
                layerChunk("hidden-group", 1, 0, false),
                layerChunk("overlay", 0, 1),
                ...(withTags ? [tagChunk()] : []),
                celChunk([255, 0, 0, 255], 0, 0),
                celChunk([255, 255, 0, 255], 1, 0, 2),
            ],
            80,
        ),
        frame([celChunk([0, 255, 0, 255], 1, 0)], 120),
        frame([celChunk([0, 0, 255, 255], 0, 0)], 200),
    ];
    const header = Buffer.alloc(128);
    header.writeUInt16LE(0xa5e0, 4);
    header.writeUInt16LE(frames.length, 6);
    header.writeUInt16LE(2, 8);
    header.writeUInt16LE(1, 10);
    header.writeUInt16LE(32, 12);
    header.writeUInt8(1, 25);
    header.writeUInt8(1, 26);
    header.writeUInt16LE(2, 28);
    const result = Buffer.concat([header, ...frames]);
    result.writeUInt32LE(result.length, 0);
    return result;
}
