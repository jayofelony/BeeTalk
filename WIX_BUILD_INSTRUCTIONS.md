# Building BeeTalk MSI with Custom WiX

This directory contains a custom WiX source file (`BeeTalk.wxs`) that includes proper process detection and closure for BeeTalk.exe.

## Prerequisites

1. **WiX Toolset 3.x** - Download from https://github.com/wixtoolset/wix3/releases
   - Install to default location (typically `C:\Program Files (x86)\WiX Toolset v3.11`)

2. **.NET Framework** - Required by WiX tools

## Build Process

### Step 1: Build the Electron app
```bash
npm run build:win
```
This creates the packaged app files in the `dist` folder.

### Step 2: Generate file list for WiX
Use WiX's `heat.exe` to generate the file list from your built app:

```bash
# Navigate to WiX bin directory
cd "C:\Program Files (x86)\WiX Toolset v3.11\bin"

# Generate files.wxs from the dist output
heat.exe dir "C:\Users\oudsh\Downloads\BeeTalk\dist\BeeTalk" -o "C:\Users\oudsh\Downloads\BeeTalk\files.wxs" -gg -srd -dr INSTALLFOLDER

# Update the ComponentRef in BeeTalk.wxs to reference the generated files
```

### Step 3: Compile WiX source files
```bash
candle.exe -o "C:\Users\oudsh\Downloads\BeeTalk\obj\" -arch x64 ^
  "C:\Users\oudsh\Downloads\BeeTalk\BeeTalk.wxs" ^
  "C:\Users\oudsh\Downloads\BeeTalk\files.wxs"
```

### Step 4: Link to create MSI
```bash
light.exe -o "C:\Users\oudsh\Downloads\BeeTalk\dist\BeeTalk-1.0.2.msi" ^
  -ext WixUIExtension ^
  -ext WixUtilExtension ^
  "C:\Users\oudsh\Downloads\BeeTalk\obj\BeeTalk.wixobj" ^
  "C:\Users\oudsh\Downloads\BeeTalk\obj\files.wixobj"
```

### Step 5: Sign the MSI (Optional but recommended)
```bash
# Using signtool.exe (part of Windows SDK)
signtool.exe sign /f certificate.pfx /p password /t http://timestamp.server /d "BeeTalk" ^
  "C:\Users\oudsh\Downloads\BeeTalk\dist\BeeTalk-1.0.2.msi"
```

## Key Features of This WiX Setup

✅ **Process Detection** - `util:CloseApplication` closes BeeTalk.exe before installation
✅ **User Notification** - Shows a dialog asking user to close the app (if not auto-closed)
✅ **Upgrade Support** - `MajorUpgrade` element handles previous version removal
✅ **Shortcuts** - Creates Start Menu and Desktop shortcuts
✅ **Per-Machine Install** - Installs for all users
✅ **64-bit** - x64 architecture

## Automated Build Script (PowerShell)

Save this as `build-msi.ps1`:

```powershell
$WiXPath = "C:\Program Files (x86)\WiX Toolset v3.11\bin"
$ProjectPath = "C:\Users\oudsh\Downloads\BeeTalk"

# Step 1: Build Electron app
Write-Host "Building Electron app..." -ForegroundColor Green
cd $ProjectPath
npm run build:win

# Step 2: Generate files
Write-Host "Generating file list..." -ForegroundColor Green
& "$WiXPath\heat.exe" dir "$ProjectPath\dist\BeeTalk" -o "$ProjectPath\files.wxs" -gg -srd -dr INSTALLFOLDER

# Step 3: Compile
Write-Host "Compiling WiX..." -ForegroundColor Green
& "$WiXPath\candle.exe" -o "$ProjectPath\obj\" -arch x64 "$ProjectPath\BeeTalk.wxs" "$ProjectPath\files.wxs"

# Step 4: Link
Write-Host "Linking to create MSI..." -ForegroundColor Green
& "$WiXPath\light.exe" -o "$ProjectPath\dist\BeeTalk-1.0.2.msi" -ext WixUIExtension -ext WixUtilExtension `
  "$ProjectPath\obj\BeeTalk.wixobj" "$ProjectPath\obj\files.wixobj"

Write-Host "MSI created: $ProjectPath\dist\BeeTalk-1.0.2.msi" -ForegroundColor Green
```

Run with: `powershell -ExecutionPolicy Bypass -File build-msi.ps1`

## Notes

- Update version numbers in `BeeTalk.wxs` and commands when releasing new versions
- The UpgradeCode GUID must remain constant for auto-updates to work properly
- The CloseApplication util will prompt users if BeeTalk is running during install
- For uninstall, it will also close BeeTalk if running
