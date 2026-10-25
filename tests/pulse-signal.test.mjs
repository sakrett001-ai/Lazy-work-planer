import test from 'node:test';
import assert from 'node:assert/strict';
import {createPulseSignal,advancePulseSignal,generatePulsePoints,pulseBeat,PULSE_BODY_SECONDS} from '../dist/pulse-signal.js';
const close=(actual,expected,tolerance=1e-10)=>assert.ok(Math.abs(actual-expected)<tolerance,`${actual} ≈ ${expected}`);

test('selected B uses the fixed beat body and a genuine baseline pause',()=>{
  assert.equal(PULSE_BODY_SECONDS,.82);
  assert.equal(pulseBeat(-.01),0);assert.equal(pulseBeat(.83),0);assert.equal(pulseBeat(1.2),0);
  assert.ok(pulseBeat(.15)>.13);assert.ok(pulseBeat(.295)<0);assert.ok(pulseBeat(.335)>.9);assert.ok(pulseBeat(.4)<0);assert.ok(pulseBeat(.56)>.24);
  for(const period of [2.8,1.8,1.5,1.25,1.05]){
    const model=createPulseSignal({period});advancePulseSignal(model,10);
    const beats=model.beats;for(let i=1;i<beats.length;i++)close(beats[i].time-beats[i-1].time,period);
    assert.equal(pulseBeat(period-.01),0,'cadence changes pause, not beat-body duration');
  }
});
test('new trace is written into the gap while prior geometry stays fixed and fades',()=>{
  const model=createPulseSignal({period:1.8,amplitude:1});
  const before=generatePulsePoints(model,300);advancePulseSignal(model,.12);const after=generatePulsePoints(model,300);
  let existing=0,fresh=0,expired=0;
  for(let i=0;i<before.length;i++){
    const a=before[i],b=after[i];
    if(a&&b&&b[2]<a[2]){close(a[1],b[1]);existing++;}
    if(!a&&b)fresh++;
    if(a&&!b)expired++;
  }
  assert.ok(existing>75);assert.ok(fresh>0);assert.ok(expired>0);
  const empty=after.filter(p=>!p).length;assert.ok(empty>40&&empty<55,'roughly1.2s of3.8s lane remains empty');
  for(const point of after.filter(Boolean)){assert.ok(point[1]>=0&&point[1]<=1);assert.ok(point[2]>=0&&point[2]<=1);}
});
test('cadence increases density without resetting fractional phase or changing old samples',()=>{
  const model=createPulseSignal({period:2.8,amplitude:.72});advancePulseSignal(model,.28);
  close(model.phase,.6);const prior=model.beats.map(beat=>({...beat}));
  advancePulseSignal(model,0,{period:1.05,amplitude:1});close(model.phase,.6);assert.deepEqual(model.beats,prior.filter(beat=>beat.time>=model.time-8));
  advancePulseSignal(model,.42,{period:1.05,amplitude:1});close(model.phase,0);close(model.beats.at(-1).time,.7);assert.equal(model.beats.at(-1).amplitude,1);
  assert.ok(model.beats.slice(0,-1).every(beat=>beat.amplitude===.72));
  const counts=[2.8,1.8,1.5,1.05].map(period=>{const m=createPulseSignal({period});advancePulseSignal(m,8);return m.beats.filter(b=>b.time>0).length;});
  for(let i=1;i<counts.length;i++)assert.ok(counts[i]>counts[i-1]);
});
test('sweep wrap preserves old samples until expiry and history stays bounded',()=>{
  const model=createPulseSignal({period:1.05});advancePulseSignal(model,2.38);
  const before=generatePulsePoints(model);advancePulseSignal(model,.04);const after=generatePulsePoints(model);
  for(let i=0;i<before.length;i++)if(before[i]&&after[i]&&after[i][2]<before[i][2])close(before[i][1],after[i][1]);
  advancePulseSignal(model,3600);assert.ok(model.beats.length<=9);assert.ok(model.beats.every(b=>b.time>=model.time-8));
  assert.equal(generatePulsePoints(model,301).at(-1)?.[0]??301,301);
});
test('invalid timing cannot make an unbounded sampling loop',()=>{
  assert.throws(()=>createPulseSignal({period:0}),RangeError);assert.throws(()=>createPulseSignal({amplitude:2}),RangeError);
  const model=createPulseSignal();assert.throws(()=>advancePulseSignal(model,Infinity),RangeError);assert.throws(()=>advancePulseSignal(model,-1),RangeError);
  assert.throws(()=>generatePulsePoints(model,Infinity),RangeError);assert.throws(()=>generatePulsePoints(model,0),RangeError);
});
