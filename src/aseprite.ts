import Aseprite from "ase-parser";
import {
    composite,
    type DecodeOptions,
    type SpriteAnimation,
    type SpriteDocument,
} from "./document";

/** Header flag: layer opacity has a valid value. */
const HEADER_LAYER_OPACITY_VALID = 1;
/** Header flag: group opacity and blend mode have valid values. */
const HEADER_GROUP_OPACITY_VALID = 2;

const PLAYBACK_DIRECTIONS: Record<string, string> = {
    Forward: "forward",
    Reverse: "reverse",
    "Ping-pong": "pingpong",
    "Ping-pong Reverse": "pingpong_reverse",
};

interface RenderOptions extends DecodeOptions {
    layerOpacityValid: boolean;
    groupOpacityValid: boolean;
}

interface LayerNode {
    layer: Aseprite.Layer;
    index: number;
    children: LayerNode[];
}

/** Decodes an Aseprite/LibreSprite `.ase`/`.aseprite` file. */
export function decodeAseprite(
    buffer: Buffer,
    filename: string,
    options: DecodeOptions,
): SpriteDocument {
    const ase = new Aseprite(buffer, filename);
    ase.parse();

    if (ase.colorDepth !== 32) {
        throw new Error(
            `Aseprite plugin supports 32-bit RGBA documents; ${filename} is ${ase.colorDepth}-bit.`,
        );
    }

    const headerFlags = buffer.readUInt32LE(14);
    const renderOptions: RenderOptions = {
        layerPrefix: options.layerPrefix,
        layerOpacityValid: (headerFlags & HEADER_LAYER_OPACITY_VALID) !== 0,
        groupOpacityValid: (headerFlags & HEADER_GROUP_OPACITY_VALID) !== 0,
    };

    return {
        width: ase.width,
        height: ase.height,
        frames: ase.frames.map((frame, frameIndex) => ({
            data: renderFrame(ase, frameIndex, renderOptions),
            duration: frame.frameDuration,
        })),
        animations: getAnimations(ase),
        meta: {
            aseprite: {
                source: ase.name,
                fileSize: ase.fileSize,
                frameCount: ase.numFrames,
                width: ase.width,
                height: ase.height,
                colorDepth: ase.colorDepth,
                pixelRatio: ase.pixelRatio,
                layers: ase.layers,
                tags: ase.tags,
                slices: ase.slices,
                palette: ase.palette,
                colorProfile: ase.colorProfile
                    ? {
                          ...ase.colorProfile,
                          icc: undefined,
                          hasIccProfile: Boolean(ase.colorProfile.icc),
                      }
                    : undefined,
                frames: ase.frames.map((frame) => ({
                    duration: frame.frameDuration,
                    cels: frame.cels.map(
                        ({ layerIndex, xpos, ypos, opacity, celType, zIndex, link, w, h }) => ({
                            layerIndex,
                            x: xpos,
                            y: ypos,
                            opacity,
                            type: celType,
                            zIndex,
                            link,
                            width: w,
                            height: h,
                        }),
                    ),
                })),
            },
        },
    };
}

function getAnimations(ase: Aseprite): SpriteAnimation[] {
    return ase.tags.map((tag) => {
        if (tag.from > tag.to || tag.from < 0 || tag.to >= ase.frames.length) {
            throw new Error(`Invalid frame range for Aseprite tag "${tag.name}".`);
        }
        const indices = Array.from(
            { length: tag.to - tag.from + 1 },
            (_, index) => tag.from + index,
        );
        const direction = PLAYBACK_DIRECTIONS[tag.animDirection];
        if (!direction)
            throw new Error(
                `Unknown Aseprite playback direction "${tag.animDirection}" for tag "${tag.name}".`,
            );
        if (direction === "reverse") indices.reverse();
        if (direction === "pingpong") indices.push(...indices.slice(1, -1).reverse());
        if (direction === "pingpong_reverse") {
            indices.reverse();
            indices.push(...indices.slice(1, -1).reverse());
        }
        return { name: tag.name, frames: indices };
    });
}

function renderFrame(ase: Aseprite, frameIndex: number, options: RenderOptions): Buffer {
    const output = Buffer.alloc(ase.width * ase.height * 4);
    const tree = createLayerTree(ase.layers);
    const cels = ase.frames[frameIndex].cels;

    const renderNode = (node: LayerNode, target: Buffer, inheritedOpacity: number): void => {
        const { layer } = node;
        // Reference layers are editor-only, Aseprite never exports them.
        if (!layer.flags.visible || layer.flags.reference) return;

        if (layer.type === 1) {
            const opacity = options.groupOpacityValid
                ? (inheritedOpacity * layer.opacity) / 255
                : inheritedOpacity;
            if (options.groupOpacityValid && layer.blendMode !== 0) {
                throw new Error(
                    `Unsupported blend mode ${layer.blendMode} in group "${layer.name}"; only normal blending is supported.`,
                );
            }
            const group = Buffer.alloc(output.length);
            for (const child of node.children) renderNode(child, group, 1);
            composite(target, group, ase.width, ase.height, 0, 0, opacity, ase.width, ase.height);
            return;
        }
        if (options.layerPrefix && !layer.name.startsWith(options.layerPrefix)) return;
        if (layer.type !== 0) {
            throw new Error(
                `Unsupported Aseprite layer type ${layer.type} in layer "${layer.name}".`,
            );
        }
        const opacity = options.layerOpacityValid
            ? (inheritedOpacity * layer.opacity) / 255
            : inheritedOpacity;
        if (layer.blendMode !== 0) {
            throw new Error(
                `Unsupported blend mode ${layer.blendMode} in layer "${layer.name}"; only normal blending is supported.`,
            );
        }

        for (const cel of cels) {
            if (cel.layerIndex !== node.index) continue;
            if (cel.celType === 3)
                throw new Error(`Tilemap cels are not supported (layer "${layer.name}").`);
            if (cel.zIndex !== 0)
                throw new Error(
                    `Aseprite cel z-index ${cel.zIndex} is not supported (layer "${layer.name}").`,
                );
            if (!cel.rawCelData || cel.rawCelData.length !== cel.w * cel.h * 4) {
                throw new Error(`Invalid or unsupported cel data in layer "${layer.name}".`);
            }
            composite(
                target,
                cel.rawCelData,
                ase.width,
                ase.height,
                cel.xpos,
                cel.ypos,
                (opacity * cel.opacity) / 255,
                cel.w,
                cel.h,
            );
        }
    };

    for (const node of tree) renderNode(node, output, 1);
    return output;
}

function createLayerTree(layers: Aseprite.Layer[]): LayerNode[] {
    const roots: LayerNode[] = [];
    const parents: LayerNode[] = [];
    for (const [index, layer] of layers.entries()) {
        const node = { layer, index, children: [] };
        while (parents.length > layer.layerChildLevel) parents.pop();
        const parent = parents.at(-1);
        if (parent) parent.children.push(node);
        else roots.push(node);
        if (layer.type === 1) parents.push(node);
    }
    return roots;
}
