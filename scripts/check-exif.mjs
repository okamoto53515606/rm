#!/usr/bin/env node
// JPEG の APP1(Exif) セグメントと GPS IFD の有無を検査する。
// 使い方: node scripts/check-exif.mjs <file.jpg>
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/check-exif.mjs <file.jpg>');
  process.exit(2);
}

const buf = readFileSync(file);
let exif = false;
let exifStart = -1;

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
      break;
    }
    i += 2 + len;
  }
}

let gps = false;
if (exif && exifStart >= 0) {
  const t = exifStart;
  const little = buf.subarray(t, t + 2).toString('latin1') === 'II';
  const u16 = (o) => (little ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (little ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  try {
    const ifd0 = u32(t + 4);
    const count = u16(t + ifd0);
    for (let n = 0; n < count; n += 1) {
      const entry = t + ifd0 + 2 + n * 12;
      if (u16(entry) === 0x8825) {
        gps = true;
        break;
      }
    }
  } catch {
    /* 壊れたTIFFはexif=trueのみ */
  }
}

console.log(JSON.stringify({ file, bytes: buf.length, exif, gps }));
