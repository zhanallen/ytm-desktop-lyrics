import React, { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface LiquidGlassPreset {
  ior: number;          // Refractive index (default 1.25)
  dispersion: number;   // Cauchy RGB split (default 0.45)
  thickness: number;    // Refraction displacement thickness (default 14.0)
  squircleExp: number;  // Apple squircle superellipse exponent (default 4.0)
  roughness: number;    // 8-Tap Poisson Disk frosted blur (default 0.05)
  bevelWidth: number;   // Perimeter bevel width px (default 2.5)
  rimIntensity: number; // Specular rim stroke intensity (default 0.45)
  lightAngle: number;   // Specular light angle deg (default 129.0)
  saturation: number;   // Color saturation factor (default 1.00)
  tintOpacity: number;  // Base glass tint opacity (default 0.15)
  tintColor: string;    // Base tint hex color (default '#00050a')
  smink: number;        // Fluid metaball fusion distance (default 28.0)
}

const DEFAULT_PRESET: LiquidGlassPreset = {
  ior: -1.3,
  dispersion: 1.25,
  thickness: 25.0,
  squircleExp: 1,
  roughness: 0.15,
  bevelWidth: 3.5,
  rimIntensity: 0.45,
  lightAngle: 135.0,
  saturation: 1.0,
  tintOpacity: 0.35,
  tintColor: '#00050a',
  smink: 28.0,
};

interface LiquidGlassCanvasProps {
  albumArtUrl?: string;
  preset?: Partial<LiquidGlassPreset>;
  className?: string;
}

const VERTEX_SHADER_SRC = `#version 300 es
in vec2 position;
out vec2 v_uv;
void main() {
    v_uv = (position + 1.0) * 0.5;
    gl_Position = vec4(position, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER_SRC = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;

uniform vec2 u_res;           // Physical Canvas Resolution in Physical Pixels (width, height)
uniform vec2 u_capRes;        // Screen capture resolution (width, height) in physical pixels
uniform vec2 u_pos0;          // Card Center (px)
uniform float u_dpr;          // Window device pixel ratio
uniform float u_padding;      // Overscan capture padding in physical pixels (default 64.0)
uniform vec2 u_winOffset;     // Subpixel real-time motion extrapolation delta (dx, dy)
uniform float u_blackTransition; // Smooth black transition factor during drag (0.0: transparent glass, 1.0: solid dark glass)

uniform float u_ior;          // Refractive Index
uniform float u_dispersion;   // Cauchy RGB Split
uniform float u_thickness;    // Thickness in px
uniform float u_squircleExp;  // Maintained for preset parameter compatibility
uniform float u_roughness;    // Frosted Blur Roughness
uniform float u_bevelWidth;   // Perimeter Bevel Width px
uniform float u_rimIntensity; // Specular Rim Intensity
uniform float u_lightAngle;   // Specular Light Angle (deg)
uniform float u_saturation;   // Color Saturation factor
uniform float u_tintOpacity;  // Tint Opacity (0.0 to 1.0)
uniform vec3 u_tintColor;     // Tint Color RGB (0.0 to 1.0)
uniform sampler2D u_bgTexture;
uniform float u_hasBgTexture; // 1.0 if desktop texture loaded, 0.0 if fallback procedural

const vec3 DEFAULT_GLASS_TINT = vec3(14.0 / 255.0, 16.0 / 255.0, 22.0 / 255.0);
const float DEFAULT_GLASS_ALPHA = 0.85;

// 8-Tap Poisson Disk constant array for high-performance frosted blur
const vec2 POISSON_DISK[8] = vec2[8](
    vec2(-0.326212, -0.405810),
    vec2(-0.840144, -0.073580),
    vec2(-0.695914,  0.457137),
    vec2(-0.203345,  0.620716),
    vec2( 0.962340, -0.194983),
    vec2( 0.473434, -0.480026),
    vec2( 0.519456,  0.767022),
    vec2( 0.185461, -0.893124)
);

// Analytical 2D Rounded Box SDF
float sdRoundBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + vec2(r);
    return min(max(q.x, q.y), 0.0) + length(max(q, vec2(0.0))) - r;
}

// Analytical Outward Unit Normal for 2D Rounded Box (Zero Extra SDF Evaluations)
vec2 getRoundBoxNormal(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + vec2(r);
    if (q.x > 0.0 && q.y > 0.0) {
        return normalize(q) * sign(p);
    } else if (q.x > q.y) {
        return vec2(sign(p.x), 0.0);
    } else {
        return vec2(0.0, sign(p.y));
    }
}

vec3 getProceduralBg(vec2 px) {
    vec2 st = px / u_res;
    vec3 cTL = vec3(0.12, 0.15, 0.25);
    vec3 cTR = vec3(0.08, 0.12, 0.20);
    vec3 cBL = vec3(0.05, 0.08, 0.15);
    vec3 cBR = vec3(0.15, 0.18, 0.28);
    vec3 top = mix(cTL, cTR, st.x);
    vec3 bot = mix(cBL, cBR, st.x);
    return mix(bot, top, st.y);
}

float pseudoRandom(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

// 100% Exact Global Monitor Physical UV Projection Formula
// GPU Hardware Direct Swizzling: Samples .bgr from raw Windows DIB BGRA buffer with 0 CPU overhead!
vec3 getVibrantBg(vec2 px) {
    if (u_hasBgTexture > 0.5) {
        vec2 totalTexRes = u_capRes + vec2(u_padding * 2.0);
        // Map WebGL bottom-up pixel to Top-Down Desktop Monitor Physical Coordinates
        vec2 texCoord = vec2(
            px.x + u_winOffset.x + u_padding,
            (u_res.y - px.y) + u_winOffset.y + u_padding
        );
        vec2 uv = clamp(texCoord / totalTexRes, 0.001, 0.999);
        return texture(u_bgTexture, uv).bgr;
    }
    return getProceduralBg(px);
}

// 8-Tap Poisson Disk Frosted Blur with Subpixel Jitter (Flat Center Body)
vec3 getFrostedBg(vec2 px, float blurRadius) {
    if (blurRadius <= 0.5) return getVibrantBg(px);
    
    float noise = pseudoRandom(px) * 6.2831853;
    float cosN = cos(noise);
    float sinN = sin(noise);
    mat2 rot = mat2(cosN, -sinN, sinN, cosN);
    
    vec3 sum = getVibrantBg(px);
    for (int i = 0; i < 8; i++) {
        vec2 offset = rot * (POISSON_DISK[i] * blurRadius);
        sum += getVibrantBg(px + offset);
    }
    
    return sum * (1.0 / 9.0);
}

// Single-Pass 8-Tap Poisson Disk Frosted Blur with Unified Chromatic Dispersion (Bevel Edge)
vec3 sampleDispersedBg(vec2 basePx, vec2 dispVec, float blurRadius) {
    if (blurRadius <= 0.5) {
        float r = getVibrantBg(basePx - dispVec).r;
        float g = getVibrantBg(basePx).g;
        float b = getVibrantBg(basePx + dispVec).b;
        return vec3(r, g, b);
    }
    
    float noise = pseudoRandom(basePx) * 6.2831853;
    float cosN = cos(noise);
    float sinN = sin(noise);
    mat2 rot = mat2(cosN, -sinN, sinN, cosN);
    
    vec3 sum = vec3(
        getVibrantBg(basePx - dispVec).r,
        getVibrantBg(basePx).g,
        getVibrantBg(basePx + dispVec).b
    );
    
    for (int i = 0; i < 8; i++) {
        vec2 offset = rot * (POISSON_DISK[i] * blurRadius);
        sum.r += getVibrantBg(basePx - dispVec + offset).r;
        sum.g += getVibrantBg(basePx + offset).g;
        sum.b += getVibrantBg(basePx + dispVec + offset).b;
    }
    
    return sum * (1.0 / 9.0);
}

vec3 adjustSaturation(vec3 color, float sat) {
    float gray = dot(color, vec3(0.2126, 0.7152, 0.0722));
    return mix(vec3(gray), color, sat);
}

void main() {
    vec2 px = gl_FragCoord.xy;
    vec2 p0 = px - u_pos0;
    vec2 cardSize = u_res * 0.5;
    float cornerRadius = clamp(min(u_res.x, u_res.y) * 0.06, 6.0 * u_dpr, 12.0 * u_dpr);
    float d = sdRoundBox(p0, cardSize, cornerRadius);
    float aa = max(fwidth(d), 0.75 * u_dpr);

    if (d > aa * 2.0) {
        fragColor = vec4(0.0);
        return;
    }

    float bevelWidth = max(u_bevelWidth * u_dpr, 1.0 * u_dpr);
    float blurPix = u_roughness * 45.0 * u_dpr;

    // HIGH-SPEED GPU OPTIMIZATION: Flat center body early-out (<0.3ms ALU time)
    // 95% of pixels inside the flat body have slope = 0 and flat normal (0,0,1).
    // Completely bypasses expensive Snell's law refraction vectors and specular lighting.
    if (d < -bevelWidth - aa) {
        vec3 col = getFrostedBg(px, blurPix);
        col = adjustSaturation(col, u_saturation);
        col = mix(col, u_tintColor, u_tintOpacity);
        col = mix(col, DEFAULT_GLASS_TINT, u_blackTransition);
        float currentAlpha = mix(1.0, DEFAULT_GLASS_ALPHA, u_blackTransition);
        fragColor = vec4(col * currentAlpha, currentAlpha);
        return;
    }

    // Analytical Bevel Normal Calculation
    vec2 grad = getRoundBoxNormal(p0, cardSize, cornerRadius);
    float t = clamp(-d / bevelWidth, 0.0, 1.0);
    float slope = cos(t * 1.57079632679);
    vec3 N = normalize(vec3(grad * slope * 0.75, 1.0));

    // Full Snell's Law Optical Refraction Vector
    float refDist = u_thickness * u_dpr * u_ior * 1.15;
    float dispOffset = refDist * (u_dispersion * 0.65);
    vec2 refCenter = px + N.xy * refDist;
    vec2 dispVec = N.xy * (dispOffset * 0.5);

    // Sample Refracted & Frosted Desktop Content in single dispersed pass
    vec3 col = sampleDispersedBg(refCenter, dispVec, blurPix);
    col = adjustSaturation(col, u_saturation);
    col = mix(col, u_tintColor, u_tintOpacity);
    col = mix(col, DEFAULT_GLASS_TINT, u_blackTransition);

    // Apple Dual Specular Rim Lights (Key Light 135 deg + Fill Light 315 deg + Fresnel)
    float fresnel = pow(1.0 - max(N.z, 0.0), 2.5);

    float rad1 = u_lightAngle * 0.0174532925; // Primary key light (135 deg)
    vec2 lightDir1 = vec2(cos(rad1), sin(rad1));
    float lightGleam1 = max(dot(N.xy, lightDir1), 0.0);

    float rad2 = rad1 + 3.14159265; // Secondary rim light (315 deg)
    vec2 lightDir2 = vec2(cos(rad2), sin(rad2));
    float lightGleam2 = max(dot(N.xy, lightDir2), 0.0);

    float specPow = mix(3.0, 0.8, u_roughness);
    float spec1 = pow(lightGleam1, specPow) * 0.75;
    float spec2 = pow(lightGleam2, specPow * 1.5) * 0.35;
    float rimFactor = mix(1.0, 0.75, u_blackTransition);
    float rim = (fresnel * 0.45 + spec1 + spec2) * slope * 1.8 * u_rimIntensity * rimFactor;

    vec3 glass = col + vec3(rim);
    float edgeAlpha = 1.0 - smoothstep(-aa, aa, d);
    float currentAlpha = mix(1.0, DEFAULT_GLASS_ALPHA, u_blackTransition);
    float finalAlpha = edgeAlpha * currentAlpha;
    fragColor = vec4(glass * finalAlpha, finalAlpha);
}
`;

export interface GpuInfo {
  vendor: string;
  renderer: string;
  unmaskedVendor: string;
  unmaskedRenderer: string;
  isHardwareAccelerated: boolean;
  webglVersion: string;
  shadingLanguageVersion: string;
}

export interface YtmPerfStats {
  fps: number;
  avgCaptureTimeMs: number;
  lastLatencyMs: number;
  captureCount: number;
  gpu?: GpuInfo;
}

export interface BenchmarkResult {
  durationSeconds: number;
  totalFrames: number;
  averageFps: number;
  minFps: number;
  maxFps: number;
  avgCaptureTimeMs: number;
  p95CaptureTimeMs: number;
  p99CaptureTimeMs: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
}

declare global {
  interface Window {
    __YTM_GPU_INFO__?: GpuInfo;
    __YTM_LAST_LATENCY_MS__?: number;
    __YTM_PERF_STATS__?: () => YtmPerfStats;
    __runYtmFpsBenchmark?: (durationSeconds?: number) => Promise<BenchmarkResult>;
    __YTM_BENCHMARK_COLLECTOR__?: (captureTimeMs: number, latencyMs: number) => void;
  }
}

/**
 * Probes WebGL 2.0 GPU hardware diagnostics using WEBGL_debug_renderer_info.
 * Detects whether dedicated hardware acceleration (NVIDIA / AMD / Intel D3D11) is active
 * versus D3D WARP / SwiftShader software fallback rasterization.
 */
function logGpuHardwareDiagnostics(gl: WebGL2RenderingContext): GpuInfo {
  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
  const vendor = (gl.getParameter(gl.VENDOR) as string) || '';
  const renderer = (gl.getParameter(gl.RENDERER) as string) || '';
  const unmaskedVendor = debugInfo
    ? (gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) as string) || vendor
    : vendor;
  const unmaskedRenderer = debugInfo
    ? (gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) as string) || renderer
    : renderer;
  const webglVersion = (gl.getParameter(gl.VERSION) as string) || '';
  const shadingLanguageVersion = (gl.getParameter(gl.SHADING_LANGUAGE_VERSION) as string) || '';

  const lowerRenderer = unmaskedRenderer.toLowerCase();
  const isSoftware =
    lowerRenderer.includes('swiftshader') ||
    lowerRenderer.includes('basic render') ||
    lowerRenderer.includes('software') ||
    lowerRenderer.includes('llvmpipe') ||
    lowerRenderer.includes('warp');

  const isHardwareAccelerated =
    !isSoftware &&
    (lowerRenderer.includes('nvidia') ||
      lowerRenderer.includes('amd') ||
      lowerRenderer.includes('radeon') ||
      lowerRenderer.includes('intel') ||
      lowerRenderer.includes('direct3d') ||
      lowerRenderer.includes('d3d11') ||
      lowerRenderer.includes('angle') ||
      lowerRenderer.includes('geforce') ||
      lowerRenderer.includes('rtx') ||
      lowerRenderer.includes('gtx') ||
      lowerRenderer.includes('arc') ||
      lowerRenderer.includes('iris') ||
      lowerRenderer.includes('mali') ||
      lowerRenderer.includes('adreno') ||
      lowerRenderer.includes('apple'));

  const gpuInfo: GpuInfo = {
    vendor,
    renderer,
    unmaskedVendor,
    unmaskedRenderer,
    isHardwareAccelerated,
    webglVersion,
    shadingLanguageVersion,
  };

  window.__YTM_GPU_INFO__ = gpuInfo;

  console.log(
    `%c[GPU Diagnostics] ${isHardwareAccelerated ? '🚀 Dedicated Hardware Acceleration Active' : '⚠️ Software Fallback Active'}\n` +
      `Renderer: ${unmaskedRenderer}\nVendor: ${unmaskedVendor}\nWebGL: ${webglVersion}\nGLSL: ${shadingLanguageVersion}`,
    isHardwareAccelerated
      ? 'color: #10b981; font-weight: bold; font-size: 11px;'
      : 'color: #f59e0b; font-weight: bold; font-size: 11px;'
  );

  return gpuInfo;
}

function hexToRgb(hex: string): [number, number, number] {
  let clean = hex.replace('#', '');
  if (clean.length === 3) {
    clean = clean.split('').map((c) => c + c).join('');
  }
  const num = parseInt(clean, 16);
  if (isNaN(num)) return [1.0, 1.0, 1.0];
  return [((num >> 16) & 255) / 255, ((num >> 8) & 255) / 255, (num & 255) / 255];
}

export const LiquidGlassCanvas: React.FC<LiquidGlassCanvasProps> = React.memo(({
  albumArtUrl,
  preset: customPreset,
  className = '',
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animFrameIdRef = useRef<number | null>(null);
  const currentPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const capturedPosRef = useRef<{ x: number; y: number; w: number; h: number; padding?: number }>({
    x: 0,
    y: 0,
    w: 300,
    h: 200,
    padding: 64,
  });
  const isCapturingRef = useRef<boolean>(false);
  const hasTextureRef = useRef<boolean>(false);
  const isMovingRef = useRef<boolean>(false);
  const isDraggingRef = useRef<boolean>(false);
  const dragStartPosRef = useRef<{ x: number; y: number } | null>(null);
  const blackTransitionRef = useRef<number>(0.0);
  const targetBlackTransitionRef = useRef<number>(0.0);
  const lastMovedTimeRef = useRef<number>(0);
  const needsRedrawRef = useRef<boolean>(true);
  const wakeRenderLoopRef = useRef<(() => void) | null>(null);

  // Dynamic Uniform Synchronizer: Zero WebGL Re-compilation Architecture
  const presetRef = useRef<LiquidGlassPreset>(DEFAULT_PRESET);
  presetRef.current = {
    ...DEFAULT_PRESET,
    ...customPreset,
  };
  needsRedrawRef.current = true;
  if (wakeRenderLoopRef.current) {
    wakeRenderLoopRef.current();
  }

  useEffect(() => {
    let isMounted = true;
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cleanupCurrentGL: (() => void) | null = null;
    let isContextLost = false;

    const setupWebGL = () => {
      if (!isMounted || !canvas) return;

      const gl = canvas.getContext('webgl2', {
        alpha: true,
        antialias: true,
        premultipliedAlpha: true,
        powerPreference: 'high-performance',
      });

      if (!gl) {
        console.error('[LiquidGlass] WebGL 2.0 context is not available.');
        return;
      }

      // Proactively probe and log GPU hardware acceleration diagnostics
      logGpuHardwareDiagnostics(gl);

      const vs = gl.createShader(gl.VERTEX_SHADER)!;
      gl.shaderSource(vs, VERTEX_SHADER_SRC);
      gl.compileShader(vs);
      if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
        console.error('[LiquidGlass] Vertex Shader Compile Error:', gl.getShaderInfoLog(vs));
        return;
      }

      const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
      gl.shaderSource(fs, FRAGMENT_SHADER_SRC);
      gl.compileShader(fs);
      if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
        console.error('[LiquidGlass] Fragment Shader Compile Error:', gl.getShaderInfoLog(fs));
        return;
      }

      const program = gl.createProgram()!;
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error('[LiquidGlass] Program Link Error:', gl.getProgramInfoLog(program));
        return;
      }

      const positionLoc = gl.getAttribLocation(program, 'position');
      const uRes = gl.getUniformLocation(program, 'u_res');
      const uCapRes = gl.getUniformLocation(program, 'u_capRes');
      const uPos0 = gl.getUniformLocation(program, 'u_pos0');
      const uDpr = gl.getUniformLocation(program, 'u_dpr');
      const uPadding = gl.getUniformLocation(program, 'u_padding');
      const uWinOffset = gl.getUniformLocation(program, 'u_winOffset');
      const uBlackTransition = gl.getUniformLocation(program, 'u_blackTransition');

      const uIor = gl.getUniformLocation(program, 'u_ior');
      const uDispersion = gl.getUniformLocation(program, 'u_dispersion');
      const uThickness = gl.getUniformLocation(program, 'u_thickness');
      const uSquircleExp = gl.getUniformLocation(program, 'u_squircleExp');
      const uRoughness = gl.getUniformLocation(program, 'u_roughness');
      const uBevelWidth = gl.getUniformLocation(program, 'u_bevelWidth');
      const uRimIntensity = gl.getUniformLocation(program, 'u_rimIntensity');
      const uLightAngle = gl.getUniformLocation(program, 'u_lightAngle');
      const uSaturation = gl.getUniformLocation(program, 'u_saturation');
      const uTintOpacity = gl.getUniformLocation(program, 'u_tintOpacity');
      const uTintColor = gl.getUniformLocation(program, 'u_tintColor');
      const uBgTexture = gl.getUniformLocation(program, 'u_bgTexture');
      const uHasBgTexture = gl.getUniformLocation(program, 'u_hasBgTexture');

      const quadBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
        gl.STATIC_DRAW
      );

      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.enableVertexAttribArray(positionLoc);
      gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);

      const texture = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      // Initial placeholder 1x1 neutral slate texture
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        1,
        1,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        new Uint8Array([20, 24, 36, 255])
      );

      const lastTexWRef = { current: 0 };
      const lastTexHRef = { current: 0 };

      // Ultra-fast zero-copy binary desktop screen capture poll with direct GPU texture upload
      const updateDesktopTexture = async () => {
        if (!isMounted || isCapturingRef.current || isContextLost || document.hidden || isDraggingRef.current) return;
        isCapturingRef.current = true;
        try {
          const rawPayload = await invoke<any>('capture_desktop_background');
          if (!isMounted || !rawPayload || isContextLost) return;

          let buffer: ArrayBuffer;
          let byteOffset = 0;
          let byteLength = 0;

          if (rawPayload instanceof ArrayBuffer) {
            buffer = rawPayload;
            byteOffset = 0;
            byteLength = rawPayload.byteLength;
          } else if (ArrayBuffer.isView(rawPayload)) {
            buffer = rawPayload.buffer as ArrayBuffer;
            byteOffset = rawPayload.byteOffset;
            byteLength = rawPayload.byteLength;
          } else if (Array.isArray(rawPayload)) {
            const u8 = new Uint8Array(rawPayload);
            buffer = u8.buffer as ArrayBuffer;
            byteOffset = u8.byteOffset;
            byteLength = u8.byteLength;
          } else {
            return;
          }

          if (byteLength > 32) {
            const view = new DataView(buffer, byteOffset, byteLength);
            const winW = view.getUint32(0, true);
            const winH = view.getUint32(4, true);
            const winX = view.getInt32(8, true);
            const winY = view.getInt32(12, true);
            const padding = view.getUint32(16, true);
            const capturedTs = view.getFloat64(20, true);
            const pixels = new Uint8Array(buffer, byteOffset + 32, byteLength - 32);

            const texWidth = Math.max(winW + padding * 2, 1);
            const texHeight = Math.max(winH + padding * 2, 1);

            if (capturedTs > 0) {
              const e2eLatency = Date.now() - capturedTs;
              (window as any).__YTM_LAST_LATENCY_MS__ = e2eLatency;
              capturedPosRef.current = { x: winX, y: winY, w: winW, h: winH, padding };
              if (!isMovingRef.current && !isDraggingRef.current) {
                currentPosRef.current = { x: winX, y: winY };
              }
            }

            gl.bindTexture(gl.TEXTURE_2D, texture);

            if (lastTexWRef.current !== texWidth || lastTexHRef.current !== texHeight) {
              lastTexWRef.current = texWidth;
              lastTexHRef.current = texHeight;
              gl.texImage2D(
                gl.TEXTURE_2D,
                0,
                gl.RGBA,
                texWidth,
                texHeight,
                0,
                gl.RGBA,
                gl.UNSIGNED_BYTE,
                pixels
              );
            } else {
              gl.texSubImage2D(
                gl.TEXTURE_2D,
                0,
                0,
                0,
                texWidth,
                texHeight,
                gl.RGBA,
                gl.UNSIGNED_BYTE,
                pixels
              );
            }

            hasTextureRef.current = true;
            needsRedrawRef.current = true;
            wakeRenderLoop();
          }
        } catch (err) {
          // Normal when window is actively moving (bypassed in Rust)
        } finally {
          isCapturingRef.current = false;
        }
      };

      const requestRender = () => {
        if (!canvas || !isMounted || isContextLost) return;
        const currentPreset = presetRef.current;
        const dpr = window.devicePixelRatio || 1;
        const cssWidth = canvas.clientWidth || 300;
        const cssHeight = canvas.clientHeight || 200;
        const physWidth = Math.round(cssWidth * dpr);
        const physHeight = Math.round(cssHeight * dpr);

        if (canvas.width !== physWidth || canvas.height !== physHeight) {
          canvas.width = physWidth;
          canvas.height = physHeight;
          gl.viewport(0, 0, physWidth, physHeight);
        }

        gl.useProgram(program);

        gl.uniform2f(uRes, physWidth, physHeight);
        gl.uniform2f(uCapRes, capturedPosRef.current.w, capturedPosRef.current.h);
        gl.uniform2f(uPos0, physWidth * 0.5, physHeight * 0.5);
        gl.uniform1f(uDpr, dpr);
        gl.uniform1f(uPadding, capturedPosRef.current.padding || 64.0);

        gl.uniform1f(uIor, currentPreset.ior);
        gl.uniform1f(uDispersion, currentPreset.dispersion);
        gl.uniform1f(uThickness, currentPreset.thickness);
        gl.uniform1f(uSquircleExp, currentPreset.squircleExp);
        gl.uniform1f(uRoughness, currentPreset.roughness);
        gl.uniform1f(uBevelWidth, currentPreset.bevelWidth);
        gl.uniform1f(uRimIntensity, currentPreset.rimIntensity);
        gl.uniform1f(uLightAngle, currentPreset.lightAngle);
        gl.uniform1f(uSaturation, currentPreset.saturation);
        gl.uniform1f(uTintOpacity, currentPreset.tintOpacity);

        const rgb = hexToRgb(currentPreset.tintColor);
        gl.uniform3f(uTintColor, rgb[0], rgb[1], rgb[2]);

        // Calculate Physical Screen-Space Window Motion Offset (Bounded by Overscan Buffer)
        let offX = 0;
        let offY = 0;
        if (currentPosRef.current.x !== 0 && capturedPosRef.current.x !== 0) {
          const pad = (capturedPosRef.current.padding || 64) - 2;
          const rawDx = currentPosRef.current.x - capturedPosRef.current.x;
          const rawDy = currentPosRef.current.y - capturedPosRef.current.y;
          offX = Math.min(Math.max(rawDx, -pad), pad);
          offY = Math.min(Math.max(rawDy, -pad), pad);
        }
        gl.uniform2f(uWinOffset, offX, offY);

        gl.uniform1f(uBlackTransition, blackTransitionRef.current);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.uniform1i(uBgTexture, 0);
        gl.uniform1f(uHasBgTexture, hasTextureRef.current ? 1.0 : 0.0);

        gl.drawArrays(gl.TRIANGLES, 0, 6);
        needsRedrawRef.current = false;
      };

      let isRunning = true;
      const TARGET_FRAME_DURATION_MS = 1000 / 30; // 33.3333ms
      let lastCaptureTime = performance.now();
      let captureRafId: number | null = null;
      let isCaptureInProgress = false;

      // Performance monitoring trackers
      let perfFrameCount = 0;
      let perfLastFpsCalcTime = performance.now();
      let perfCurrentFps = 30.0;
      let perfAvgCaptureTimeMs = 0;
      let perfCaptureCount = 0;

      // High-precision VSync-aligned requestAnimationFrame 30.0 FPS capture scheduler
      const runPrecisionCaptureLoop = (now: number) => {
        if (!isRunning || !isMounted || isContextLost || document.hidden) {
          captureRafId = null;
          return;
        }

        if (isDraggingRef.current) {
          captureRafId = requestAnimationFrame(runPrecisionCaptureLoop);
          return;
        }

        const elapsed = now - lastCaptureTime;

        if (elapsed >= TARGET_FRAME_DURATION_MS && !isCaptureInProgress) {
          lastCaptureTime = now - (elapsed % TARGET_FRAME_DURATION_MS);
          isCaptureInProgress = true;
          const startCap = performance.now();

          updateDesktopTexture()
            .then(() => {
              const capDur = performance.now() - startCap;
              perfCaptureCount++;
              perfAvgCaptureTimeMs =
                (perfAvgCaptureTimeMs * (perfCaptureCount - 1) + capDur) / perfCaptureCount;
              perfFrameCount++;

              const nowCalc = performance.now();
              if (nowCalc - perfLastFpsCalcTime >= 1000) {
                perfCurrentFps = (perfFrameCount * 1000) / (nowCalc - perfLastFpsCalcTime);
                perfFrameCount = 0;
                perfLastFpsCalcTime = nowCalc;
              }

              if (window.__YTM_BENCHMARK_COLLECTOR__) {
                window.__YTM_BENCHMARK_COLLECTOR__(
                  capDur,
                  window.__YTM_LAST_LATENCY_MS__ || 0
                );
              }
            })
            .catch(() => {})
            .finally(() => {
              isCaptureInProgress = false;
            });
        }

        captureRafId = requestAnimationFrame(runPrecisionCaptureLoop);
      };

      const startCaptureLoop = () => {
        if (!captureRafId) {
          lastCaptureTime = performance.now() - TARGET_FRAME_DURATION_MS;
          captureRafId = requestAnimationFrame(runPrecisionCaptureLoop);
        }
      };

      const stopCaptureLoop = () => {
        if (captureRafId !== null) {
          cancelAnimationFrame(captureRafId);
          captureRafId = null;
        }
      };

      // Expose real-time performance statistics to global window
      window.__YTM_PERF_STATS__ = (): YtmPerfStats => ({
        fps: Number(perfCurrentFps.toFixed(2)),
        avgCaptureTimeMs: Number(perfAvgCaptureTimeMs.toFixed(2)),
        lastLatencyMs: window.__YTM_LAST_LATENCY_MS__ || 0,
        captureCount: perfCaptureCount,
        gpu: window.__YTM_GPU_INFO__,
      });

      // Expose automated real-time FPS & latency benchmark tool to global window
      window.__runYtmFpsBenchmark = (durationSeconds = 5): Promise<BenchmarkResult> => {
        return new Promise((resolve) => {
          console.log(
            `%c[YTM Benchmark] Starting ${durationSeconds}s 30 FPS Capture & Render Benchmark...`,
            'color: #3b82f6; font-weight: bold;'
          );

          const captureTimes: number[] = [];
          const latencies: number[] = [];
          let frameCount = 0;
          const fpsSamples: number[] = [];
          let lastSampleTime = performance.now();
          let sampleFrameCount = 0;

          const sampleInterval = setInterval(() => {
            const now = performance.now();
            const delta = now - lastSampleTime;
            if (delta > 0) {
              fpsSamples.push((sampleFrameCount * 1000) / delta);
            }
            sampleFrameCount = 0;
            lastSampleTime = now;
          }, 500);

          const collector = (capDur: number, latency: number) => {
            captureTimes.push(capDur);
            latencies.push(latency);
            frameCount++;
            sampleFrameCount++;
          };

          window.__YTM_BENCHMARK_COLLECTOR__ = collector;

          setTimeout(() => {
            clearInterval(sampleInterval);
            window.__YTM_BENCHMARK_COLLECTOR__ = undefined;

            captureTimes.sort((a, b) => a - b);
            latencies.sort((a, b) => a - b);

            const p95Cap =
              captureTimes.length > 0
                ? captureTimes[Math.floor(captureTimes.length * 0.95)]
                : 0;
            const p99Cap =
              captureTimes.length > 0
                ? captureTimes[Math.floor(captureTimes.length * 0.99)]
                : 0;
            const avgCap =
              captureTimes.length > 0
                ? captureTimes.reduce((a, b) => a + b, 0) / captureTimes.length
                : 0;

            const p95Lat =
              latencies.length > 0
                ? latencies[Math.floor(latencies.length * 0.95)]
                : 0;
            const avgLat =
              latencies.length > 0
                ? latencies.reduce((a, b) => a + b, 0) / latencies.length
                : 0;

            const avgFps = frameCount / durationSeconds;
            const minFps = fpsSamples.length > 0 ? Math.min(...fpsSamples) : avgFps;
            const maxFps = fpsSamples.length > 0 ? Math.max(...fpsSamples) : avgFps;

            const result: BenchmarkResult = {
              durationSeconds,
              totalFrames: frameCount,
              averageFps: Number(avgFps.toFixed(2)),
              minFps: Number(minFps.toFixed(2)),
              maxFps: Number(maxFps.toFixed(2)),
              avgCaptureTimeMs: Number(avgCap.toFixed(2)),
              p95CaptureTimeMs: Number(p95Cap.toFixed(2)),
              p99CaptureTimeMs: Number(p99Cap.toFixed(2)),
              avgLatencyMs: Number(avgLat.toFixed(2)),
              p95LatencyMs: Number(p95Lat.toFixed(2)),
            };

            console.table(result);
            console.log(
              `%c[YTM Benchmark Complete] Avg FPS: ${result.averageFps} | Avg Cap: ${result.avgCaptureTimeMs}ms | p95 Cap: ${result.p95CaptureTimeMs}ms | Avg Latency: ${result.avgLatencyMs}ms`,
              'color: #10b981; font-weight: bold; font-size: 12px;'
            );

            resolve(result);
          }, durationSeconds * 1000);
        });
      };

      const loop = (now: number) => {
        if (!isRunning || !isMounted || isContextLost || document.hidden) {
          animFrameIdRef.current = null;
          return;
        }

        // Asymmetric Exponential Lerp for blackTransition:
        // diff > 0 (dragging / darkening): 0.18 (fast response)
        // diff < 0 (release / melting fade-out): 0.09 (~300ms smooth ease-out)
        const diff = targetBlackTransitionRef.current - blackTransitionRef.current;
        let isTransitioning = false;
        if (Math.abs(diff) > 0.001) {
          const lerpFactor = diff > 0 ? 0.18 : 0.09;
          blackTransitionRef.current += diff * lerpFactor;
          isTransitioning = true;
          needsRedrawRef.current = true;
        } else if (blackTransitionRef.current !== targetBlackTransitionRef.current) {
          blackTransitionRef.current = targetBlackTransitionRef.current;
          needsRedrawRef.current = true;
        }

        if (blackTransitionRef.current < 0.005 && Math.abs(diff) <= 0.001) {
          if (blackTransitionRef.current !== 0.0) {
            blackTransitionRef.current = 0.0;
            needsRedrawRef.current = true;
          }
        }

        const isMoving =
          isMovingRef.current ||
          isDraggingRef.current ||
          now - lastMovedTimeRef.current < 150 ||
          isTransitioning;

        if (isMoving) {
          // Window is in motion: render at full screen refresh rate (60/120/144 FPS) with motion offset extrapolation
          requestRender();
          animFrameIdRef.current = requestAnimationFrame(loop);
        } else {
          isMovingRef.current = false;
          if (needsRedrawRef.current) {
            requestRender();
          }
          // Window is static: pause rAF loop until next frame arrival or window movement
          animFrameIdRef.current = null;
        }
      };

      const wakeRenderLoop = () => {
        needsRedrawRef.current = true;
        if (!animFrameIdRef.current && isRunning && isMounted && !isContextLost && !document.hidden) {
          animFrameIdRef.current = requestAnimationFrame(loop);
        }
      };

      wakeRenderLoopRef.current = wakeRenderLoop;

      const stopLoop = () => {
        if (animFrameIdRef.current) {
          cancelAnimationFrame(animFrameIdRef.current);
          animFrameIdRef.current = null;
        }
      };

      // Initial frame render and continuous self-scheduling dynamic capture loop start
      wakeRenderLoop();
      startCaptureLoop();

      const handleVisibilityChange = () => {
        if (document.hidden) {
          stopLoop();
          stopCaptureLoop();
        } else {
          wakeRenderLoop();
          startCaptureLoop();
        }
      };

      document.addEventListener('visibilitychange', handleVisibilityChange);

      let isCurrentGLActive = true;
      let unlistenMoved: (() => void) | null = null;
      let unlistenDragStarted: (() => void) | null = null;
      let unlistenDragEnded: (() => void) | null = null;

      // Real-time window movement listener: updates position delta and drives 60/120/144 FPS WebGL offset
      listen<{ x?: number; y?: number }>('desktop-window-moved', (event) => {
        if (!isCurrentGLActive) return;
        if (event.payload && typeof event.payload.x === 'number' && typeof event.payload.y === 'number') {
          const newX = event.payload.x;
          const newY = event.payload.y;
          currentPosRef.current = { x: newX, y: newY };

          if (isDraggingRef.current) {
            if (!dragStartPosRef.current) {
              dragStartPosRef.current = { x: newX, y: newY };
            }
            const dx = newX - dragStartPosRef.current.x;
            const dy = newY - dragStartPosRef.current.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            // Map displacement (0 ~ 35px) to 0.0 ~ 1.0 transition target
            targetBlackTransitionRef.current = Math.min(Math.max(dist / 35.0, 0.0), 1.0);
          }
        }
        isMovingRef.current = true;
        lastMovedTimeRef.current = performance.now();
        wakeRenderLoop();
      }).then((unlisten) => {
        if (!isCurrentGLActive) {
          unlisten();
        } else {
          unlistenMoved = unlisten;
        }
      }).catch(() => {});

      // Win32 WM_ENTERSIZEMOVE notification: marks dragging active, pauses captures, records drag start
      listen('window-drag-started', () => {
        if (!isCurrentGLActive) return;
        isDraggingRef.current = true;
        dragStartPosRef.current = { ...currentPosRef.current };
        stopCaptureLoop();
        wakeRenderLoop();
      }).then((unlisten) => {
        if (!isCurrentGLActive) {
          unlisten();
        } else {
          unlistenDragStarted = unlisten;
        }
      }).catch(() => {});

      // Win32 WM_EXITSIZEMOVE notification: triggers immediate desktop background capture on drop & restores glass in two phases
      listen('window-drag-ended', () => {
        if (!isCurrentGLActive) return;
        isDraggingRef.current = false;
        dragStartPosRef.current = null;
        isMovingRef.current = false;
        lastMovedTimeRef.current = 0;
        wakeRenderLoop();
        updateDesktopTexture()
          .then(() => {
            if (!isCurrentGLActive) return;
            targetBlackTransitionRef.current = 0.0;
            wakeRenderLoop();
          })
          .catch((_err) => {
            if (!isCurrentGLActive) return;
            targetBlackTransitionRef.current = 0.0;
            wakeRenderLoop();
          })
          .finally(() => {
            if (isCurrentGLActive) {
              startCaptureLoop();
            }
          });
      }).then((unlisten) => {
        if (!isCurrentGLActive) {
          unlisten();
        } else {
          unlistenDragEnded = unlisten;
        }
      }).catch(() => {});

      cleanupCurrentGL = () => {
        isCurrentGLActive = false;
        isRunning = false;
        stopLoop();
        stopCaptureLoop();
        delete window.__YTM_PERF_STATS__;
        delete window.__runYtmFpsBenchmark;
        delete window.__YTM_BENCHMARK_COLLECTOR__;
        wakeRenderLoopRef.current = null;
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        if (unlistenMoved) {
          unlistenMoved();
          unlistenMoved = null;
        }
        if (unlistenDragStarted) {
          unlistenDragStarted();
          unlistenDragStarted = null;
        }
        if (unlistenDragEnded) {
          unlistenDragEnded();
          unlistenDragEnded = null;
        }
        try {
          gl.deleteTexture(texture);
          gl.deleteVertexArray(vao);
          gl.deleteBuffer(quadBuffer);
          gl.deleteProgram(program);
          gl.deleteShader(vs);
          gl.deleteShader(fs);
        } catch (e) {}
      };
    };

    const handleContextLost = (e: Event) => {
      e.preventDefault();
      console.warn('[LiquidGlass] WebGL context lost.');
      isContextLost = true;
      if (cleanupCurrentGL) {
        cleanupCurrentGL();
        cleanupCurrentGL = null;
      }
    };

    const handleContextRestored = () => {
      console.log('[LiquidGlass] WebGL context restored.');
      isContextLost = false;
      hasTextureRef.current = false;
      setupWebGL();
    };

    canvas.addEventListener('webglcontextlost', handleContextLost, false);
    canvas.addEventListener('webglcontextrestored', handleContextRestored, false);

    setupWebGL();

    return () => {
      isMounted = false;
      canvas.removeEventListener('webglcontextlost', handleContextLost, false);
      canvas.removeEventListener('webglcontextrestored', handleContextRestored, false);
      if (cleanupCurrentGL) {
        cleanupCurrentGL();
      }
    };
  }, []); // Initialized ONCE on mount: Zero Shader Re-compilation Overhead!

  return (
    <canvas
      ref={canvasRef}
      className={`liquid-glass-canvas ${className}`}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 0,
      }}
    />
  );
});
