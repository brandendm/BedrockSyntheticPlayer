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
  - `pathfinder.js`: incremental A* (walk 8 directions with no corner cutting, step up 1, drop up to 3, leap 1-block gaps, avoids lava, fire, cactus and similar). Runs through `system.runJob` so long searches never lag the server. Long trips are chained partial segments.
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
2. Looks for stone it can see. If there isn't any, it digs a one-wide staircase down: fists on dirt unless a wooden shovel is quicker, never the pickaxe on dirt, never straight down, never next to water or lava. Once the stairs are two steps into solid stone it stops going deeper and tunnels along that level (1x2, taking the stone walls beside its feet too, about 4 cobblestone per step), turning every 10 blocks so the tunnel stays compact and never heading under the house; if the tunnel runs into a cave, gravel or water it goes down a step and tunnels again.
3. Mines 8 cobblestone, then crafts a stone pickaxe and a stone sword.

**Settling in** (`core/settle.js`, done by `game/homestead.js`):
1. **Furnace:** 8 more cobblestone.
2. **Bed:** 3 wool of one colour from sheep it can see or remembers seeing, then a bed. It kills any easy food animal close by while it's low on food. If no sheep turn up, it comes back to the bed later.
3. **Torches:** it loads logs into the furnace with planks as fuel, goes off to do the next thing while they cook, and comes back for the charcoal. Charcoal plus sticks makes 8 torches.
4. **House** (`core/house.js`): a 5x5 cabin with cobblestone corners and bottom row, plank walls, a flat plank roof, a door, two small high windows, a torch inside and one each side of the door. The bed, crafting table and furnace go inside.
   - Materials: about 23 cobblestone and 12 logs.
   - Where: it picks the flattest clear spot within 16 blocks, never over trees, water or anything built.
   - How: it builds from the middle of the room, so it's done in about a minute.
   - Upgrades planned: glass in the windows, a chest, a trim.
5. **Food:** it eats when hunger drops to 14 (or when hurt and not full). It picks whatever wastes least, cooked before raw, and never eats raw chicken unless it's starving. Raw meat gets cooked when the furnace is free.

**Nights:** at dusk it drops what it's doing and goes home, shuts the door and sleeps in its bed. In the morning it comes back out. With no house yet, it builds one if it has the materials. Otherwise it digs in (3 blocks down in soft, dry ground, with a block over its head) or walls itself in with blocks, and climbs out in the morning.

**Reaching things up high:** a crafting table or furnace is used from anywhere within reach, not walked onto. If it's up a ledge, the bot walks to the foot of the wall and goes up a level the cheapest way: a throwaway block under its feet if it has one, otherwise a step cut into the wall.

**Not wasting things:** after a kill it waits for the drops to appear and then picks them all up. After chopping a tree it sweeps up every log that fell (and saplings). After mining it collects what's lying around. Anything it can't walk to (a log caught in leaves) is remembered for later. When it dies, it goes back for its things within the 5 minutes before they despawn. At night it only does this if they're close.

**Digging and building as part of a route:** like Baritone, the pathfinder can also plan dig-through, cut-a-step-up, pillar-up, bridge and dig-down moves. A bridge puts a block against the side of the one it stands on, over a gap 2+ deep or water, and walks onto it; later moves in the plan treat placed blocks as ground. Each is priced in seconds: break time with the best tool it has, the block it would place, and walking. So "tunnel 3 blocks" competes fairly with "walk 60 blocks round". It's used to get out of caves (one plan to the surface instead of a string of guesses) and whenever a place can't be reached on foot within 24 blocks. It never digs next to water or lava, under sand or gravel, or through anything built.

**Doors and fence gates:** routes go through wooden doors and gates. The bot opens them as it walks up and shuts them once it's a couple of blocks past, so animal pens stay shut. It only hunts animals it can actually walk up to, which stops it killing a cow across a fence it can't get round.

**Which mobs matter:**
- **Melee mobs:** it only reacts to ones it has seen recently and that can walk to it (a short path search from the mob). A zombie in the cave under its feet, behind a wall, or across a ravine doesn't make it drop what it's doing.
- **Water:** mobs in the water (drowned) are ignored unless they hit it.
- **Nowhere to run:** fleeing goes to the safest place it can actually reach. If nowhere is safer, it fights whatever is close, or carries on if nothing is.
- **Low on air:** under water with less than half its air left, it drops everything and swims for air. If it's sealed in, it digs up to reach air.

**Picking up where it left off:** what it's in the middle of is kept in the world file and written immediately for the house: the current step, the furnace it loaded (and how long is left), where its gear dropped when it died, and the house site. After a restart, a `/reload` or a death it says "Picking up where I left off" and carries on. The house's progress is read from the blocks actually placed, so it continues the same house on the same spot (`!bot test resume` checks exactly this). The dashboard shows the house's progress and what it still needs.

**The house is a project:** once it picks a site, the site is saved in the world. It gets every block it needs before placing the first one, never mines stone within 14 blocks of the site, finishes the house before chasing sheep or torches, and never starts a second one.

**Leaves:** it never walks on top of or through tree canopies; it goes around them.

**Around or through:** when the walking route to somewhere within 32 blocks winds well past the straight line (a mangrove swamp, a hedge of leaves, a dirt bank), it also prices a route that breaks through. Break time uses its best tool, in the same units as walking. It takes the break-through route if that's at least 15% quicker, and says so. Mangrove roots are solid ground it can stand on and cut through (axe; muddy roots with a shovel), not something to walk into.

**Steps and gaps:** step-ups are taken square-on. The bot lines its body up with the step block before jumping, so a 1-high step beside a 2-high wall doesn't turn into jumping into the seam between them. It counts a step as climbed only once it's standing on it, and takes it again if it bumps off. It jumps 1-block gaps (walking, from the edge, lined up) instead of climbing down and back out, but only over a gap it would survive falling into (ground or water within 3 blocks, no lava). If it isn't lined up by the edge, it backs up and tries again rather than walking off.

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

**Watch them in your own game.** Stand somewhere open and type `!bot test all`, or a single test: `!bot test tower 12`, `!bot test roof`, `!bot test hole 3`, `!bot test pit`, `!bot test trap`, `!bot test climb`, `!bot test ledge`, `!bot test ladder`, `!bot test husk`, `!bot test shelter`, `!bot test sheep`, `!bot test smelt`, `!bot test house`, `!bot test corner` (1-high steps cut into a 2-high ledge), `!bot test leap` (a 1-wide trench to jump), `!bot test bridge` (a 3-wide, 7-deep chasm; 16 dirt given). The sheep, smelt, house and bridge tests give the bot what they need (sheep, a furnace and logs, building materials, dirt). Each test builds its setup 10 blocks in front of you, runs the bot through it, says PASS or FAIL in chat with the numbers (time taken, blocks dug, health lost, closest distance to the husk), then puts every block back. The bot uses whatever it's carrying, so give it a pickaxe or sword first to test with one. Results also go to `brain/logs/tests.jsonl`, and everything the bot says goes to `brain/logs/events.jsonl`, so those files can be checked afterwards.

```powershell
npm run fuzz; node tools/fuzz_steps.mjs  # random worlds; the second uses a real-width body with Minecraft jump physics
npm test                         # pathfinder (incl. ladders), motor, threats, recipes, sourcing, costs, settle-in plan, house, focus, biomes (76 tests)
npm run fuzz                     # 200 random worlds: plan + walk + replan
python -m unittest discover -s brain/tests -t .   # brain (21 tests)
npm install; npm run typecheck # checks pack code against the real Script API typings
```

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
