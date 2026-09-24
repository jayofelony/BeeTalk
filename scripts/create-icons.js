#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const pngToIcoModule = require('png-to-ico');
const pngToIco = pngToIcoModule.default || pngToIcoModule;

const assetDir = path.join(__dirname, '../assets');
// Source artwork: high resolution, any aspect ratio (padded to square below)
const pngPath = path.join(assetDir, 'icon.png');
const icoPath = path.join(assetDir, 'icon.ico');
const icnsPath = path.join(assetDir, 'icon.icns');
// Linux icon must be square and a standard icon-theme size, or GNOME/KDE
// can't find it and show a generic icon. Also used as the window icon.
const linuxIconPath = path.join(assetDir, 'icon-linux.png');
// Tray: 32px plus @2x for high-DPI screens (Electron picks it automatically)
const trayPath = path.join(assetDir, 'tray.png');
const tray2xPath = path.join(assetDir, 'tray@2x.png');

// Square PNG of the artwork at the given size, transparent padding
function squarePng(size) {
  return sharp(pngPath)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

// ICNS container: 'icns' header followed by (type, length, PNG data) entries
function createIcnsFile(entries) {
  const chunks = entries.map(({ type, data }) => {
    const header = Buffer.alloc(8);
    header.write(type, 0, 'ascii');
    header.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([header, data]);
  });
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([header, body]);
}

async function createWindowsIco() {
  // Generate multiple sizes so taskbar/start menu scale crisply.
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngBuffers = await Promise.all(sizes.map(squarePng));

  const icoBuffer = await pngToIco(pngBuffers);
  fs.writeFileSync(icoPath, icoBuffer);
  console.log(`✓ Created ${icoPath}`);
}

async function createMacIcns() {
  // ic07/ic08/ic09 = 128/256/512 px PNG entries
  const entries = await Promise.all(
    [['ic07', 128], ['ic08', 256], ['ic09', 512]].map(async ([type, size]) => ({ type, data: await squarePng(size) }))
  );
  fs.writeFileSync(icnsPath, createIcnsFile(entries));
  console.log(`✓ Created ${icnsPath}`);
}

async function createLinuxPng() {
  fs.writeFileSync(linuxIconPath, await squarePng(512));
  console.log(`✓ Created ${linuxIconPath}`);
}

async function createTrayPngs() {
  fs.writeFileSync(trayPath, await squarePng(32));
  fs.writeFileSync(tray2xPath, await squarePng(64));
  console.log(`✓ Created ${trayPath} and ${tray2xPath}`);
}

async function main() {
  try {
    if (!fs.existsSync(pngPath)) {
      throw new Error(`PNG file not found: ${pngPath}`);
    }

    console.log('Generating icon assets from assets/icon.png...');
    await createWindowsIco();
    await createMacIcns();
    await createLinuxPng();
    await createTrayPngs();
    console.log('✓ Icon generation complete');
  } catch (err) {
    console.error('Error generating icons:', err.message);
    process.exit(1);
  }
}

main();
