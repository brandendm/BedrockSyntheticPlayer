# Bedrock Agent

A fully autonomous Minecraft Bedrock agent: you give it tasks, it does them on its own, and it moves like a human player.

**Milestone 1:** the bot spawns, walks anywhere with smooth human-like camera and movement, follows you, detects threats it can actually see, and runs on rules alone with $0 of API spend. Jev and a local LLM plug in for decisions the rules can't make.

## Architecture

```
 chat "!bot ..."                                    ┌───────────── brain/ (Python, stdlib only) ─────────────┐
      │                                             │  1. grammar / rules      free, instant                 │
      ▼                                             │  2. Jev (System 1)       ~$0.000004/call, budget-capped│
 ┌──────────── behavior_pack/ (in-game, 20 tps) ─┐  │  3. local LLM (Ollama)   free, rare, output validated  │
 │ Agent      tasks, perception, event triggers  │──┤     every layer falls back to the one before it        │
 │ Pathfinder A* → string-pulled waypoints       │◄─┘  events only (command, hostile_near, stuck, task_done) │
 │ Motor      spring camera, pure-pursuit steer  │     never polled on a timer                              │
 │ Body       SimulatedPlayer adapter            │
 └───────────────────────────────────────────────┘
```

- `behavior_pack/scripts/core/`: **pure JS**, no Minecraft imports. Unit-tested and fuzzed in Node.
  - `motor.js`: owns camera and movement. Damped-spring rotation with a speed cap (never snaps, slight overshoot on big flicks), steering toward a point 1.6 blocks ahead so corners become curves, gaze 4 blocks ahead and slightly down, movement kept within 20° of facing (turns in place if the path doubles back), 150–350 ms reaction delay, sprint on straight level runs, step-ups taken square-on (lines up with the step block before jumping), gap leaps from the edge, stuck detection.
  - `pathfinder.js`: incremental A* (walk 8 directions with no corner cutting, step up 1, drop up to 3, leap 1-block gaps, avoids lava, fire, cactus and similar). Runs through `system.runJob` so long searches never lag the server. Long trips are chained partial segments. A target it can't get to (an item behind a wall, an animal in a pen) is recognised after 1,000 nodes by a flood fill from the target's side, rather than after the whole 8,000-30,000 node budget. Block reads are shared between searches for a second, and cleared whenever the bot changes a block itself.
- `behavior_pack/scripts/game/`: Script API glue. `body.js` is the only file that touches `SimulatedPlayer`, so API changes between versions get fixed in one place.
- `brain/`: HTTP server the pack calls on events. `jev_client.py` enforces hourly-call and daily-dollar caps (persisted across restarts), caches identical questions, and returns `None` on any failure so the caller falls back.

## Quick start (already set up)

1. Double-click **Start Agent.bat**. It opens a brain window and a server window.
2. In Minecraft go to **Play → Servers → Add Server**, address `127.0.0.1`, port `19132`, and join.
3. In chat, type `!bot spawn`, then `!bot follow me`.

If Minecraft can't reach 127.0.0.1, run **tools\fix_minecraft_localhost.bat** as administrator once.

## Dashboard

**Start Agent.bat** opens it in your browser: **http://127.0.0.1:8765/**. It updates every second.
- **See:** what the bot's doing, its health, hunger and air, position, inventory (the held item is outlined), where things are, and a running log.
- **Control:** come to or follow a player, stop, auto on or off, surface, spawn next to a player, despawn, run any in-game test, or type any command.
- **Admin:** day or night, clear weather, keep inventory, creative or survival for a player, teleport either way, or run any server command. These run as the server, with full permissions.

It's served by the brain. The game sends its status and picks up your commands over local HTTP once a second, so nothing leaves your PC and it makes no API calls. If Python isn't installed there's no brain and no dashboard, but the bot still works.

**Admin in game:** `server.properties` has `allow-cheats=true` and `default-player-permission-level=operator`, so you're an operator on every world this server runs. That means anyone who joins this server is too; it's only on your PC.

## Setup from scratch (Windows)

**1. Bedrock Dedicated Server.** Download BDS matching your game version (currently 1.26.51). The manifest targets `@minecraft/server 2.11.0-beta`. If BDS logs an unsupported module version, change the three versions in `behavior_pack/manifest.json` to the betas it offers.

**2. A world with Beta APIs on.** In the Minecraft client, create a world with **Experiments → Beta APIs** enabled. Copy its folder from `%APPDATA%\Minecraft Bedrock\Users\Shared\games\com.mojang\minecraftWorlds\<id>` to `<BDS>\worlds\<name>`, and set `level-name=<name>` in `server.properties`.

**3. Deploy the pack.**
```powershell
.\tools\deploy.ps1 -BdsPath "C:\path\to\bds"
```
This copies the pack, enables it on the world, and allows `@minecraft/server-net` + `-gametest` in `config\default\permissions.json`.

**4. Start the brain** (Python 3.10+; no packages needed):
```powershell
$env:JEV_API_KEY = "..."      # optional. Without it: rules only, $0
.\tools\start_brain.bat
```
Optional local LLM for free-form requests: install Ollama and run `ollama pull llama3.2:3b`. Set `"ollama_url": ""` in `brain/config.json` to turn it off.

**5. Play.** Start BDS, join, then in chat:

| Command | Does |
|---|---|
| `!bot spawn` / `!bot despawn` | add / remove the agent next to you |
| `!bot come` | walk to you |
| `!bot follow me` / `!bot follow <name>` | follow, repathing smoothly as you move |
| `!bot goto 120 70 -40` / `!bot goto 120 -40` | walk there (y inferred from the surface) |
| `!bot stop` | cancel |
| `!bot status` | say what it's doing |
| anything else | goes to Jev, then the local LLM |

If the brain is down, the pack falls back to a built-in parser for come, follow, stop and goto. Command blocks can use `/scriptevent agent:cmd come`.

## What it does on its own

With no orders (and after finishing any order) it works through a goal ladder.

**Looking around and knowing where it is** (`game/lookout.js`, `core/biomes.js`). Every 3 s it glances at ~10 surface columns out to 64 blocks, the way a player takes in the landscape (one top-block read and one line-of-sight ray each, ~30 block reads a second). Only what it can actually see counts. Trees it spots are traced down to the trunk and remembered, as are bare stone, sheep out to 48 blocks, and each chunk's water, land and biome. The chunk map is kept in the world, bounded to the latest 600 chunks. It knows what biomes are good for: sheep and cows on plains, meadows and forests (never deserts, oceans or mushroom islands), trees in forests, taiga and jungle, bare stone on windswept hills and stony shores. Exploring leans toward the right biome for what it's after. When nothing good is loaded nearby it asks the world seed for the nearest matching biome (a heavy call, so at most once per 5 minutes per need). The dashboard shows the biome it's in.

**Islands.** Spawned on a little island with no trees (or none of whatever it needs), it notices: its walkable land is small and what it sees around it is mostly water. Then it swims for land in legs, in this order of choice: land it has seen across the water (trees first when it needs wood), else the nearest good biome from the seed, else straight out the way it was heading. It says where it's going and doesn't go back to search the island again.

**Focus: cheapest job first, priority jobs never skipped** (`core/focus.js`). The ladder says what comes next, but before each step the bot also totals what every remaining goal still needs (wool for the bed, logs and cobblestone for the tools, furnace and house, food). If one of those is right here and cheap (sheep within 24 blocks, a food animal within 16, a tree within 20, known stone within 16), and the ladder's own step would mean going looking, it does the cheap one first. It says so ("Sheep right here (9 blocks): getting wool for the bed while I'm at it."). Priority jobs are never pre-empted: night (home or shelter), collecting a finished furnace, building and furnishing the house it started, crafting, and the crafting table. A step that fails 3 times in a row is set aside for 3 minutes while it does the cheapest other doable job; it only goes exploring when nothing on the list is doable nearby. The dashboard shows side jobs and anything set aside.

**Stone tools** (`core/recipes.js`):
1. Chops 3 logs (4 if a shovel pays off), then crafts a crafting table, a wooden pickaxe and a wooden sword.
2. Looks for stone it can see. If there isn't any, it digs a one-wide staircase down: fists on dirt unless a wooden shovel is quicker, never the pickaxe on dirt, never straight down, never next to water or lava. Once the stairs are two steps into solid stone it stops going deeper and tunnels along that level (1x2, taking the stone walls beside its feet too, about 4 cobblestone per step), turning every 10 blocks so the tunnel stays compact and never heading under the house. Then it goes back to the foot of the stairs and carries the same staircase on down.
   - **One quarry:** the staircase is the quarry, kept step by step in the world file (`quarry` in memory). Every trip for stone or iron walks down those same stairs and carries on from the bottom, the way it was heading. It never starts a second hole beside it or inside it. Blocked below (a cave, water, a drop), it cuts a few blocks along the level, and that cut becomes part of the stairs. It gives up on the quarry only when it can't get down it three times running, or nothing more comes out of it three times running. A quarry more than 32 blocks from the house is retired, and a new one is started 14-24 blocks from the house.
   - The stairs stop at Y 16 (the iron layer). Down there, stone comes from the branch mine.
   - Ore showing in the walls on the way (iron, coal and the rest) gets mined, and so does coal or iron it can see a few steps off. Then it steps back onto the stairs or tunnel. The same goes for any stone it's mining at the surface. It keeps 32 coal in the pack for torches, and the rest goes in the chest as fuel.
   - Going back up, it walks its own stairs step by step (no path search), one jump per step.
3. Mines 8 cobblestone, then crafts a stone pickaxe and a stone sword.

**Settling in** (`core/settle.js`, done by `game/homestead.js`):
1. **Furnace:** 8 more cobblestone.
2. **Bed:** 3 wool of one colour from sheep it can see or remembers seeing, then a bed. It kills any easy food animal close by while it's low on food. If no sheep turn up, it comes back to the bed later.
3. **Torches:** it loads logs into the furnace with planks as fuel, goes off to do the next thing while they cook, and comes back for the charcoal. Charcoal plus sticks makes 8 torches.
4. **House** (`core/house.js`): 5 wide and 9 deep, with cobblestone corners and bottom row, plank walls, a flat plank roof, a door, two small high windows, and a torch each side of the door.
   - **Front room:** the old cabin's 3x3, with the bed, crafting table and furnace, and a torch.
   - **Chest room** at the back, through an open doorway: a chest in each corner. They're never side by side, so each stays a single chest. A sign on the wall over each says what goes in it: *Stone & ores*, *Wood & plants*, *Food & farm*, *Mob drops & other*. Putting things away sorts them by those signs (`core/storage.js` `chestKindOf`), and anything that doesn't fit goes in whichever chest has room. The chest room has its own torch.
   - **Cost:** about 33 cobblestone and 87 planks for the shell. With the door, bed, table, four chests and four signs it's 37 cobblestone and 37 logs from scratch, fetched in one trip. The old cabin was 27 and 17. It's built from the middle of each room, so every block is in reach from inside.
   - **Houses already built** (saved without a layout) stay 5x5 cabins with their one chest by the door: nothing gets torn out or "finished". Only new houses get the chest room.
   - Materials: about 27 cobblestone and 17 logs. That covers the walls and roof plus the door, bed, table and chest, gathered in one trip rather than going back for a couple of logs at a time.
   - Plants where the door torches go (a peony, a rose bush, tall grass, a bush): broken first. Anything built is left alone.
   - Where: it picks the flattest clear spot within 16 blocks, never over trees, water or anything built.
   - How: it builds from the middle of the room, so it's done in about a minute.
   - Upgrades planned: glass in the windows, a trim.
5. **Food:** it eats when hunger drops to 14 (or when hurt and not full). It picks the food that gives the most hunger and saturation that actually land, minus what's wasted over the top (`core/settle.js` `chooseFood`, Minecraft's saturation numbers: a steak is 8 hunger and 12.8 saturation, raw beef 3 and 1.8). So when properly hungry it eats a steak rather than raw beef or bread. When full and already saturated it takes the smallest bite. When hurt with no saturation left it eats the steak, because saturation is what drives fast healing. Raw meat waits while some is cooking in a furnace within 32 blocks, unless it's starving (hunger 6 or less) or badly hurt (health 8 or less). It eats raw chicken only when starving, and rotten flesh only when starving with nothing else.

**The chest** (`core/storage.js`): it keeps its tools, armor, iron, wool (until it has a bed) and what it's about to place in its pack. It also keeps a working amount of everyday things: 32 torches, 16 of each food, 64 cobblestone, 16 logs, 32 planks, 16 sticks, 32 coal, 16 charcoal, and 16 seeds. Everything else goes in the chest: mob drops, odd stone, spare ores, surplus. It puts things away every night before bed, and whenever the pack gets down to 4 free slots. A mining trip ends early to come home and put things away rather than leave ore behind. When the first chest is full it makes a second one against the back wall. When a job needs cobblestone or logs it has stored, it takes them out of the chest instead of fetching more.

**Nights:** at dusk it drops what it's doing and goes home, shuts the door and sleeps in its bed. In the morning it comes back out. If it can't get in, it clears whatever is in the way (below) and tries again. If it's still shut out, it digs in where it is rather than stand outside all night. It never fights from bed. A mob further off is left to the walls. One that hits it, or is right by the bed (or a creeper within 5), gets it out of bed first, and the fight starts once it's on its feet (`tools/sim_bed.mjs`).

**Nothing in the way, whatever it is:** the house's rooms, doorways, doorstep and the places its things go (table, furnace, bed, chests, signs, torches, door) are checked for anything that shouldn't be there (`core/house.js` `keepClear`). That covers a player's blocks, sand or gravel that fell in, rubble, water or lava, or the wrong thing in one of its furniture spots. It's dug out and picked up, and water or lava is blocked off with a block that's then dug out. Clearing the house comes before repairs and anything else, day or night. The rule is general: on any essential job (going home, the furnace, the chest, the table, repairs, getting its things back after dying), a way that's blocked by anything breakable is broken through: a player's build, glass, wool, a chest. The exceptions are its own house's walls and furniture, and blocks that can't be broken (bedrock, obsidian, barriers). Ordinary trips still go around. It no longer puts its door in over a block, which used to delete the block.

**Fire:** fire on or around the house, day or night, comes first. It punches every flame out, nearest first, reaching roof fires from the ground beside the wall. The repair then patches whatever burned. A running job is dropped as soon as fire is seen at the house.

**What it wants** (`core/wants.js`): one table of what's worth having right now, used everywhere it decides whether to bother.
- **Ore:** coal (torches, the furnace; worth more when it's short), iron (while the gear isn't made), diamonds once it has an iron pickaxe. Copper, gold, redstone, lapis and emerald are left alone: nothing it makes with them yet.
- **Where ore gets mined:** in the walls of the quarry, the branch mine and the stairs. While quarrying stone, every block's uncovered faces are checked, not every 4th block as before. And any wanted ore showing within 6 blocks of wherever it's working.
- **Items on the ground:** armor that beats what it's wearing, a better sword or tool, a shield, iron, diamonds, coal when short, wool while the bed needs it. Worth fetching from 20 blocks off; something well worth having (armor, a better sword) dropped within 16 makes it drop what it's doing and go. String, bones, flowers and odd stone aren't worth the steps (it still picks up whatever it walks over).
- **Armor:** any material. Each piece that beats what's worn in that slot goes on as soon as it's picked up, and the old one goes back in the pack.

**Other fixes in this round:**
- **Sleeping off means working nights.** With `!bot beds off`, a sword and half health or more, night is like day: no going home and sitting it out. Unarmed or hurt, it still takes cover.
- **The bed is crafted at a table that's already there,** not at a new table put down where the last sheep fell. The wool keeps; at bedtime it's made at the house's table and put in.
- **Zombies:** it backs off at 2.6 blocks instead of 2.0 (a zombie hits from about 1.6). `node tools/sim_combat.mjs --zombies 300`: 0.28 hits taken a fight, down from 0.76, same kills.
- **Following you up a tower** (or anywhere with no walking way): `come`, `goto` and `follow` now pillar, dig or bridge a way there, out to 64 blocks. Climbs search weighted toward the goal, and the search's estimate now counts a block up as at least a step-up (it counted 0.3, a drop's cost). A 40-high climb takes about 400 search nodes instead of running out at 60,000.
- **Down fast with a water bucket:** with one in the pack (not in the Nether, 8+ health), a route can go straight off a pillar or cliff up to 40 blocks, and the water breaks the fall.
- **No bucket after dying:** the height of a fall from before a death (or a teleport) was kept, so the first step off a block after respawning read as a long fall.
- **Never through its own house:** a route never digs the house's walls, roof, furniture or the ground it stands on. Its own blocks count as diggable, and one way in with a wall down went under the floor.

**Running from a group** (`node tools/sim_combat.mjs --pursuit 400`: 2-4 mobs, a creeper among them most times, on flat ground, in a forest, on rough terraced ground, and down a trench 2 deep with them coming from both ends; hurt or not). Each change can be switched off: `TOWER=0`, `AVOID=0`, `CJAB=0`, `CLIMB=0`.
- **Creepers get the spear while it runs from the rest.** Its running jab only ever looked at melee mobs, and a creeper isn't one. Now a creeper within 4.2 is asked about first: the spear from 2.4-3.9 (the knockback keeps it outside its fuse range), a sword only on one closing in. If the creeper isn't worth a jab that moment, the nearest zombie still is (asking only about the creeper left the zombies unjabbed: more deaths).
- **Routes keep off creepers.** A creeper counts as nearer than it is when picking where to run. The route treats cells within 3.5 of one as off-limits, but never cells further from it than the bot already is, so the way away always stays open. (Blocking the whole circle fenced the bot in whenever a creeper was beside it.)
- **Up a ledge with a block.** The search for somewhere to run can put a block down to step up (up to 4, no digging). A route that needs it is followed a block under the feet at each step up. Out of a trench with zombies both ways: 148 deaths in 200 before, 23 now.
- **Up a pillar, last resort.** Cornered by zombies only (nothing that shoots within 24, no spiders, no creepers near), nowhere to run and no way in to wall off, with 3 blocks and open sky: 3 blocks up, and it hits them from the top while they crowd the foot of the pillar. As a first choice it cost lives: an archer turning up later found it up there.
- **Result:** deaths 89 → 41, explosions 33 → 18, a creeper within 3 blocks for half as long. The random fights, the named fights (32/32), chases, dead ends and the quarry ambushes are unchanged.

**The whole game, start to finish** (`node tools/sim_life.mjs 50`): the agent's own planner (`planStep`: the goal ladder, settling in, the farm and iron, side jobs, night in the mine) and the auto loop's own bookkeeping (a failing step set aside for 3 minutes) run on a virtual clock. A world model plays out each step: walks, chopping, digging, furnaces, nights, hunger, deaths and lost things, a creeper, a player's blocks, fire, a pack filling with junk. It runs 10 kinds of world: plains, forest, desert, no sheep at all, griefed, deadly, brutal, hunting off, junk, and goals switched off. It looks for steps repeating with nothing changing, the plan asking for what the world can't give, and where the time goes. It found five bugs, now fixed:
- **No sheep anywhere stopped everything.** Once it gave up looking, the plan still said "look for sheep", so the farm and the iron never came (0 of 20 such worlds finished). Now it gets on with the rest and looks again later. After 6 fruitless search legs (3 on later rounds), it waits 15 minutes, then 30, then an hour. With nothing else left to do it keeps looking. Finding sheep ends the wait; before, the wait kept it from hunting sheep it had just found.
- **A full pack of things it keeps:** there was nothing to put away, so `store` came back every round, ahead of the farm and the iron. Now that's noted for 10 minutes.
- **A farm tile it can't plant** sent it straight back to tend the farm for ever (tending is never set aside). A tend that does nothing now rests the farm 5 minutes.
- **The same step three times running was set aside even when each one worked** (bread, a loaf per 3 wheat; spare pickaxes). A repeat now means the pack didn't change; 8 of the same in a row is still set aside.
- **The idle bed search** (above): sheep found while the wait was on went unhunted.

Result: 499 of 500 runs finish every goal, with none stuck and no mismatches. The one miss is a desert where it never met a sheep. Median time is about an hour of game time (3 days) on plains or in a forest, and 84–88 minutes with no sheep or in a desert. The time goes on nights at home (31%), iron (28%), searching (8%), and waiting on the last batch of iron in the furnace (4%). Two ideas the sim can measure but not decide: spending nights down the mine rather than at home while iron is still short, and a second furnace at the house to halve that last wait.

**After a blast:** before patching the house (and before furnishing it), it picks up what's lying around it: a blown-up chest's or furnace's contents, or the junk it dug out. `node tools/sim_home.mjs` runs `homestead.js`'s own code against a block world:
- a player filling the rooms and doorway
- the doorway bricked up at night
- a doorway it can't break (it digs in instead)
- the wrong things in its furniture spots
- water in the room
- a creeper blast at the front with a chest's things on the ground
- the roof on fire

All 8 cases pass. With no house yet, it builds one if it has the materials. Otherwise it digs in (3 blocks down in soft, dry ground, with a block over its head) or walls itself in with blocks, and climbs out in the morning.

**Reaching things up high:** a crafting table or furnace is used from anywhere within reach, not walked onto. If it's up a ledge, the bot walks to the foot of the wall and goes up a level the cheapest way: a throwaway block under its feet if it has one, otherwise a step cut into the wall.

**Not wasting things:** after a kill it waits for the drops to appear and then picks them all up. After chopping a tree it sweeps up every log that fell (and saplings). After mining it collects what's lying around. Anything it can't walk to (a log caught in leaves) is remembered for later. When it dies, it goes back for its things within the 5 minutes before they despawn. At night it only does this if they're close.

**Digging and building as part of a route:** like Baritone, the pathfinder can also plan dig-through, cut-a-step-up, pillar-up, bridge and dig-down moves. A bridge puts a block against the side of the one it stands on, over a gap 2+ deep or water, and walks onto it; later moves in the plan treat placed blocks as ground. Each is priced in seconds: break time with the best tool it has, the block it would place, and walking. So "tunnel 3 blocks" competes fairly with "walk 60 blocks round". It's used to get out of caves (one plan to the surface instead of a string of guesses) and whenever a place can't be reached on foot within 24 blocks. It never digs next to water or lava, under sand or gravel, or through anything built.

**Doors and fence gates:** routes go through wooden doors and gates. The bot opens them as it walks up and shuts them once it's a couple of blocks past, so animal pens stay shut. It only hunts animals it can actually walk up to, which stops it killing a cow across a fence it can't get round.

**Which mobs matter:**
- **Melee mobs:** it only reacts to ones it has seen recently and that can walk to it (a short path search from the mob). A zombie in the cave under its feet, behind a wall, or across a ravine doesn't make it drop what it's doing.
- **Water:** mobs in the water (drowned) are ignored unless they hit it.
- **Nowhere to run:** fleeing goes to the safest place it can actually reach, on its own side of the threats (never past them), and out of an archer's sight if one is shooting it. If nowhere is safer and it's in a 1-wide passage with the threat coming the one way in (a mine tunnel, a dead end), it walls the way in with two of its cheapest blocks. Failing that, it backs into the dead end nearby. Only then does it fight whatever is close, or carry on if nothing is.

**Fighting** (`core/tactics.js`, the same code the combat arena runs):
- **Getting to it:** it plans a path to the mob itself, over the real terrain. A skeleton at the top of the quarry means going back up the quarry steps to it. (It used to aim at a point on the straight line to the mob, which was inside the rock, so it stood at the bottom trading looks with the skeleton while the arrows hit the first step.) It weaves while walking in on an archer.
- **Going nowhere:** if 6 s pass with no hit landed and not a block gained, it gives that mob up for a minute. The mob counts as out of reach, so the bot either gets on with its work or, if the mob is still shooting it, gets out of its sight.
- **Shield:** the first iron ingot becomes a shield (before the pickaxe; if there's no wood for the planks, the pickaxe goes ahead and the ingot waits), and it's worn in the off hand. It crouches behind the shield walking in on an archer, and between its own swings when a zombie is about to hit. It drops the shield for the swing itself. Facing a creeper that's about to go off right next to it, it stands and takes the blast on the shield instead of racing it.
- **Creepers:** it keeps them off so the fuse never starts. A Bedrock creeper lights its fuse once you're inside about 2.9 blocks (measured in game: it stops to swell at 2.88) and in its sight, and stops beyond 6 or out of sight. Its stone spear (one cobblestone and two sticks, made with the stone tools) jabs from 2 to 4 blocks (minecraft.wiki, Spear), a sword from 3. So the bot stands at spear's length and jabs the creeper as it walks in; the knockback sends it back, and it never gets inside 2.9. (Measured: a hit knocks a creeper back 1.21 blocks and it walks 0.135 blocks a tick, so it's back in 9 ticks: sooner than the spear's cooldown, which is why the sword covers in between.) While the spear's cooldown runs (0.75 s for stone, its own), the sword covers anything that gets closer: switching is instant, and a creeper can be hurt again every 10 ticks. It never walks in on a creeper that's coming at it. It waits, facing it, and only walks (never sprints) toward one that hasn't come closer for 2 s, stopping well short. If the next swing isn't ready and the creeper is close, it backs off to the nearest spot it can stand on that far away (a quick search, since on stairs a point straight back is inside the rock). Paths planned before a stop are dropped. A swing that didn't take (the creeper's health didn't drop) is retried at once; a spear that keeps missing from beyond sword reach isn't counted on for reach any more. If one hisses anyway, it knocks it back and gets past 6 blocks, or with nowhere to go, takes the blast on its shield. **Cornered with no shield, where a hit won't move it** (at a dead end, back to a wall, the creeper coming down jagged steps that stop it being knocked back): it puts **one block** at its feet in the column toward the creeper and fights on over the top of it.
- **When:** a hit won't work if the blocks right behind the creeper leave it nowhere to go (a riser, rock), or if the last hit moved it less than 0.6 blocks.
- **Why one block:** a blast hurts by how much of you its rays reach from the creeper's feet (Minecraft's exposure). A block right in front stops most of them (`core/tactics.js` `blastDamage`), and the bot can still hit the creeper over it. The block comes down once no creeper is within 16, and never if it went into a hole in the house.
- **With other mobs about** (a zombie coming down the same stairs): it still walls the creeper off, feet and head height across its approach, because that keeps the zombie out too. `creeperWalls: true` in `config.js` walls off always, as before.
- **In the arena** (`--cornered`, 300 fights at the foot of jagged steps with no shield; the blast is now Minecraft's exposure formula):

  | | Dies | Creeper killed | Explosions | Health lost |
  |---|---|---|---|---|
  | Nothing | 75 | 217 | 44% | 5.9 |
  | Wall it off | 0 | 15 | 0% | 0 |
  | **One block** | **0** | **225** | 42% | **0.9** |

  The wall kept every creeper from going off but almost never killed it: it waited there, and the wall had to come down again. In the general creeper mix (`--creepers 800`) both come to 8 deaths.

A creeper with another creeper or a zombie close by is run from. It notices them early: in sight within 8, after it within 12, hissing within 8 even unseen (it hears them). Scripts can't read a creeper's fuse (the game's is_ignited means on fire), so it goes by what a player sees: a creeper within 3.5 that has stopped walking is swelling, and one that got inside 2.5 is taken as hissing for 1.5 s, and anything within 4. The arena now models the game's delays (paths land 3 ticks late, the body coasts after a stop, a swing lands only within the weapon's reach of the eye). At a realistic creeper walk (`CSPEED=0.13 SPEAR=1 node tools/sim_combat.mjs --creepers 500`), 97.4% of encounters end with no explosion, and every creeper met alone is prevented, in every terrain, the quarry stairs included.
- **Weapon:** the most damage per hit, since Bedrock has no attack cooldown. So a sword beats an axe of the same material (axes hit one less). A spear counts by its damage over its forced cooldown: less than a sword for fighting, but it's the one held against creepers (above). A weapon about to break is used last.
- **Kill slot:** caught at a dead end (the end of a mine tunnel, the one way in toward them) by grown zombies, husks or drowned, and either there's more than one or it's hurt. It puts one block at its feet in the next cell toward them, plus one above head height there if the ceiling is 3 high. That leaves a 1-high gap at eye level. A grown zombie can't get through the gap or climb onto the block. Pressed against it, the zombie is 1.6+ blocks from the bot, beyond a zombie's 1.4-block reach. The bot stands at the back of its cell and hits them through the gap one at a time. Behind the slot it fights on even when low on health, because nothing there can hurt it. It won't use the slot against a spider, a baby zombie, a slime (they fit through), an archer or a creeper (they'd shoot or see through). The block comes down once no monster is within 16. In the arena (`--deadend`, 2–3 zombies, random health and weapon): 0 of 300 die and every zombie is killed. Without the slot, 87 of 300 die. (Without it, the bot seals itself in with two blocks: it survives, but nothing dies. The arena used to let swings pass through blocks; now a swing needs a clear line from the eye.) Random fights (`--fuzz 600`): 577 survive vs 565.
- **Arrows:** fighting or running, it watches arrows in flight (within 24 blocks). It runs each one forward (drag and gravity) to see whether it will pass through its body. If it will, and there are 2+ ticks left, it steps sideways off the arrow's line, still facing where it was, like strafing with A/D (the motor's `strafe`: 2 ticks to react, walking speed). A skeleton aims where you are when it looses and doesn't lead, so a step aside is a miss. It doesn't dodge with its shield up at the arrow (that stops it anyway), or in a 1-wide tunnel (nowhere to step). In the arena (`--archers`, 300 fights), 35% of arrows hit with dodging vs 41% without. On open ground it's 38% vs 67%.
- **The arena's arrows and legs** (`tools/sim_combat.mjs`): arrows fly now. They leave at 1.6 blocks a tick with drag, gravity and a little spread, hit the first thing in their way, and a shield up at them stops them (`HITSCAN=1`: they land the moment they're loosed, as before). The body speeds up and slows down like a player's: each tick it keeps 0.546 of its speed and gains 0.454 of what it's asked for (`ACCEL=0`: full speed at once). That costs the creeper dance a little: 95.4% of encounters end without an explosion (5 deaths in 500), against 97.0% before.
- **The bow (arena only, for now):** `bowFight`, `aimBow` in `core/tactics.js`. It shoots from range, leading the target and allowing for the drop, and draws fully (20 ticks) unless the mob is about to reach it. It backs off when a zombie or creeper gets within 5–6 blocks, until there's room for a full draw. It uses the sword once something is on it, or when one swing finishes the mob. Drawing slows it to a fifth of walking speed. Same 150 fights with each loadout (`--weapons`):

  | loadout | died | hp lost a fight | killed |
  |---|---|---|---|
  | stone sword | 14 | 5.1 | 143/238 |
  | iron sword | 10 | 4.6 | 163/238 |
  | stone sword + spear | 14 | 5.1 | 142/238 |
  | bow + stone sword | 13 | 3.2 | 124/238 |
  | bow + iron sword | 3 | 2.2 | 151/238 |

  It's best against skeletons (0.7 hp lost against 6.5 with the sword) and spiders. Against a mix with a creeper, the bot runs whatever it carries (`decide` doesn't count the bow yet), so it gets few shots. Its aim in the arena is better than it will be in game: 100% of arrows hit, because it knows the mob's velocity exactly and mobs walk straight.
- **Running from a fight:** a zombie, spider or other melee mob gaining on it while it runs is jabbed. The bot turns, hits once and runs on. It uses the spear from 2.4–3.9 blocks, out of the mob's reach, and the sword if the mob is already on it. Each jab knocks the mob back about 1.2 blocks. In the arena (`--chase`, 300 chases at 5 hp, running from a mob that's faster than it), deaths go from 53 to 5 and hits taken from 0.93 per chase to 0.09. The forest is the hard case: the trunks slow the bot down. (The first figures, 0.17 hits per chase without jabbing and 0 with, came from an arena where the bot started inside a tree trunk in the forest and moved at full speed from a standstill.) In a fight, a melee mob in its face with the least health left is hit first, so one is finished off before the next.
- **Witches** are fought now; it used to run from them. It sprints in weaving (a witch leads its throw by only a tick), with no shield (a splash gets you anyway). It stays on the witch swinging, and sidesteps the thrown potions like arrows, with a wider margin for the splash. A witch within 16 blocks is fought unless the bot would clearly lose, because running only gives it more throws: it follows, and throws from 10 blocks. In the arena (`--witch 200`, a witch alone or with a zombie, Minecraft's witch: potion choice by range and health, 3 s between throws, drinks healing when hurt): 4 deaths and 3.3 health lost on average. Running from them had 175 deaths.
- **Low on air:** under water with less than half its air left, it drops everything and swims for air. If it's sealed in, it digs up to reach air.

**In the mine:** ore in the floor of its own tunnel or a quarry step gets mined too, and the hole is filled back in with a cheap block, so the floor stays level. (It used to skip it as protected: iron under its feet stayed while the iron in the wall got taken.) A vein is mined nearest block first from where the bot stands, with one pick-up at the end rather than a walk after every drop. Iron it has seen but not mined, and a branch it was halfway along, are kept in the world. The next trip goes back for them first instead of starting a new branch past them. At night down the mine it stays: mining, smelting and crafting at the mine camp, putting gear on. If the day's plan wants something up top while iron is still short, it mines on till morning. A mining trip counts from the moment iron mining starts down the mine until the plan has it doing something else (not wherever it happens to be standing at dusk). With a full pack at night it tosses surplus stone, and if that isn't enough it walls itself in at the end of the tunnel till morning rather than walking home in the dark.

**Its things come back with it:** a simulated player leaves with the world (closing it, a server restart, `!bot despawn`) and comes back with nothing. Its pack and what it wears (durability, enchantments and names included) are written to the world every 10 s and put back when it's spawned again, only if it's empty-handed, so nothing is ever doubled. After a death they're cleared (it's all on the ground, and it goes back for it).

**When a creeper blows up the quarry:** the stairs are the way in and out, but they're walked as a recorded list of steps. When that walk got stuck (a crater), one path search went for the far end, 40 steps off, and it could only dig or build its way across if that end was within 24 blocks. Three failed trips down and the quarry was abandoned. Now it gets past the damage a few steps at a time (each hop close enough to dig, pillar or bridge across), and puts the missing treads back as it passes, so the next trip is a plain walk. `node tools/sim_quarry.mjs` blasts creeper craters into a 48-step quarry: before, the bot got back up 25% of the time; now 100%, down and up, with the stairs whole again after.

**Leaving a damaged quarry with few blocks:** building across a crater only uses blocks it can spare. Until the house is up, its 27 cobblestone are held back. With 6 cobblestone and no house yet, it had nothing to build with, and 1 time in 7 it dug a new way out instead of using its own stairs. Now, when it has fewer than 8 blocks to spare at the damage, it digs a few out of the quarry wall first (it's stone). `node tools/sim_quarry.mjs 300 --leave` follows the game's escape chain with its real block limits: up its own stairs 100% of the time (97% before, `LEAVE=old`), about 22 s, the house's cobblestone untouched. Using the house's cobblestone instead (`LEAVE=noreserve`) gets 99%, but spends it in 29% of runs.

**Exploring without getting stuck** (`core/explore.js`): water it had to swim out of only keeps it from exploring that way if it's within 48 blocks and from the last 5 minutes. Before, every swim counted for ever, from anywhere; a few swims in different directions ruled out every way there was, and it stood in one spot saying it was looking further out. If water rules out everything, it goes across rather than nowhere. A trek toward a better biome that goes nowhere falls back to looking round locally. Three looks in a row that end where they began, and it treks 48 blocks a new way. Six, and it stops looking for that thing for 10 minutes and says so (for sheep, the bed waits) and gets on with everything else.

**Goals can be switched off:** `!bot goal <name> off` (and `on`), or the checkboxes under "What it works on" on the dashboard. The names:
- `beds`: sleeping, a bed, sheep for it;
- `house`: without one it digs in at night;
- `torches`;
- `farm`;
- `iron`: mining for iron tools and armor;
- `hunting`: when starving it still hunts;
- `storage`: putting things in the chests;
- `witches`: off, it runs from them.

Kept in the world; all on by default (`core/toggles.js`). Staying alive is never switched off.

**The farm waits for a bucket:** iron comes first. The farm starts once the bucket's made (after the shield, iron pickaxe and sword), and the same bucket then carries the farm's water or breaks falls.

**On the move:** grass for seeds and leaf litter are gathered along one route through the patch, swiped as it passes, never standing still between bits (`core/flow.js` `tourStops`). Chopping a tree never stops to wait for drops. Each break notes the item entities it made, by id, so the bot knows exactly which items on the ground are its own and when one has come in (a picked-up item is gone). Between logs, if one of its own has landed out of pickup range, it steps onto it only when the next log is still in reach from there, so the chopping carries straight on. With a player within 12 blocks it fetches them further out (6 blocks), so nobody walks off with them. It still sweeps the whole tree at the end (`tools/sim_drops.mjs`). After placing, planting or eating the last of something, it switches what's in its hand (its weapon, else a nudge off the slot and back), so it's not left showing an item it no longer has.

**Pillars it leaves:** every block it stands on to get up somewhere at the surface (a tree top, a ledge) is written down in the world until it's taken down. If something takes it away before it climbs down (a fight, the night), it comes back and breaks the pillar top-down from the ground, when it's calm and within 24 blocks. Pillars in a mine are the way back up, and stay.

**Faster paths:**
- **Sprint-jumps:** over gaps 2 and 3 wide, same level, only where a missed jump lands somewhere survivable. A 3-wide gap needs a block of run-up. It walks the 1-block jumps as before. In `tools/stress_path.mjs` `gaps` (trenches 1–3 wide): 6.1 s a crossing, against 10.6 s going round (`MAXLEAP=1`).
- **Tight spots:** `wedge` (1-wide slots between posts, diagonal pinches, a walled 1-wide zigzag with a step up in a turn): 60 of 60 arrive, none replanned.
- **Block shortcuts:** where the walk round is long, the dig-and-build search already takes the shortcut. Over a deep trench it drops in and builds 1–2 blocks up the far side (from a 14-block detour upward). Those steps get cleaned up like the pillars.

**Thinking time:** each step now writes a profile to `brain/logs/trace.jsonl` ("step profile": how much of it was moving, planning, breaking or anything else, and the longest stand-still with the log line just before it). A tree it can't get to is written off after one failed try; it used to stay the nearest and get tried three times. `tools/sim_think.mjs`: the path searches on a tree hunt come to about 0.6 s per 4 trees, so they aren't the bottleneck. The step profile will show what is.

**Sleeping is optional:** `!bot beds off` (or `!bot sleep off`) and it doesn't sleep. It needs no bed and hunts no sheep for one, and it sits the nights out at home, awake. `!bot beds on` turns it back on. The setting is kept in the world; `beds` in `config.js` is the default.

**Picking up where it left off:** what it's in the middle of is kept in the world file and written immediately for the house: the current step, the furnace it loaded (and how long is left), where its gear dropped when it died, and the house site. After a restart, a `/reload` or a death it says "Picking up where I left off" and carries on. The house's progress is read from the blocks actually placed, so it continues the same house on the same spot (`!bot test resume` checks exactly this). The dashboard shows the house's progress and what it still needs.

**The house is a project:** once it picks a site, the site is saved in the world. It gets every block it needs before placing the first one, never mines stone within 14 blocks of the site, finishes the house before chasing sheep or torches, and never starts a second one.

**The furnace** (`tools/sim_furnace.mjs` runs `homestead.js`'s own furnace code in Node, against a stand-in for the game in `tools/mock/`, where furnaces cook the Bedrock way and only while their chunk is loaded). Three of nine cases failed, and all are fixed:
- **Fuel gone mid-batch** (someone took it, or planks it made fell out of a full pack): it waited for ever on a furnace that would never finish. Now it takes the rest back and drops the job.
- **House furnace busy, a spare furnace in the pack:** it kept trying the busy one. Now it uses a free furnace, or puts the spare down.
- **Ore cooking at the mine camp, torches wanted at the house:** the plan only saw the nearest job, so it walked down the mine to wait on the ore while the house furnace stood free for charcoal. Now the plan goes by the job at the furnace it would use from where it is (a finished one within 24 first).

- **Seen in game: 81 blocks from home with raw meat.** The walk to the house furnace fell short, its chunk wasn't loaded, and the bot took it as gone and forgot it, so every smelt after failed. Now it travels most of the way first, and forgets a furnace only when it can see the spot is empty. It no longer walks 80 blocks home just to cook in the middle of the day either.

Its memory with several furnaces (the house's, one it put down out exploring, the mine camp's) was already right: exact positions, nearest first, and only furnaces it placed itself.

**A water bucket, always:** once it has a bucket, it keeps it filled (a plan step at the surface; never down the mine or in the Nether). When it falls far enough to lose 3+ health, or enough to kill it, it pours the water on the block it's about to land on as soon as that block is in reach, and scoops it back up after. It never does this in the Nether, where water boils away. `node tools/sim_fall.mjs` runs `core/fall.js` against Minecraft's fall physics for drops of 4 to 120 blocks, off an edge or jumping: 100% of falls broken. That assumes the script reads the bot's position the same tick. If the position were a tick late, 77% would be broken, because at full speed a fall covers the reach window in one tick. `!bot test fall` (arg: 1–17 blocks, default 16) drops it over flat ground and reports the damage it took and whether the bucket came back full.

**Counting a house in the woods:** a wall or roof spot with a tree trunk, low leaves or a lump of dirt in it was counted as already built, both for what to fetch and for how many logs to turn into planks. The clearing then takes those out, so it came up short partway. `node tools/sim_house.mjs` plays the game's site choice and build on plains, ordinary forest, dense dark-oak forest and a jungle edge:
- **Before:** 74–90% of houses in the three wooded kinds ran short partway (8–12 blocks each), and more than half then needed a second wood trip for the door, bed, table and chest.
- **Now** (`core/house.js` `houseMissing`): none run short, and none need that second trip.
- **Dense forest** is the slow one: about 27 s of clearing and 6 logs cut per site. With a short afternoon left, 6 in 100 can't be cleared and built before dusk wherever it looks.

**Leaves:** it never walks on top of or through tree canopies; it goes around them.

**Around or through:** when the walking route to somewhere within 32 blocks winds well past the straight line (a mangrove swamp, a hedge of leaves, a dirt bank), it also prices a route that breaks through. Break time uses its best tool, in the same units as walking. It takes the break-through route if that's at least 15% quicker, and says so. Mangrove roots are solid ground it can stand on and cut through (axe; muddy roots with a shovel), not something to walk into.

**Steps and gaps:** step-ups are taken square-on. The bot lines its body up with the step block before jumping, so a 1-high step beside a 2-high wall doesn't turn into jumping into the seam between them. It counts a step as climbed only once it's standing on it, and takes it again if it bumps off. It jumps 1-block gaps (walking, from the edge, lined up) instead of climbing down and back out, but only over a gap it would survive falling into (ground or water within 3 blocks, no lava). If it isn't lined up by the edge, it backs up and tries again rather than walking off. Up a staircase (its quarry stairs, say) it's one jump per step. A step that really doesn't take after three jumps gets a step back while it keeps facing the stairs, the way a player presses S; it never turns round.

**Mining and chopping without pausing:** before each block it aims (crosshair near the block, and the head keeps settling while it breaks) instead of stopping, settling to within 2.5° and holding. Chopping picks up the whole tree's logs in one sweep at the end rather than after every log. Stone comes off the face the last block uncovered, rather than a fresh look round (a scan and sight checks) after every block, and drops are gathered every few blocks. Between blocks it doesn't stand waiting on a drop at its feet; standing there picks it up anyway.

**One action leading into the next** (`core/flow.js`): a run of breaking, placing or planting goes the way a player's hand moves, not one block at a time with a stop and a fresh look between.
- **Order:** each next block is the smallest turn of the head from the last, working the edges first so no block is left stranded to jump back to. Walls go up a course at a time, like bricklaying. Breaking goes top down within a column (a tunnel is cut head then feet, and sand and gravel come down). Placing goes bottom up, and only against something already there.
- **Lead:** in the last ticks of a break, and as a placement or a hoe or seed use lands, the crosshair is already moving to the next block.
- **Aim:** placing aims the way mining does, near enough and settling as it goes. There's no stop, settle, hold and view-snap per block, so a block takes about 2 ticks instead of 4 plus the settle.
- **Where:** tunnels, house walls and site clearing, barricades and shelters, grass swipes, and tilling, planting and harvesting the farm.

On a 7×7 ring of house walls, the head turns about a sixth as much as in a shuffled order, with no jumps back across the wall.

**One-tap blocks:** grass, flowers and leaf litter go the way a player runs a held punch through them. Each breaks the tick the crosshair is on it, in order round the bot so the head sweeps: about 2 ticks a block, bare-handed. Leaf litter is worth taking now: whatever's in reach, then on into the rest of the patch, punching it down as it comes into reach while walking (up to 64 layers, about 15 s at most). Wheat seeds come the same way. It runs through the grass with the punch held, rather than breaking one tuft, waiting to see if a seed dropped (1 in 8 do) and walking over to it before the next. Walking through the patch picks most seeds up, and one pick-up pass over the patch at the end gets the rest. Seeds still lying on the ground count toward enough, so it stops swiping when it has what it needs. Building sites get their grass and flowers swiped the same way before the digging starts.

**Tight corners and edges:** the smoothed path marks two kinds of waypoint as tight, and the bot walks onto those instead of cutting the corner past them. One is beside a drop it wouldn't survive or lava, such as the start of a 1-wide bridge over a ravine. The other is a corner where turning early would clip what the path goes round: a trunk, a bush, a leaf at head height. It also only aims past a step it's jumping up when the path carries straight on, so the jump's carry doesn't take it over the side. `tools/stress_path.mjs` walks thousands of these worlds with a real-width body; everything that has a way through arrives.

**Stairs and slabs:** stairs the right way up and bottom slabs are their own kind of ground to the pathfinder. It walks up them without a jump (the game steps a body up half a block), so a staircase in a house or village is climbed like a player does it. They still need a block of headroom, just as a jump would, because the body rises while it's still under the step behind. From on top of a bottom slab it never plans a jump up a full block, since that's a 1.5-block climb. Upside-down stairs and top or double slabs are ordinary solid blocks.

**Ladders and vines:** the pathfinder climbs them up and down, and steps off onto the ledge at the top. The bot climbs by holding forward into the wall, like a player.

**Spatial memory:**
- **Explored chunks:** it remembers which chunks it has explored (kept in the world file), so exploring heads for new ground.
- **Its trail:** it keeps a trail of where it's been, so it can walk back out of a cave the way it came in.
- **Stuck spots:** if it gets physically stuck walking into the same spot twice, it treats that spot as a wall for 2 minutes instead of trying it again.
- **Asking it:** `!bot where` (or `!bot memory`) tells you where things are from where it stands: home, crafting table, furnace, resources it has seen, and its dropped gear, each as a distance and compass direction.

**Stuck in a hole while idle:** if it's standing in a pit or hole it can't walk out of, it climbs out on its own, even when it has no orders.

`!bot stop` pauses this, `!bot auto` resumes it, and `!bot dig` digs down to stone on request.

**Talk to it normally (Jev):** you don't need `!bot` for everyday requests. Every chat line goes through one Jev call that answers two questions at once: is this meant for the bot, and what does it ask for? The bot acts only when Jev is confident on both. "hey scout come over here", "can you follow me" and "scout get us out of this cave" all work, while "lol that creeper blew up my house" and "anyone want to trade diamonds?" are ignored (9/9 in a live test, about $0.00002 per line). Without a key, it still answers lines that include its name ("Scout come here"). Turn it off with `naturalChat: false` in `behavior_pack/scripts/config.js`.

**Getting out of caves:** it knows it's underground when there's rock or dirt over its head, it's at the bottom of a shaft or pit, or it's on the floor of a ravine or sinkhole (the ground around is far above it and there's no grass underfoot). It gets out the cheapest way available:
1. **Walk out:** first the way it came in (it keeps a trail of where it's been), then any other route to open sky (a cave mouth, its own staircase), including swimming.
2. **Get as high as it can on foot:** up any rubble, slope or ledge it can walk and jump to. Then, from the highest point, it prices each level up: a pillar (clear the block above, stand on a block) against a staircase (three blocks to break). A pillar is nearly free with dirt on hand or in reach, and it will break dirt up to 4 blocks above it and catch the drop. Punching a stone staircase by hand costs 22 s a level.
3. **Pillar up:** mine the block above, jump, place a block underneath. Only with a wall beside it, or under a ceiling it has enough blocks to reach, so it never ends up stranded on a free-standing tower. With a pickaxe the cobblestone it mines keeps it supplied. By hand, it first grabs nearby dirt or gravel, because punched stone drops nothing.
4. **Before digging:** it picks a column with no water, lava, sand or gravel in or beside it on the way up.
5. **Hazards:** it drains sand or gravel from the side so it can't fall on its head, and never if water sits on top of it. It swims up through water that opens to air within about 22 blocks, and swims through flooded tunnels to the nearest air.
6. **Fallbacks:** a staircase (3 blocks per level, but needs nothing to place), tunnelling sideways away from water, or moving to another spot in the cave.

It's tested from 9 different underground spots: with a stone pickaxe it gets out in 1–4 minutes. With no tools it gets there eventually but slowly, because punching stone takes 7.5 s a block; it says so and asks for a pickaxe. It never heads for remembered places while underground. `!bot surface` does this on request.

**Getting down:** stranded on a pillar, a tree or a spire (a long drop on every side), it weighs time against health the way a player does. It either steps off where the fall is gentlest (half a heart is worth about 6 s, never more than 3 hearts from one fall, never below 5 hearts left) or digs out the block under it and rides the pillar down, which is quick with a pickaxe and slow by hand. Water breaks any fall; it never lands on lava, magma or cactus.

**Only terrain counts as ground.** A glass sky roof, a house, a tree or its own pillar never makes it think it's underground. It never digs through anything built (glass, planks, cobblestone walls), only terrain and blocks it placed itself.

**Weighing what things cost** (`core/costs.js`): it breaks each block the cheapest way that still gets the drop, counting break time plus tool wear. That means fists or a shovel on dirt, never a pickaxe on dirt, and the lowest pickaxe that can harvest an ore. It builds with the least valuable block it carries (dirt, then andesite and other stone, then cobblestone, then planks). It keeps the cobblestone its next goal needs: 3 for a stone pickaxe, 2 for a sword, 8 for a furnace. When it needs blocks to climb with, it takes the cheapest ones nearby, usually dirt by fist.

**Stone:** it only counts stone it can actually see, meaning a clear line from its eye with nothing in between. It mines nearest-first from wherever it's standing and picks up every drop before moving on. With no stone in sight it digs a staircase down. What it remembers is only what it has seen, so no x-ray through the ground.

**Fighting:** it fights from the edge of its reach, about 3 blocks. It stops walking in once it's in range and steps back if a zombie gets within 2 blocks, so it lands hits while the zombie is still closing in.

**Exploring** heads for chunks it hasn't walked through yet and keeps going roughly the same way, instead of picking random directions.

**Memory** is kept in the world file, so it survives restarts:
- **What it tracks:** every 30 s it looks around and remembers resource blocks (logs, surface stone, coal, iron, copper, gold, diamond, redstone, lapis and emerald ore), crafting tables, and item stacks on the ground (including drops it didn't pick up).
- **Choosing where to get something:** it prices every option in seconds and takes the cheapest (`core/sourcing.js`): what's in sight, what it remembers, dropped items, or a fallback (explore, dig down). The price is travel time plus collection time, plus the cost of any shortfall, weighted by how likely the memory is still true. Item memories fade to zero at 5 minutes because items despawn.
- **Forgetting:** if something isn't there when it arrives, it forgets that spot and says so. `!bot memory` lists what it remembers.
- **Crafting tables:** it remembers every table it places or sees. When it needs one, it compares walking time to the nearest remembered table against the cost of a new one (placing it plus the wood). It walks if the table is close, and makes a new one if the old one is far away, gone, or can't be reached.
- **Trees:** it remembers where trees were, so the next wood run goes back there instead of wandering.

**After moving in** (`core/advance.js`, `game/farm.js`): a wheat farm by the house, then iron.
- **Farm:** it's made around water within 24 blocks of the house. If there isn't any, it digs a 2x2 pool beside a flat patch and pours a bucket into each of two opposite corners, which fills all four for good. The farm's water comes from that pool, and so does every later bucket. Trees on or right by the farm are chopped down (logs kept, no sapling put back, and no saplings replanted within 10 blocks of it). Leaves hanging low over the tiles are cleared. A torch goes in the middle of each side, one block past the tiles, so every tile gets light 9 or more and the wheat grows at night. Farms made before this get the same treatment the next time it tends them.
- **Iron:** down the quarry stairs to Y 16, then a branch mine: a 2-high main tunnel, with an 8-long branch to each side every 3 blocks. Where the main tunnel has got to is kept with the quarry, so the next trip walks to its end and carries on. If the mine breaks into a cave, it explores the cave first. It walks the cave floor within 24 blocks and 6 levels of the mine, mines the iron and coal it can see, and lights it as it goes, for up to 90 s. Then it goes back to where it was in the mine. Each cave is only explored once. Its tunnels are remembered by their floors in a world property of their own, with no size cap: a list of 1500 straight runs, around 12,000 blocks of tunnel. Before, they shared the staircase list, which keeps only the last 300 blocks. After a couple of trips the oldest tunnels dropped off it, and going back through them looked like breaking into a cave. Side branches are spaced off the ones already dug, rather than counted from where the trip started. So a trip that can't get back to the end of the tunnel (lava came in after a death) and starts again from the foot of the shaft never digs a branch alongside an old one. When the main tunnel is blocked, it turns the way with fewer of its own tunnels. If a pair of branches is a block or two back, it turns at them and runs down one, rather than digging alongside it. `node tools/sim_mine.mjs` plays trips cut short by deaths, comebacks that can't get back to the end, lava to turn at, and a long mine restarted from the shaft (`OLD=1`: the mine as it was). Result over 80 runs: old tunnels taken for a cave 0 times (504 before), and 0 blocks of tunnel dug with only one block between it and another tunnel (52 before, all where it turned at lava or started again from the shaft). If it ends up well below Y 16 (fell into a cave, followed a vein down), it climbs back up to the iron layer before mining.
- **Iron** is smelted in batches as it comes up (at the surface with 3+ raw iron, the furnace gets loaded before it goes back down), so the iron pickaxe comes early. Finished ingots wait in the furnace until it's up anyway. Before a trip it makes spare stone pickaxes if the ones it has are worn (under 200 uses between them), and torches from its coal.
- **Mine camp:** the first time it reaches the foot of the quarry stairs at Y 16 with a log and 8 cobblestone (or the items themselves), it digs a small side alcove there. The alcove is placed off the stairs and out of the branch mine's way, and gets a crafting table and a furnace. From then on, iron is smelted down there with coal from the mine, finished ingots are collected there, and spare pickaxes and iron tools are crafted there, all without a climb to the house. Each furnace has its own job, so charcoal or food can cook at the house at the same time. The camp's furnace and table belong to the quarry: they're never carried home or packed up to go exploring. Down the mine with no wood for a pickaxe handle, it keeps mining rather than climb out for a log.
- **Hungry with no food:** bread from wheat, the cooking in the furnace, ripe wheat, an animal nearby, or else it goes looking for animals. That comes before any other daytime job.
- **Night far from home** (over 128 blocks): it digs in where it is rather than walking home in the dark.
- **When every goal is done** it doesn't stop: every half minute it checks for anything to see to (nights at home, the farm, the chest, repairs), and it's free for orders in between.
- **Dying:** it keeps the spot where it died until it has actually been back and picked its things up. A fight, a swim or nightfall on the way no longer makes it forget.

**Water:** it swims at the surface, crosses rivers when that's shorter than walking around, climbs out onto banks, and never fights while swimming. If it ends up in water with no destination, it swims to the nearest land. It avoids waterfalls and water hanging over a drop.

**Chunks:** simulated players don't load chunks. The bot keeps a ticking area following it so it can roam beyond where you are.

## Jev

The request format was checked against docs.typesafe.ai/api and a live call (jev-1.13.0, about 0.4 s and roughly $0.000015 per call). Jev handles free-form orders ("stick with me buddy" becomes follow). Space and memory stay in code: distances, paths and remembered places need exact numbers, and Jev keeps nothing between calls. Put your key in `brain/config.json` as `{"jev_api_key": "..."}`. That file is git-ignored.

## Cost controls

Defaults are in `brain/config.example.json`. Copy it to `brain/config.json` to override.
- `jev_max_usd_per_day: 0.25`, `jev_max_calls_per_hour: 120`: hard caps. When hit, the bot silently falls back to rules.
- Jev is only asked about things rules can't settle. Examples: a creeper within 6 blocks is always "flee" with no call made, and a mob more than 10 blocks away is always "ignore".
- Snapshots are compact (about 100 tokens). At $0.042 per million tokens that's roughly $0.000004 per call.
- `GET http://127.0.0.1:8765/stats` shows decisions made by each layer and today's spend.

## Tests

**Watch them in your own game.** Stand somewhere open and type `!bot test all`, or a single test: `!bot test tower 12`, `!bot test roof`, `!bot test hole 3`, `!bot test pit`, `!bot test trap`, `!bot test climb`, `!bot test ledge`, `!bot test ladder`, `!bot test husk`, `!bot test shelter`, `!bot test sheep`, `!bot test smelt`, `!bot test house`, `!bot test corner` (1-high steps cut into a 2-high ledge), `!bot test leap` (a 1-wide trench to jump), `!bot test bridge` (a 3-wide, 7-deep chasm; 16 dirt given), `!bot test fall 16` (dropped with a water bucket). The sheep, smelt, house and bridge tests give the bot what they need (sheep, a furnace and logs, building materials, dirt). Each test builds its setup 10 blocks in front of you, runs the bot through it, says PASS or FAIL in chat with the numbers (time taken, blocks dug, health lost, closest distance to the husk), then puts every block back. The bot uses whatever it's carrying, so give it a pickaxe or sword first to test with one. Results also go to `brain/logs/tests.jsonl`, and everything the bot says goes to `brain/logs/events.jsonl`, so those files can be checked afterwards.

```powershell
npm run fuzz; node tools/fuzz_steps.mjs  # random worlds; the second uses a real-width body with Minecraft jump physics
npm test                         # pathfinder (incl. ladders), motor, threats, recipes, sourcing, costs, settle-in plan, house, focus, biomes, tactics, the house kept clear, eating (190 tests)
npm run fuzz                     # 200 random worlds: plan + walk + replan
npm run sim                      # the whole goal ladder played forward from nothing to done: no loops, no crafts it can't make, trips counted
node tools/sim_combat.mjs        # combat arena: zombies, skeletons and creepers on flat ground, forest, the quarry, a mine tunnel (-v for a log, --old for the old fight code)
node tools/sim_combat.mjs --fuzz 600   # random fights: terrain, mobs, gear, health
node tools/sim_combat.mjs --cornered 300 # cornered at the foot of jagged steps, no shield: knockback won't work (WALLS=0: without walling it off)
node tools/sim_combat.mjs --chase 300    # running at 5 hp from a zombie or spider catching up, on flat ground, forest, a mine tunnel (FLEEJAB=0: without jabbing)
node tools/sim_combat.mjs --deadend 300  # 2-3 zombies at the end of a mine tunnel (SLOT=0: without the kill slot)
node tools/sim_combat.mjs --archers 300  # 1-2 skeletons on flat ground, in a forest, at the quarry mouth (DODGE=0: no stepping aside)
node tools/sim_combat.mjs --witch 200    # witches, alone or with a zombie (WITCHFLEE=1: run from them, as before)
node tools/sim_combat.mjs --weapons 150  # the same fights with each loadout: swords, an axe, sword + spear, bow + sword
node tools/sim_combat.mjs --ambush 500   # creepers catching the bot in its quarry and mine (down the stairs behind it, dropped in, in the dark tunnel, from a side branch, on the stairs)
node tools/sim_quarry.mjs 300    # creeper craters in the quarry stairs: can it still get down and back up?
node tools/sim_quarry.mjs 300 --leave  # getting out of a damaged quarry the game's way, with the blocks it may spend (LEAVE=old: before)
node tools/sim_furnace.mjs       # the game's own furnace code against a stand-in game: jobs, several furnaces, restarts, fuel running out
node tools/sim_combat.mjs --pursuit 400  # running from a group: creepers speared, routes round them, up ledges and pillars (TOWER=0 AVOID=0 CJAB=0 CLIMB=0: without)
node tools/sim_combat.mjs --zombies 300  # zombie fights: hits taken, time a zombie was inside its reach
node tools/sim_life.mjs 50       # the whole game, first goal to last: the agent's own planner on a virtual clock in 10 kinds of world; stuck steps, mismatches, where the time goes
node tools/sim_home.mjs          # the house kept usable: a player's blocks, a bricked-up doorway at night, water, a blast, fire
node tools/sim_mine.mjs          # the branch mine across deaths and restarts: branches spaced, own tunnels never a "cave" (OLD=1: before)
node tools/sim_bed.mjs           # no fighting from bed: out of bed first when a mob gets to it
node tools/sim_drops.mjs         # chopping: its own drops tracked by id, picked up without stopping
node tools/sim_think.mjs 100     # the path searches a tree hunt makes (unreachable trees on cliff tops)
node tools/sim_fall.mjs          # breaking a fall with the water bucket: drops of 4-120 blocks
node tools/sim_house.mjs 400     # the house on plains, forest, dense dark-oak forest, jungle edge: site, clearing, does it run short? (FIXCOUNT=0: the old count)
node tools/stress_path.mjs 200   # walk dense forest on rough ground, jungle, ravines, cave mazes, hills and stairs, low tunnels, shafts, lake shores
python -m unittest discover -s brain/tests -t .   # brain (21 tests)
npm install; npm run typecheck # checks pack code against the real Script API typings
```

## Making the simulators match your game

`tools/sim_combat.mjs` is only as good as its numbers. Three ways to feed it real ones:

1. **`!bot test creeper`** (in game, somewhere open: it levels a stone lane and puts the area back afterwards; nothing explodes, since every creeper is removed the moment it stops to swell, or gets within 2.2). It measures, in your world: how fast a creeper walks, how close it gets before it stops to swell (it stands still while its fuse burns), and, for a stone sword and a stone spear swung once at 2.8, 3.2, 3.6, 4.0 and 4.4 blocks, whether the hit landed and how far it knocked the creeper back. It ends with a line `calibration.json: {...}`. Save that JSON as `tools/calibration.json` and the arena runs on your game's numbers instead of its guesses.
2. **The combat log.** With the brain running, every tick of a real creeper fight goes to `brain/logs/trace.jsonl`: distance, both positions, whether it's hissing, what the tactic chose (wait, back off, approach), which weapon swung, whether the hit registered, and every time the bot was hurt (cause, damage, distance). When a fight goes wrong, that file shows exactly how.
**Measured so far** (build u59, `tools/calibration.json`): a creeper walks 0.135 blocks a tick, stops to swell at 2.88 blocks, and is knocked back 1.21 blocks by a stone sword or a stone spear alike (sword 6 damage, spear 3). Every swing landed at every distance tried, up to 4.33 blocks, sword included: the game doesn't check the bot's reach that far. So reach is kept player-like by choice (sword about 3, spear 4), not by the game. On these numbers the arena prevents 97% of creeper encounters with spear and sword (92% with a sword alone).

3. **Night decisions** are in the same log (`dusk: ...`, `night in the mine: ...`): if it still heads home from the mine, the reason is there.

## Verified on a live server

Tested on Bedrock Dedicated Server 1.26.51: the pack loads, the bot spawns, turns and walks smoothly, drops and climbs single blocks, arrives within about 0.5 blocks, respawns after dying, and the brain round-trip works. `sim.move()` axis signs are correct as documented, so the automatic flip never triggered. The full wood → table → wooden tools → stone → stone tools loop, lake escapes and table and tree memory were also run live.

Debug from the server console: `scriptevent agent:cmd spawn`, `scriptevent agent:cmd debug` (logs position, plans, escape steps), `scriptevent agent:cmd goto 100 -20`, `scriptevent agent:cmd testcave 20` (teleports the bot into a cave at least 20 blocks away), `around` / `column` / `skyline` (print the blocks around it).

## Roadmap

1. ✅ Spawn, natural movement, pathfinding, follow, threat awareness, cost-capped brain
2. ✅ Break, place and craft; wood → table → wooden tools → stone → stone tools; swimming; world memory
3. ✅ Furnace, bed, charcoal and torches, food, a starter house, nights at home
4. Iron tools: find and mine iron, smelt it, iron pickaxe and sword
5. Jev tactical layer on combat and target selection; LLM recovery when stuck; LLM-proposed recipes validated by the solver and cached
6. Blueprint builder (`.mcstructure` → ordered placements, site selection)
7. Iron farm: villager transport and zombie capture
