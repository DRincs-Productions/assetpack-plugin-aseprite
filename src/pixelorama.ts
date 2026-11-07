import { strFromU8, unzipSync } from "fflate";
import { composite, type DecodeOptions, type SpriteDocument } from "./document";

// Values from Pixelorama's source (Global.LayerTypes, BaseLayer.BlendModes, Godot Image.Format).
const LAYER_PIXEL = 0;
const LAYER_GROUP = 1;
const LAYER_3D = 2;
const LAYER_TILEMAP = 3;
const LAYER_AUDIO = 4;
const BLEND_PASS_THROUGH = -2;
const BLEND_NORMAL = 0;
const FORMAT_RGBA8 = 5;
const INDEXED_MODE = -1;
/** Pixelorama's default animation speed. */
const DEFAULT_FPS = 6;

interface PxoLayer {
    name?: string;
    type?: number;
    visible?: boolean;
    opacity?: number;
    blend_mode?: number;
    clipping_mask?: boolean;
    parent?: number;
    effects?: { enabled?: boolean }[];
    animated_params?: string;
    user_data?: string;
}

interface PxoCel {
    image_size?: string;
    offset?: string;
    opacity?: number;
    z_index?: number;
}

interface PxoFrame {
    cels: PxoCel[];
    duration?: number;
    user_data?: string;
}

interface PxoTag {
    name: string;
    from: number;
    to: number;
    color?: string;
    user_data?: string;
}

interface PxoProject {
    pxo_version?: number;
    pixelorama_version?: string;
    size_x: number;
    size_y: number;
    color_mode?: number;
    fps?: number;
    frame_duration?: number[];
    include_blended_images?: boolean;
    layers: PxoLayer[];
    frames: PxoFrame[];
    tags?: PxoTag[];
    user_data?: string;
}

interface LayerNode {
    layer: PxoLayer;
    index: number;
    children: LayerNode[];
}

/** Decodes a Pixelorama 1.0+ project (`.pxo`). */
export function decodePixelorama(
    buffer: Buffer,
    filename: string,
    options: DecodeOptions,
): SpriteDocument {
    let files: Record<string, Uint8Array>;
    try {
        files = unzipSync(new Uint8Array(buffer));
    } catch {
        throw new Error(
            `${filename} is not a Pixelorama 1.0+ project; projects saved with Pixelorama 0.x are not supported.`,
        );
    }
    const data = files["data.json"];
    if (!data) throw new Error(`${filename} has no data.json; it is not a Pixelorama project.`);
    const project = JSON.parse(strFromU8(data)) as PxoProject;
    const { size_x: width, size_y: height } = project;

    const colorMode = project.color_mode ?? FORMAT_RGBA8;
    if (colorMode !== FORMAT_RGBA8 && colorMode !== INDEXED_MODE) {
        throw new Error(
            `Pixelorama color mode ${colorMode} in ${filename} is not supported; only RGBA8 and indexed projects are.`,
        );
    }

    const fps = project.fps || DEFAULT_FPS;
    // Pre-blended frames exist when the project was saved with "Include blended images" enabled
    // in the save dialog. They already contain layer effects and every blend mode.
    const useBlendedImages = !options.layerPrefix;
    const frames = project.frames.map((frame, frameIndex) => {
        const blended = files[`image_data/final_images/${frameIndex + 1}`];
        const relativeDuration = frame.duration ?? project.frame_duration?.[frameIndex] ?? 1;
        return {
            data:
                useBlendedImages && blended?.length === width * height * 4
                    ? Buffer.from(blended)
                    : renderFrame(project, files, frameIndex, filename, options),
            duration: Math.round((relativeDuration * 1000) / fps),
        };
    });

    const tags = project.tags ?? [];
    const animations = tags.map((tag) => {
        // Pixelorama numbers frames from 1 in tags.
        const from = tag.from - 1;
        const to = tag.to - 1;
        if (from > to || from < 0 || to >= frames.length) {
            throw new Error(`Invalid frame range for Pixelorama tag "${tag.name}".`);
        }
        return {
            name: tag.name,
            frames: Array.from({ length: to - from + 1 }, (_, index) => from + index),
        };
    });

    return {
        width,
        height,
        frames,
        animations,
        meta: {
            pixelorama: {
                source: filename,
                pixeloramaVersion: project.pixelorama_version,
                pxoVersion: project.pxo_version,
                width,
                height,
                fps,
                colorMode: colorMode === INDEXED_MODE ? "indexed" : "rgba8",
                layers: project.layers.map((layer) => ({
                    name: layer.name ?? "",
                    type: layer.type ?? LAYER_PIXEL,
                    visible: layer.visible ?? true,
                    opacity: layer.opacity ?? 1,
                    blendMode: layer.blend_mode ?? BLEND_NORMAL,
                    parent: layer.parent ?? -1,
                    userData: layer.user_data ?? "",
                })),
                tags: tags.map((tag) => ({
                    name: tag.name,
                    from: tag.from - 1,
                    to: tag.to - 1,
                    color: tag.color,
                    userData: tag.user_data ?? "",
                })),
                frames: project.frames.map((frame, index) => ({
                    duration: frames[index].duration,
                    userData: frame.user_data ?? "",
                })),
                userData: project.user_data ?? "",
            },
        },
    };
}

function renderFrame(
    project: PxoProject,
    files: Record<string, Uint8Array>,
    frameIndex: number,
    filename: string,
    options: DecodeOptions,
): Buffer {
    const { size_x: width, size_y: height } = project;
    const output = Buffer.alloc(width * height * 4);
    const frame = project.frames[frameIndex];
    const unsupported = (reason: string) =>
        new Error(
            `${reason} in ${filename} is not supported. Save the project with "Include blended images" enabled in Pixelorama's save dialog to convert this file.`,
        );

    const renderNode = (node: LayerNode, target: Buffer): void => {
        const { layer, index } = node;
        const name = layer.name ?? "";
        if (layer.visible === false) return;
        const type = layer.type ?? LAYER_PIXEL;
        if (type === LAYER_AUDIO) return;
        if (layer.effects?.some((effect) => effect.enabled !== false)) {
            throw unsupported(`Layer effects on layer "${name}"`);
        }
        if (layer.clipping_mask) throw unsupported(`Clipping mask on layer "${name}"`);
        if (hasAnimatedOpacity(layer.animated_params)) {
            throw unsupported(`Animated opacity on layer "${name}"`);
        }
        const blendMode = layer.blend_mode ?? BLEND_NORMAL;

        if (type === LAYER_GROUP) {
            if (blendMode === BLEND_PASS_THROUGH) {
                for (const child of node.children) renderNode(child, target);
                return;
            }
            if (blendMode !== BLEND_NORMAL) {
                throw new Error(
                    `Unsupported blend mode ${blendMode} in group "${name}"; only normal and pass-through blending are supported.`,
                );
            }
            const group = Buffer.alloc(output.length);
            for (const child of node.children) renderNode(child, group);
            composite(target, group, width, height, 0, 0, layer.opacity ?? 1, width, height);
            return;
        }
        if (type === LAYER_3D) throw unsupported(`3D layer "${name}"`);
        if (type === LAYER_TILEMAP) throw unsupported(`Tilemap layer "${name}"`);
        if (type !== LAYER_PIXEL) {
            throw new Error(`Unsupported Pixelorama layer type ${type} in layer "${name}".`);
        }
        if (options.layerPrefix && !name.startsWith(options.layerPrefix)) return;
        if (blendMode !== BLEND_NORMAL) {
            throw new Error(
                `Unsupported blend mode ${blendMode} in layer "${name}"; only normal blending is supported.`,
            );
        }

        const cel = frame.cels[index];
        if ((cel.z_index ?? 0) !== 0) {
            throw new Error(
                `Pixelorama cel z-index ${cel.z_index} is not supported (layer "${name}").`,
            );
        }
        const [celWidth, celHeight] = parseVector(cel.image_size) ?? [width, height];
        const [left, top] = parseVector(cel.offset) ?? [0, 0];
        const pixels = files[`image_data/frames/${frameIndex + 1}/layer_${index + 1}`];
        if (!pixels || pixels.length !== celWidth * celHeight * 4) {
            throw new Error(`Invalid or missing cel data in layer "${name}".`);
        }
        composite(
            target,
            pixels,
            width,
            height,
            left,
            top,
            (layer.opacity ?? 1) * (cel.opacity ?? 1),
            celWidth,
            celHeight,
        );
    };

    for (const node of createLayerTree(project.layers)) renderNode(node, output);
    return output;
}

/** Layers are stored bottom to top; a group's children come before the group itself. */
function createLayerTree(layers: PxoLayer[]): LayerNode[] {
    const nodes = layers.map((layer, index) => ({ layer, index, children: [] as LayerNode[] }));
    const roots: LayerNode[] = [];
    for (const node of nodes) {
        const parent = node.layer.parent ?? -1;
        if (parent >= 0 && nodes[parent]) nodes[parent].children.push(node);
        else roots.push(node);
    }
    return roots;
}

/** Parses Godot vector strings such as `"Vector2i(6, 11)"` or `"(13, 40)"`. */
function parseVector(value: string | undefined): [number, number] | undefined {
    const numbers = value?.match(/\(([^)]*)\)/)?.[1].match(/-?\d+(\.\d+)?/g);
    if (!numbers || numbers.length < 2) return undefined;
    return [Math.round(Number(numbers[0])), Math.round(Number(numbers[1]))];
}

/** Animated parameters are a serialized Godot dictionary; an empty `"opacity": {}` means none. */
function hasAnimatedOpacity(animatedParams: string | undefined): boolean {
    const match = animatedParams?.match(/"opacity":\s*\{([^}]*)\}/);
    return Boolean(match && match[1].trim().length > 0);
}
