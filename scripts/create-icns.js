#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const assetDir = path.join(__dirname, '../assets');
const pngPath = path.join(assetDir, 'icon.png');
const icnsPath = path.join(assetDir, 'icon.icns');

// ICNS file format header
function createIcnsFile(imageBuffer) {
  // ICNS file structure:
  // - 4 bytes: 'icns' magic
  // - 4 bytes: file size (big-endian)
  // - IconData entries

  const magicNumber = Buffer.from([0x69, 0x63, 0x6e, 0x73]); // 'icns'

  // Create a minimal ICNS with just the image data
  // Type: 'ic09' (512x512) is most compatible
  const imageType = Buffer.from([0x69, 0x63, 0x30, 0x39]); // 'ic09'
  const dataSize = Buffer.alloc(4);
  dataSize.writeUInt32BE(imageBuffer.length + 8, 0);

  // File size = header(8) + imageType(4) + size(4) + imageData
  const fileSize = Buffer.alloc(4);
  fileSize.writeUInt32BE(8 + imageBuffer.length + 8, 0);

  return Buffer.concat([magicNumber, fileSize, imageType, dataSize, imageBuffer]);
}

async function createIcns() {
  try {
    console.log('Converting icon.png to icon.icns...');

    if (!fs.existsSync(pngPath)) {
      throw new Error(`PNG file not found: ${pngPath}`);
    }

    // Resize PNG to 512x512 (standard Mac icon size)
    const resizedPng = await sharp(pngPath)
      .resize(512, 512, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .png()
      .toBuffer();

    // Create ICNS file
    const icnsBuffer = createIcnsFile(resizedPng);
    fs.writeFileSync(icnsPath, icnsBuffer);

    console.log(`✓ Created ${icnsPath}`);
    console.log('✓ Icon size: 512x512');
    console.log('✓ Ready to build for macOS!');
    console.log('\nYou can now run: npm run build');
  } catch (err) {
    console.error('Error creating ICNS:', err.message);
    process.exit(1);
  }
}

createIcns();
