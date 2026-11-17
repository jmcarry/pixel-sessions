import { exec, appHome, checking } from "herdr";

// Common image formats readable by macOS ImageIO, plus native GPUI SVG/PNG/JPEG.
export const isImagePath = (file) => /\.(?:jpe?g|jpe|png|svg|gif|webp|avif|heic|heif|heics|tiff?|bmp|icns|ico|jp2|j2k|jpf|jpx|psd|dng|cr2|cr3|nef|nrw|arw|raf|orf|rw2|pef|srw|exr|tga|pict|pct)$/i.test(String(file || ""));

// Every save gets a different app-relative image path: Herdr caches decoded
// images by path. Source images are read only; the helper writes its own cache.
export async function prepareImage(file, { on = null } = {}) {
  if (checking()) return null;
  if (!isImagePath(file)) throw new Error("This file is not a supported image");
  if (on) throw new Error("Image preview currently reads files on this Mac. Open a local copy to preview this image.");
  const result = await exec("python3", [
    `${appHome()}/mods/md-preview-tools/images.py`, file, appHome(),
  ], { timeout: 30000 });
  if (result.code !== 0) throw new Error((result.stderr || result.stdout || "Cannot prepare image").trim().slice(0, 280));
  const value = JSON.parse(result.stdout);
  if (!value.path || !(value.width > 0) || !(value.height > 0)) throw new Error("Cannot read image dimensions");
  return value;
}
