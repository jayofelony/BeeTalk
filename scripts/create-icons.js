#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const pngToIcoModule = require('png-to-ico');
const pngToIco = pngToIcoModule.default || pngToIcoModule;

const assetDir = path.join(__dirname, '../assets');
const pngPath = path.join(assetDir, 'icon.png');
const icoPath = path.join(assetDir, 'icon.ico');
const icnsPath = path.join(assetDir, 'icon.icns');

// ICNS file format header
function createIcnsFile(imageBuffer) {
  const magicNumber = Buffer.from([0x69, 0x63, 0x6e, 0x73]); // 'icns'
  const imageType = Buffer.from([0x69, 0x63, 0x30, 0x39]); // 'ic09' (512x512)

  const dataSize = Buffer.alloc(4);
  dataSize.writeUInt32BE(imageBuffer.length + 8, 0);

  const fileSize = Buffer.alloc(4);
  fileSize.writeUInt32BE(8 + imageBuffer.length + 8, 0);

  return Buffer.concat([magicNumber, fileSize, imageType, dataSize, imageBuffer]);
}

async function createWindowsIco() {
  // Generate multiple sizes so taskbar/start menu scale crisply.
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngBuffers = await Promise.all(
    sizes.map((size) =>
      sharp(pngPath)
        .resize(size, size, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 }
        })
        .png()
        .toBuffer()
    )
  );

  const icoBuffer = await pngToIco(pngBuffers);
  fs.writeFileSync(icoPath, icoBuffer);
  console.log(`✓ Created ${icoPath}`);
}

async function createMacIcns() {
  const resizedPng = await sharp(pngPath)
    .resize(512, 512, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .png()
    .toBuffer();

  const icnsBuffer = createIcnsFile(resizedPng);
  fs.writeFileSync(icnsPath, icnsBuffer);
  console.log(`✓ Created ${icnsPath}`);
}

async function main() {
  try {
    if (!fs.existsSync(pngPath)) {
      throw new Error(`PNG file not found: ${pngPath}`);
    }

    console.log('Generating icon assets from assets/icon.png...');
    await createWindowsIco();
    await createMacIcns();
    console.log('✓ Icon generation complete');
  } catch (err) {
    console.error('Error generating icons:', err.message);
    process.exit(1);
  }
}

main();
