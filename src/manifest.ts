import { readFile, writeFile } from "node:fs/promises";
import { type AssetPipe, path } from "@assetpack/core";

export interface AsepriteManifestModOptions {
    /** The manifest path, the same value passed to `pixiManifest` (default `manifest.json`). */
    output?: string;
}

interface ManifestAsset {
    alias: string[];
}

interface Manifest {
    bundles: { assets: ManifestAsset[] }[];
}

const ASEPRITE_EXTENSION = /\.(aseprite|ase)$/i;

/**
 * Adds aliases without the `.aseprite`/`.ase` extension to the manifest written by `pixiManifest`.
 * AssetPack's `trimExtensions` skips extensions longer than six characters, so
 * `walk.aseprite` would otherwise only be reachable as `walk.aseprite`.
 *
 * Add it after `pixiPipes` (or `pixiManifest`) with the same manifest `output`.
 * An alias is not added when another manifest entry already uses it.
 */
export function asepriteManifestMod(options: AsepriteManifestModOptions = {}): AssetPipe {
    return {
        folder: false,
        name: "aseprite-manifest-mod",
        defaultOptions: { output: "manifest.json", ...options },
        async finish(_asset, pipeOptions: Required<AsepriteManifestModOptions>, pipeSystem) {
            const manifestPath =
                path.dirname(pipeOptions.output) === "."
                    ? path.joinSafe(pipeSystem.outputPath, pipeOptions.output)
                    : pipeOptions.output;
            const manifest: Manifest = JSON.parse(await readFile(manifestPath, "utf8"));
            const assets = manifest.bundles.flatMap((bundle) => bundle.assets);
            const usedAliases = new Set(assets.flatMap((asset) => asset.alias));

            for (const asset of assets) {
                for (const alias of [...asset.alias]) {
                    if (!ASEPRITE_EXTENSION.test(alias)) continue;
                    const trimmed = alias.replace(ASEPRITE_EXTENSION, "");
                    if (usedAliases.has(trimmed)) continue;
                    asset.alias.push(trimmed);
                    usedAliases.add(trimmed);
                }
            }

            await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
        },
    };
}
