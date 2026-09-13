import { Filter, GlProgram } from 'pixi.js';

export function comboEffectStrength(combo, config) {
  let effectStrength = 0;
  for (let threshold = config.startCombo; combo >= threshold; threshold *= 2) {
    effectStrength += Math.min(combo - threshold, threshold) * config.bandGain / threshold;
  }
  return effectStrength;
}

// One WebGL pass. White stays white; high combos separate colour edges without flashes.
export function createComboFilter() {
  const filter = new Filter({
    glProgram: GlProgram.from({ name: 'combo-spectrum', vertex: `
      precision highp float;
      in vec2 aPosition;
      out vec2 vTextureCoord;
      uniform vec4 uInputSize;
      uniform vec4 uOutputFrame;
      uniform vec4 uOutputTexture;
      void main() {
        vec2 p = aPosition * uOutputFrame.zw + uOutputFrame.xy;
        p.x = p.x * (2.0 / uOutputTexture.x) - 1.0;
        p.y = p.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
        gl_Position = vec4(p, 0.0, 1.0);
        vTextureCoord = aPosition * uOutputFrame.zw * uInputSize.zw;
      }`, fragment: `
      precision highp float;
      in vec2 vTextureCoord;
      out vec4 finalColor;
      uniform sampler2D uTexture;
      uniform vec4 uInputSize;
      uniform vec4 uInputClamp;
      uniform float uShift;
      uniform float uHue;
      uniform float uAngle;
      void main() {
        vec2 offset = vec2(cos(uAngle), sin(uAngle)) * uShift * uInputSize.zw;
        vec4 c = texture(uTexture, vTextureCoord);
        vec4 r = texture(uTexture, clamp(vTextureCoord + offset, uInputClamp.xy, uInputClamp.zw));
        vec4 b = texture(uTexture, clamp(vTextureCoord - offset, uInputClamp.xy, uInputClamp.zw));
        float alpha = max(c.a, max(r.a, b.a));
        // Apply hue to the chromatically separated result, above the dispersion pass.
        vec3 rgb = vec3(r.r, c.g, b.b);
        vec3 neutral = normalize(vec3(1.0));
        rgb = rgb * cos(uHue) + cross(neutral, rgb) * sin(uHue)
            + neutral * dot(neutral, rgb) * (1.0 - cos(uHue));
        finalColor = vec4(clamp(rgb, vec3(0.0), vec3(alpha)), alpha);
      }` }),
    resources: { spectrum: { uShift: { value: 0, type: 'f32' }, uHue: { value: 0, type: 'f32' }, uAngle: { value: Math.PI / 4, type: 'f32' } } },
    padding: 4, resolution: 'inherit', antialias: true
  });
  filter.enabled = false;
  return filter;
}
