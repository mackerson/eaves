import { useEffect, useRef } from 'react';
import { EnclaveGlyph } from '@/components/ui/EnclaveGlyph';
import './VaporwaveShader.css';

export function VaporwaveShader() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const timeRef = useRef(0);
  const animationRef = useRef<number>();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext('webgl');
    if (!gl) {
      console.error('WebGL not supported');
      return;
    }

    // Vertex shader
    const vertexShaderSource = `
      attribute vec2 position;
      void main() {
        gl_Position = vec4(position, 0.0, 1.0);
      }
    `;

    // Fragment shader with vaporwave aesthetic
    const fragmentShaderSource = `
      precision mediump float;
      uniform vec2 resolution;
      uniform float time;

      vec3 perspectiveGrid(vec2 uv, float t) {
        // Set horizon line (where logo will sit)
        float horizon = 0.0;

        // Background gradient (sky)
        vec3 skyTop = vec3(0.1, 0.0, 0.2);      // Deep purple
        vec3 skyHorizon = vec3(1.0, 0.3, 0.7);  // Hot pink
        vec3 groundColor = vec3(0.15, 0.0, 0.25); // Dark purple ground

        // Sky gradient
        float skyGradient = smoothstep(-1.0, horizon, uv.y);
        vec3 col = mix(skyTop, skyHorizon, 1.0 - skyGradient);

        // Below horizon - draw perspective grid
        if (uv.y < horizon) {
          // Perspective transformation
          float depth = 1.0 / (horizon - uv.y + 0.1);
          depth = clamp(depth, 0.0, 20.0);

          // Grid coordinates with perspective
          vec2 grid_uv = vec2(uv.x * depth, (horizon - uv.y) * depth + t * 0.3);

          // Grid lines
          float gridSize = 0.5;
          float lineWidth = 0.03 * depth;

          // Vertical lines (going to horizon)
          float gridX = mod(grid_uv.x, gridSize);
          float lineX = smoothstep(lineWidth, 0.0, abs(gridX - gridSize * 0.5));

          // Horizontal lines (going across)
          float gridY = mod(grid_uv.y, gridSize);
          float lineY = smoothstep(lineWidth, 0.0, abs(gridY - gridSize * 0.5));

          float gridLines = max(lineX, lineY);

          // Vaporwave grid colors
          vec3 gridColor = vec3(1.0, 0.3, 0.7) * 0.8; // Hot pink
          vec3 gridGlow = vec3(0.0, 0.8, 1.0) * 0.3;  // Cyan glow

          // Fade grid with distance
          float fade = 1.0 - smoothstep(0.0, 10.0, depth);
          gridLines *= fade;

          // Mix ground color with grid
          col = mix(groundColor, gridColor + gridGlow, gridLines);

          // Add some atmospheric fog
          float fog = 1.0 - smoothstep(0.0, 8.0, depth);
          col = mix(skyHorizon * 0.5, col, fog);
        } else {
          // Above horizon - add some stars/shimmer
          float stars = 0.0;
          float starField = sin(uv.x * 50.0 + t * 0.1) * sin(uv.y * 50.0 - t * 0.15);
          if (starField > 0.98) {
            stars = (starField - 0.98) * 50.0;
          }
          col += vec3(stars) * vec3(0.0, 0.8, 1.0); // Cyan stars
        }

        // Add sun glow at horizon
        float sunGlow = 1.0 / (abs(uv.y - horizon) * 5.0 + 1.0);
        sunGlow *= 1.0 / (abs(uv.x) * 2.0 + 1.0);
        vec3 glowColor = mix(vec3(1.0, 0.3, 0.7), vec3(1.0, 0.5, 0.0), 0.5);
        col += glowColor * sunGlow * 0.3;

        return col;
      }

      void main() {
        vec2 uv = gl_FragCoord.xy / resolution.xy;
        uv = uv * 2.0 - 1.0;
        uv.x *= resolution.x / resolution.y;

        vec3 col = perspectiveGrid(uv, time);

        gl_FragColor = vec4(col, 1.0);
      }
    `;

    // Create shaders
    const vertexShader = gl.createShader(gl.VERTEX_SHADER)!;
    gl.shaderSource(vertexShader, vertexShaderSource);
    gl.compileShader(vertexShader);

    const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(fragmentShader, fragmentShaderSource);
    gl.compileShader(fragmentShader);

    // Check for shader compilation errors
    if (!gl.getShaderParameter(fragmentShader, gl.COMPILE_STATUS)) {
      console.error('Fragment shader error:', gl.getShaderInfoLog(fragmentShader));
      return;
    }

    // Create program
    const program = gl.createProgram()!;
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    gl.useProgram(program);

    // Set up geometry
    const vertices = new Float32Array([
      -1, -1,
       1, -1,
      -1,  1,
       1,  1,
    ]);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    const position = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    // Get uniform locations
    const resolutionLocation = gl.getUniformLocation(program, 'resolution');
    const timeLocation = gl.getUniformLocation(program, 'time');

    // Animation loop
    const animate = () => {
      timeRef.current += 0.016; // ~60fps

      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(resolutionLocation, canvas.width, canvas.height);
      gl.uniform1f(timeLocation, timeRef.current);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      animationRef.current = requestAnimationFrame(animate);
    };

    animate();

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, []);

  return (
    <div className="vaporwave-visualization">
      <canvas
        ref={canvasRef}
        width={800}
        height={180}
        className="vaporwave-canvas"
      />
      <div className="logo-overlay">
        <div className="logo-glow" />
        <EnclaveGlyph className="enclave-logo" />
      </div>
    </div>
  );
}
