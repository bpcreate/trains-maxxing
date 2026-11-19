// Effect catalogue, shared by the phone UI (pads) and the stage (shader uniforms).
// Every effect has an on/off pad, an "amt" (X on the XY pad) and a second parameter "y".

export const FX = [
  { id: 'slit',    name: 'Train Pano', icon: '🚂', x: 'Scan speed', y: 'Slit position', amt: 0.4, yv: 0.5 },
  { id: 'trails',  name: 'Trails',     icon: '💨', x: 'Length',     y: 'Drift',         amt: 0.6, yv: 0.5 },
  { id: 'mirror',  name: 'Mirror',     icon: '🪞', x: 'Mode',       y: 'Shift',         amt: 0.3, yv: 0.5 },
  { id: 'kaleido', name: 'Kaleido',    icon: '❄️', x: 'Segments',   y: 'Rotate',        amt: 0.4, yv: 0.5 },
  { id: 'rgb',     name: 'RGB Split',  icon: '🌈', x: 'Amount',     y: 'Angle',         amt: 0.4, yv: 0.5 },
  { id: 'edge',    name: 'Neon',       icon: '⚡', x: 'Mix',        y: 'Colour',        amt: 0.8, yv: 0.5 },
  { id: 'poster',  name: 'Poster',     icon: '🎨', x: 'Levels',     y: 'Punch',         amt: 0.5, yv: 0.5 },
  { id: 'hue',     name: 'Colour',     icon: '🖍️', x: 'Hue',        y: 'Saturation',    amt: 0.3, yv: 0.7 },
  { id: 'pixel',   name: 'Pixels',     icon: '🧱', x: 'Size',       y: 'Shape',         amt: 0.3, yv: 0.5 },
  { id: 'vhs',     name: 'VHS',        icon: '📼', x: 'Grit',       y: 'Wobble',        amt: 0.6, yv: 0.3 },
  { id: 'scroll',  name: 'Roll',       icon: '↔️', x: 'Sideways',   y: 'Up / down',     amt: 0.7, yv: 0.5 },
  { id: 'pulse',   name: 'Beat Zoom',  icon: '💓', x: 'Depth',      y: 'Shake',         amt: 0.5, yv: 0.2 },
];

export const FX_IDS = FX.map((f) => f.id);

// Hold-to-apply pads.
export const MOMENTARY = [
  { id: 'strobe', name: 'Strobe', icon: '⚪' },
  { id: 'invert', name: 'Invert', icon: '🔄' },
  { id: 'glitch', name: 'Glitch', icon: '📺' },
  { id: 'freeze', name: 'Freeze', icon: '🧊' },
  { id: 'rewind', name: 'Rewind', icon: '⏪' },
];

export const MOM_IDS = MOMENTARY.map((m) => m.id);
