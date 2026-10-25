// Selected B: new samples are written into a sweeping lane, then fade in place.
// This is a task-state visual metaphor, not a medical signal or measurement.
export const PULSE_BODY_SECONDS = .82;
export const PULSE_SWEEP_SECONDS = 3.8;
export const PULSE_TAIL_SECONDS = 2.6;
const HISTORY_SECONDS = 8;
const mod = (value, divisor) => ((value % divisor) + divisor) % divisor;

export function pulseBeat(seconds) {
  if (seconds < 0 || seconds > PULSE_BODY_SECONDS) return 0;
  const gaussian = (center, spread, amplitude) => amplitude * Math.exp(-.5 * ((seconds - center) / spread) ** 2);
  return gaussian(.15,.043,.14) + gaussian(.295,.016,-.16) + gaussian(.335,.014,1)
    + gaussian(.375,.021,-.32) + gaussian(.56,.075,.25);
}
function configuration(config) {
  const period = config.period ?? 1.8, amplitude = config.amplitude ?? 1;
  if (!Number.isFinite(period) || period < PULSE_BODY_SECONDS || !Number.isFinite(amplitude) || amplitude < 0 || amplitude > 1) {
    throw new RangeError('Pulse period must contain the fixed beat body; amplitude must be within 0..1.');
  }
  return {period, amplitude};
}
export function createPulseSignal(config = {}) {
  const {period, amplitude} = configuration(config);
  const model = {time:0, phase:.5, period, amplitude, beats:[]};
  // Seed only past samples, so the first frame has a fading tail and an empty gap.
  for (let time = -period * .5; time >= -HISTORY_SECONDS - period; time -= period) model.beats.unshift({time, amplitude});
  return model;
}
export function advancePulseSignal(model, seconds, config = model) {
  if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError('Pulse elapsed time must be finite and non-negative.');
  const {period, amplitude} = configuration(config);
  const end = model.time + seconds, totalPhase = model.phase + seconds / period;
  const count = Math.floor(totalPhase + 1e-12);
  // Retain fractional progress when cadence changes. Only the pause changes;
  // existing beat timestamps and amplitudes are never rescaled or rewritten.
  const first = model.time + (1 - model.phase) * period;
  const earliest = Math.max(0, count - Math.ceil(HISTORY_SECONDS / period) - 1);
  for (let index = earliest; index < count; index++) model.beats.push({time:first + index * period, amplitude});
  model.time = end;
  model.phase = Math.max(0, totalPhase - count);
  model.period = period;
  model.amplitude = amplitude;
  model.beats = model.beats.filter(beat => beat.time >= end - HISTORY_SECONDS);
  return model;
}
function sampleSignal(model, time) {
  for (let index = model.beats.length - 1; index >= 0; index--) {
    const beat = model.beats[index];
    if (beat.time <= time) return pulseBeat(time - beat.time) * beat.amplitude;
  }
  return 0;
}
export function generatePulsePoints(model, width = 300) {
  if (!Number.isFinite(width) || width <= 0) throw new RangeError('Pulse width must be finite and positive.');
  const sweep = mod(model.time + 1.4, PULSE_SWEEP_SECONDS), result = [];
  const columns = Math.ceil(width / 2);
  for (let index = 0; index <= columns; index++) {
    const x = Math.min(index * 2, width), position = x / width * PULSE_SWEEP_SECONDS;
    const age = mod(sweep - position, PULSE_SWEEP_SECONDS);
    if (age > PULSE_TAIL_SECONDS) { result.push(null); continue; }
    result.push([x, .62 - sampleSignal(model, model.time - age) * .42, (1 - age / PULSE_TAIL_SECONDS) ** 1.3]);
  }
  return result;
}
