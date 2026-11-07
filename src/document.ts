/** Options shared by every source format. */
export interface DecodeOptions {
    /** Include only pixel layers whose names begin with this value. */
    layerPrefix?: string;
}

/** A frame rendered to a full-canvas RGBA buffer. */
export interface RenderedFrame {
    /** `width * height * 4` bytes of non-premultiplied RGBA. */
    data: Buffer;
    /** Frame duration in milliseconds. */
    duration: number;
}

/** A named animation as an ordered list of frame indices (already expanded for its direction). */
export interface SpriteAnimation {
    name: string;
    frames: number[];
}

/** The format-independent result of decoding a source file. */
export interface SpriteDocument {
    width: number;
    height: number;
    frames: RenderedFrame[];
    animations: SpriteAnimation[];
    /** Extra JSON-safe data stored under `meta` in the spritesheet, such as `{ aseprite: {...} }`. */
    meta: Record<string, unknown>;
}

/**
 * Draws `source` over `target` with normal ("source over") blending.
 * Both buffers are non-premultiplied RGBA; pixels outside the target are clipped.
 */
export function composite(
    target: Buffer,
    source: Uint8Array,
    targetWidth: number,
    targetHeight: number,
    left: number,
    top: number,
    opacity: number,
    width: number,
    height: number,
): void {
    if (opacity <= 0) return;
    for (let sourceY = 0; sourceY < height; sourceY++) {
        const y = top + sourceY;
        if (y < 0 || y >= targetHeight) continue;
        for (let sourceX = 0; sourceX < width; sourceX++) {
            const x = left + sourceX;
            if (x < 0 || x >= targetWidth) continue;
            const sourceOffset = (sourceY * width + sourceX) * 4;
            const targetOffset = (y * targetWidth + x) * 4;
            const sourceAlpha = (source[sourceOffset + 3] / 255) * opacity;
            if (sourceAlpha <= 0) continue;
            const targetAlpha = target[targetOffset + 3] / 255;
            const outputAlpha = sourceAlpha + targetAlpha * (1 - sourceAlpha);
            for (let channel = 0; channel < 3; channel++) {
                target[targetOffset + channel] = Math.round(
                    (source[sourceOffset + channel] * sourceAlpha +
                        target[targetOffset + channel] * targetAlpha * (1 - sourceAlpha)) /
                        outputAlpha,
                );
            }
            target[targetOffset + 3] = Math.round(outputAlpha * 255);
        }
    }
}
