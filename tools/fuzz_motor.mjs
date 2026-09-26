// Fuzz test: 200 random worlds, plan + walk with up to 2 replans on stuck. Run: node tools/fuzz_motor.mjs
import { MotorController } from '../behavior_pack/scripts/core/motor.js';
import { findPath, smoothPath } from '../behavior_pack/scripts/core/pathfinder.js';
import { makeRng } from '../behavior_pack/scripts/core/mathutil.js';
import { makeWorld, SimBody, runMotor } from '../tests/helpers.js';
let ok=0, bad=[];
for (let seed=1; seed<=200; seed++){
  const r = makeRng(seed); const solids=[];
  for (let i=0;i<40;i++){ const x=r.int(2,18), z=r.int(-8,8); solids.push([x,64,z],[x,65,z]); }
  const hmap=new Map(); for(let i=0;i<15;i++) hmap.set(`${r.int(2,18)},${r.int(-8,8)}`,65);
  const w = makeWorld({ solids, ground:(x,z)=>hmap.get(`${x},${z}`)??64 });
  const p = findPath(w.classify,{x:0,y:64,z:0},{x:20,y:64,z:0});
  if(!p.complete) continue;
  const body=new SimBody(w,{x:0.5,y:64,z:0.5},r.range(-180,180));
  const m=new MotorController(body,{},makeRng(seed));
  let {result}=await runMotor(m,body,m.followPath(smoothPath(w.classify,p.path)),1500);
  for(let k=0;k<2&&result?.status==='stuck';k++){ const q=findPath(w.classify,body.pos,{x:20,y:64,z:0}); ({result}=await runMotor(m,body,m.followPath(smoothPath(w.classify,q.path)),1500)); }
  if(result?.status==='arrived')ok++; else bad.push([seed,result?.status]);
}
console.log(ok, bad);
