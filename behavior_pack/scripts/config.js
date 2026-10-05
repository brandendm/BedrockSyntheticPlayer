// In-game settings. The brain has its own config (brain/config.example.json).
export const CONFIG = {
  // Which copy of the pack is running: said on spawn, at every test and to `!bot version`. (The
  // manifest's version never changes, so an old copy left in the world looked like the new one.)
  build: 'u228',
  debug: false,               // toggled with `!bot debug`
  brainUrl: 'http://127.0.0.1:8765',
  brainTimeoutSec: 4,
  brainBackoffTicks: 200,     // after a failed call, don't retry for 10 s (falls back to local commands)

  botName: 'Scout',
  commandPrefix: '!bot',
  naturalChat: true,          // let the brain (Jev) pick up plain chat meant for the bot
  creeperWalls: false,        // cornered by a creeper: wall it off (true) instead of one block against the blast and fight on
  riskyJumps: true,           // jump gaps over deep drops (void, ravines) when the jump is a sure one (tools/sim_parkour.mjs); false: only over drops it would survive
  useProfile: true,           // take up the numbers learned from watching you play (`!bot learn on`, then `!bot profile off` to go back to the defaults)
  beds: true,                 // sleep at night (a bed, and sheep hunted for it); `!bot beds on|off` overrides, per world

  perceiveEveryTicks: 10,     // local mob scan: free, runs in-game
  hostileRadius: 16,
  hostileEventCooldownTicks: 100, // min gap between hostile_near events sent to the brain

  maxPathNodes: 20000,        // A* budget per segment; long trips are chained segments
  maxSegments: 25,
  maxReplans: 2,
  followRepathTicks: 20,
  followDistance: 3,
};
