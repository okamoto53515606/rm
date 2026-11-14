#!/usr/bin/env node
// JPEG のメタデータを検査する。
//   node scripts/check-exif.mjs <file.jpg> [--verbose]
//
// 「Exif があるか」だけでなく、**識別につながる情報**（GPS・機種名・撮影日時など）が
// 残っているかを見る。ブラウザの JPEG エンコーダは、色空間（sRGB）と画素サイズだけを
// 含む最小の Exif を付けることがあり、exif=true でも問題ない場合があるため。
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const verbose = process.argv.includes('--verbose');
if (!file) {
  console.error('usage: node scripts/check-exif.mjs <file.jpg> [--verbose]');
  process.exit(2);
}

const TAG_NAMES = new Map([
  [0x010f, 'Make'],
  [0x0110, 'Model'],
  [0x0112, 'Orientation'],
  [0x011a, 'XResolution'],
  [0x011b, 'YResolution'],
  [0x0131, 'Software'],
  [0x0132, 'DateTime'],
  [0x013b, 'Artist'],
  [0x8298, 'Copyright'],
  [0x8769, 'ExifIFD'],
  [0x8825, 'GPS'],
  [0x9003, 'DateTimeOriginal'],
  [0x9004, 'DateTimeDigitized'],
  [0x9010, 'OffsetTime'],
  [0x927c, 'MakerNote'],
  [0xa001, 'ColorSpace'],
  [0xa002, 'PixelXDimension'],
  [0xa003, 'PixelYDimension'],
  [0xa420, 'ImageUniqueID'],
  [0xa430, 'OwnerName'],
  [0xa431, 'BodySerialNumber'],
  [0xa434, 'LensModel'],
  [0xc4a5, 'PrintImageMatching'],
]);

// これが残っていたら「識別情報あり」とみなす
const IDENTIFYING = new Set([
  'Make',
  'Model',
  'Software',
  'DateTime',
  'DateTimeOriginal',
  'DateTimeDigitized',
  'OffsetTime',
  'Artist',
  'Copyright',
  'MakerNote',
  'ImageUniqueID',
  'OwnerName',
  'BodySerialNumber',
  'LensModel',
  'PrintImageMatching',
  'GPS',
]);

const buf = readFileSync(file);
let exif = false;
let exifStart = -1;
let app13 = false;

if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
  let i = 2;
  while (i + 4 <= buf.length && buf[i] === 0xff) {
    const marker = buf[i + 1];
    if (marker === 0xd9 || marker === 0xda) break; // EOI / SOS
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) break;
    const start = i + 4;
    if (marker === 0xe1 && buf.subarray(start, start + 6).toString('latin1') === 'Exif\0\0') {
      exif = true;
      exifStart = start + 6;
    }
    if (marker === 0xed) app13 = true; // Photoshop / IPTC / XMP
    i += 2 + len;
  }
}

const tags = [];
if (exif && exifStart >= 0) {
  const t = exifStart;
  const little = buf.subarray(t, t + 2).toString('latin1') === 'II';
  const u16 = (o) => (little ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (little ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const readIfd = (offset) => {
    const out = [];
    try {
      const count = u16(t + offset);
      for (let n = 0; n < count; n += 1) {
        const entry = t + offset + 2 + n * 12;
        const tag = u16(entry);
        out.push({ tag, name: TAG_NAMES.get(tag) ?? `0x${tag.toString(16)}` });
        if (tag === 0x8769) {
          const sub = u32(entry + 8);
          if (sub > 0 && sub < buf.length) out.push(...readIfd(sub));
        }
      }
    } catch {
      /* 壊れた TIFF は分かる範囲だけ */
    }
    return out;
  };
  tags.push(...readIfd(u32(t + 4)));
}

const tagNames = [...new Set(tags.map((x) => x.name))];
const gps = tagNames.includes('GPS');
const identifying = tagNames.filter((name) => IDENTIFYING.has(name));

const verdict = !exif
  ? 'Exif なし'
  : identifying.length
    ? `識別情報あり（${identifying.join(', ')}）`
    : '識別情報なし（色空間・画素サイズなどのみ）';

console.log(
  JSON.stringify({
    file,
    bytes: buf.length,
    exif,
    gps,
    identifying: identifying.length > 0,
    identifyingTags: identifying,
    tags: tagNames,
    app13,
    verdict,
    ...(verbose ? { raw: tags } : {}),
  }),
);
