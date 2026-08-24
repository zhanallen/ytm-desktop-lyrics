# Live Executable Launch & Screenshot Verification Script
Stop-Process -Name "ytm-desktop-lyrics" -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

if (!(Test-Path -Path "outputs")) {
    New-Item -ItemType Directory -Path "outputs" | Out-Null
}

$exePath = ".\src-tauri\target\debug\ytm-desktop-lyrics.exe"
Write-Host "Launching $exePath ..."
$proc = Start-Process -FilePath $exePath -PassThru
Write-Host "Process started with PID $($proc.Id). Waiting 3 seconds for window to initialize..."
Start-Sleep -Seconds 3

$win32 = @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public class DesktopCapture {
    [DllImport("user32.dll")]
    public static extern IntPtr GetDC(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

    [DllImport("gdi32.dll")]
    public static extern IntPtr CreateCompatibleDC(IntPtr hDC);

    [DllImport("gdi32.dll")]
    public static extern IntPtr CreateCompatibleBitmap(IntPtr hDC, int nWidth, int nHeight);

    [DllImport("gdi32.dll")]
    public static extern IntPtr SelectObject(IntPtr hDC, IntPtr hObject);

    [DllImport("gdi32.dll")]
    public static extern bool BitBlt(IntPtr hObject, int nXDest, int nYDest, int nWidth, int nHeight, IntPtr hObjectSource, int nXSrc, int nYSrc, int dwRop);

    [DllImport("gdi32.dll")]
    public static extern bool DeleteDC(IntPtr hDC);

    [DllImport("gdi32.dll")]
    public static extern bool DeleteObject(IntPtr hObject);

    const int SRCCOPY = 0x00CC0020;

    public static Bitmap CaptureScreen(int x, int y, int width, int height) {
        IntPtr hSrcDC = GetDC(IntPtr.Zero);
        IntPtr hDestDC = CreateCompatibleDC(hSrcDC);
        IntPtr hBmp = CreateCompatibleBitmap(hSrcDC, width, height);
        IntPtr hOldBmp = SelectObject(hDestDC, hBmp);

        BitBlt(hDestDC, 0, 0, width, height, hSrcDC, x, y, SRCCOPY);

        SelectObject(hDestDC, hOldBmp);
        DeleteDC(hDestDC);
        ReleaseDC(IntPtr.Zero, hSrcDC);

        Bitmap bmp = Image.FromHbitmap(hBmp);
        DeleteObject(hBmp);
        return bmp;
    }
}
"@

Add-Type -TypeDefinition $win32 -ReferencedAssemblies System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$screen = [System.Windows.Forms.Screen]::PrimaryScreen
$rect = $screen.Bounds
Write-Host "Capturing desktop bounds: $($rect.Width) x $($rect.Height)..."

$outputPath = Join-Path (Get-Location) "outputs\ytm_app_screenshot.png"

# Try CopyFromScreen, fallback to Win32 screen capture if needed
try {
    $bmp = New-Object System.Drawing.Bitmap $rect.Width, $rect.Height
    $gfx = [System.Drawing.Graphics]::FromImage($bmp)
    $gfx.CopyFromScreen($rect.Location, [System.Drawing.Point]::Empty, $rect.Size)
    $bmp.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $gfx.Dispose()
    $bmp.Dispose()
} catch {
    $bmp = [DesktopCapture]::CaptureScreen($rect.X, $rect.Y, $rect.Width, $rect.Height)
    $bmp.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}

$fileInfo = Get-Item $outputPath
Write-Host "Screenshot captured: $outputPath (Size: $($fileInfo.Length) bytes)"
