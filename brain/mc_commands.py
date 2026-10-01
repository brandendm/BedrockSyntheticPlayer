"""Plain words -> Minecraft commands, chains included ("Make it day and clear weather").

Layers, cheapest first (the decision engine drives them):
  1. translate_clause   grammar: free, instant, covers time, weather, gamemode, give, effect, tp,
                        difficulty, gamerule, kill, summon, heal, feed, clear, xp, spawn point, say
  2. jev slots          (decisions.py) for a paraphrase the grammar misses: Jev picks the kind and
                        the finite slot ("it's too dark" -> time day); it can't write free text
  3. local LLM          writes the raw command; it is only used if validate() accepts it

Every command, whoever wrote it, goes through validate(): an allowlist of command names (nothing
that changes who may do what: op, ban, whitelist, permission...), at most 240 characters, one line,
and an `execute ... run <cmd>` is checked on the command it runs. The game checks again.
"""
from __future__ import annotations

import difflib
import re

ALLOWED = {
    "time", "weather", "gamemode", "give", "tp", "teleport", "effect", "difficulty", "gamerule",
    "kill", "summon", "setblock", "fill", "clear", "enchant", "xp", "title", "playsound", "particle",
    "spawnpoint", "setworldspawn", "execute", "say", "tellraw", "tag", "replaceitem", "clone",
    "fog", "camerashake", "music",
}
MAX_CHAIN = 6

NUMBER_WORDS = {"a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
                "eight": 8, "nine": 9, "ten": 10, "a couple": 2, "a couple of": 2, "a few": 3, "a dozen": 12,
                "a stack of": 64, "a stack": 64, "stack of": 64, "stacks of": 64, "some": 16, "lots of": 64}

ITEMS = """diamond emerald iron_ingot gold_ingot copper_ingot coal charcoal redstone lapis_lazuli quartz netherite_ingot
netherite_scrap obsidian cobblestone stone dirt grass_block sand gravel glass oak_planks spruce_planks birch_planks
oak_log spruce_log birch_log stick torch crafting_table furnace chest barrel anvil enchanting_table bookshelf
white_bed ender_chest brewing_stand beacon tnt flint_and_steel bucket water_bucket lava_bucket milk_bucket
wooden_pickaxe stone_pickaxe iron_pickaxe golden_pickaxe diamond_pickaxe netherite_pickaxe
wooden_axe stone_axe iron_axe golden_axe diamond_axe netherite_axe wooden_shovel stone_shovel iron_shovel
golden_shovel diamond_shovel netherite_shovel wooden_sword stone_sword iron_sword golden_sword diamond_sword
netherite_sword wooden_hoe stone_hoe iron_hoe diamond_hoe bow arrow crossbow trident shield elytra fishing_rod
shears compass clock map spyglass lead saddle name_tag totem_of_undying experience_bottle ender_pearl
eye_of_ender blaze_rod blaze_powder gunpowder bone bone_meal string feather leather paper book writable_book
leather_helmet leather_chestplate leather_leggings leather_boots iron_helmet iron_chestplate iron_leggings iron_boots
golden_helmet golden_chestplate golden_leggings golden_boots diamond_helmet diamond_chestplate diamond_leggings
diamond_boots netherite_helmet netherite_chestplate netherite_leggings netherite_boots chainmail_chestplate
bread apple golden_apple enchanted_golden_apple cooked_beef cooked_porkchop cooked_chicken cooked_mutton
cooked_salmon cooked_cod beef porkchop chicken carrot golden_carrot potato baked_potato melon_slice
pumpkin_pie cake cookie wheat wheat_seeds hay_block sugar_cane egg slime_ball sponge sea_lantern
rail powered_rail minecart boat oak_boat piston sticky_piston observer hopper dropper dispenser
lever stone_button oak_door iron_door oak_trapdoor ladder oak_fence oak_sign bed
white_wool glowstone netherrack soul_sand end_stone ice packed_ice snow_block clay_ball brick
shulker_box ender_eye dragon_egg command_block
""".split()
ALIASES = {"steak": "cooked_beef", "pork": "cooked_porkchop", "porkchops": "cooked_porkchop", "cobble": "cobblestone",
           "wood": "oak_log", "log": "oak_log", "plank": "oak_planks", "planks": "oak_planks", "wool": "white_wool",
           "bed": "white_bed", "lapis": "lapis_lazuli", "iron": "iron_ingot", "gold": "gold_ingot", "copper": "copper_ingot",
           "netherite": "netherite_ingot", "golden_apples": "golden_apple", "gapple": "golden_apple", "gapples": "golden_apple",
           "pearl": "ender_pearl", "pearls": "ender_pearl", "tnt": "tnt", "exp bottle": "experience_bottle", "xp bottle": "experience_bottle",
           "water": "water_bucket", "lava": "lava_bucket", "totem": "totem_of_undying", "food": "cooked_beef", "wooden_planks": "oak_planks",
           "stick": "stick", "sticks": "stick", "armor": "iron_chestplate", "flint and steel": "flint_and_steel"}
MOBS = """zombie skeleton creeper spider cave_spider enderman witch slime phantom drowned husk stray pillager vindicator
evoker ravager blaze ghast wither_skeleton piglin hoglin zombie_villager cow pig sheep chicken horse donkey mule llama
villager iron_golem snow_golem wolf cat ocelot parrot bat rabbit fox bee turtle dolphin squid panda polar_bear
goat axolotl frog camel allay zombified_piglin silverfish guardian elder_guardian shulker wandering_trader""".split()
EFFECTS = {"speed": "speed", "haste": "haste", "strength": "strength", "regeneration": "regeneration", "regen": "regeneration",
           "resistance": "resistance", "fire resistance": "fire_resistance", "night vision": "night_vision", "invisibility": "invisibility",
           "invisible": "invisibility", "jump boost": "jump_boost", "water breathing": "water_breathing", "slow falling": "slow_falling",
           "saturation": "saturation", "absorption": "absorption", "health boost": "health_boost", "levitation": "levitation",
           "glowing": "glowing", "conduit power": "conduit_power", "dolphins grace": "dolphins_grace", "luck": "luck"}
GAMERULES = {"keep inventory": "keepInventory", "keepinventory": "keepInventory", "mob griefing": "mobGriefing",
             "daylight cycle": "doDaylightCycle", "day night cycle": "doDaylightCycle", "weather cycle": "doWeatherCycle",
             "mob spawning": "doMobSpawning", "fire spread": "doFireTick", "fire tick": "doFireTick", "natural regeneration": "naturalRegeneration",
             "tnt explosions": "tntExplodes", "tnt": "tntExplodes", "pvp": "pvp", "show coordinates": "showCoordinates",
             "coordinates": "showCoordinates", "immediate respawn": "doImmediateRespawn", "insomnia": "doInsomnia",
             "command blocks": "commandBlocksEnabled", "drowning damage": "drowningDamage", "fall damage": "fallDamage",
             "fire damage": "fireDamage", "freeze damage": "freezeDamage", "mob loot": "doMobLoot", "tile drops": "doTileDrop",
             "entity drops": "doEntityDrops", "hunger": "naturalRegeneration"}
TIMES = {"day": "day", "daytime": "day", "morning": "sunrise", "dawn": "sunrise", "sunrise": "sunrise", "noon": "noon",
         "midday": "noon", "afternoon": "noon", "evening": "sunset", "sunset": "sunset", "dusk": "sunset", "night": "night",
         "nighttime": "night", "midnight": "midnight"}
GAMEMODES = {"survival": "survival", "creative": "creative", "adventure": "adventure", "spectator": "spectator",
             "s": "survival", "c": "creative", "a": "adventure", "sp": "spectator"}
DIFFICULTIES = {"peaceful": "peaceful", "easy": "easy", "normal": "normal", "medium": "normal", "hard": "hard"}
SPLIT = re.compile(r"\s*(?:,\s*(?:and\s+)?|;|\band then\b|\bthen\b|\band also\b|\balso\b|&|\band\b)\s*")
GIVE_VERBS = r"(?:give|get|spawn|i want|i need|i would like|can i have|gimme|hand|grab|bring)"


def validate(cmd: str, depth: int = 0) -> str | None:
    """The command with any leading slash dropped, if it is allowed; otherwise None."""
    c = " ".join(str(cmd).strip().lstrip("/").split())
    if not c or len(c) > 240 or "\n" in c or depth > 2:
        return None
    root = c.split(" ", 1)[0].lower()
    if root not in ALLOWED:
        return None
    if root == "execute":
        m = re.search(r"\brun\s+(.+)$", c)
        if not m or validate(m.group(1), depth + 1) is None:
            return None
    return c


def _sel(name: str) -> str:
    return name if name.startswith("@") else f'"{name}"'


def _who(clause: str, sender: str, bot: str) -> str:
    """Whom a clause is about: the speaker unless it names everyone or the bot."""
    t = f" {clause} "
    if re.search(r"\b(everyone|everybody|all players|all of us|us all|all of you)\b", t):
        return "@a"
    if re.search(rf"\b({re.escape(bot.lower())}|yourself|the bot|you)\b", t) and not re.search(r"\b(for|to) you\b.*\bme\b", t):
        return _sel(bot)
    return _sel(sender)


def _count(s: str | None, default: int = 1) -> int:
    if not s:
        return default
    s = s.strip().lower()
    if s.isdigit():
        return max(1, min(int(s), 2304))
    return NUMBER_WORDS.get(s, default)


def _item(name: str) -> str | None:
    """A Minecraft item id for a spoken name (plurals, spaces, close spellings), or None if it isn't close to any."""
    n = re.sub(r"\b(minecraft:|some|the|of|pieces?|blocks? of)\b", " ", name.lower())
    n = " ".join(n.split())
    if not n:
        return None
    cands = [n.replace(" ", "_")]
    for suf, rep in (("ies", "y"), ("es", ""), ("s", "")):
        if n.endswith(suf):
            cands.append((n[: -len(suf)] + rep).replace(" ", "_"))
    for c in cands:
        if c in ALIASES:
            return ALIASES[c]
        if c in ITEMS:
            return c
    for c in cands:
        m = difflib.get_close_matches(c, ITEMS, 1, 0.84)
        if m:
            return m[0]
    return None


def _mob(name: str) -> str | None:
    n = " ".join(name.lower().replace("minecraft:", "").split()).replace(" ", "_")
    for c in (n, n[:-1] if n.endswith("s") else n, n[:-2] if n.endswith("es") else n, n[:-3] + "y" if n.endswith("ies") else n):
        if c in MOBS:
            return c
    m = difflib.get_close_matches(n.rstrip("s"), MOBS, 1, 0.84)
    return m[0] if m else None


def _parse_item_phrase(p: str) -> tuple[int, str] | None:
    p = p.strip()
    m = re.match(r"^(\d+|a stack of|stacks? of|a dozen|a couple of|a couple|a few|lots of|some|an?|one|two|three|four|five|six|seven|eight|nine|ten)?\s*(.+)$", p)
    if not m:
        return None
    item = _item(m.group(2))
    return (_count(m.group(1)), item) if item else None


def translate_clause(clause: str, sender: str, bot: str = "Scout", last_give: str | None = None) -> list[str] | None:
    """One clause -> commands, or None if the grammar doesn't know it."""
    t = " ".join(clause.lower().strip().rstrip(".!?").split())
    t = re.sub(r"^(?:please|pls|can you|could you|would you|will you|hey|ok|okay|just|go ahead and|i want you to|i'd like you to|make sure to)\s+", "", t)
    t = re.sub(r"\s+(?:please|pls|for me|thanks|thank you)$", "", t)
    if not t:
        return None
    who = _who(t, sender, bot)

    # raw: "/time set day" or "run /gamemode creative"
    m = re.match(r"^(?:run |do |execute )?/(.+)$", clause.strip().rstrip(".!"))
    if m:
        c = validate(m.group(1))
        return [c] if c else None

    # say
    m = re.match(r"^(?:say|announce|tell everyone|shout)\s+(.+)$", clause.strip().rstrip("."), re.I)
    if m:
        return [f"say {m.group(1)}"]

    # effects first: "give me speed 2 for 5 minutes", "make me invisible"
    if re.search(r"\b(?:clear|remove|cure|get rid of|stop)\b.*\b(?:effects?|potions?)\b", t):
        return [f"effect {who} clear"]
    for name, eff in sorted(EFFECTS.items(), key=lambda kv: -len(kv[0])):
        if re.search(rf"\b{re.escape(name)}\b", t) and re.search(r"\b(give|make|gimme|i want|i need|apply|effect|boost|with)\b|^" + re.escape(name), t) \
                and not re.search(r"\b(sword|boots|pickaxe|potion of|bucket)\b", t) and not (eff in ("glowing", "luck") and "give" not in t):
            lvl = re.search(r"\b(?:level|lvl|tier)?\s*(\d{1,3})\b(?!\s*(?:s|sec|seconds|min|minutes|m)\b)", t)
            level = max(0, int(lvl.group(1)) - 1) if lvl and "for" not in t[: lvl.start()].split()[-1:] else 1
            dur = re.search(r"(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|h)\b", t)
            secs = 600
            if dur:
                u = dur.group(2)[0]
                secs = int(dur.group(1)) * (3600 if u == "h" else 60 if u == "m" else 1)
            if "forever" in t or "infinite" in t:
                secs = 1000000
            return [f"effect {who} {eff} {min(secs, 1000000)} {min(level, 255)} true"]

    # gamemode
    gm = re.search(r"\b(survival|creative|adventure|spectator)\b", t)
    if gm and re.search(r"\b(game ?mode|mode|make|set|switch|change|put|turn|let|i want|gm|be)\b|^" + gm.group(1), t) and not re.search(r"\b(give|summon|spawn)\b", t):
        return [f"gamemode {gm.group(1)} {who}"]
    m = re.match(r"^(?:gm|gamemode|game mode)\s*([scasp]{1,2}|\d)$", t)
    if m:
        v = {"0": "survival", "1": "creative", "2": "adventure", "3": "spectator"}.get(m.group(1)) or GAMEMODES.get(m.group(1))
        return [f"gamemode {v} {who}"] if v else None

    # time
    if not re.search(r"\b(effect|gamerule|rule)\b", t):
        if re.search(r"\b(skip|pass|get through|fast forward|speed up)\b.*\b(night|nighttime)\b|\bsleep(?: through)? the night\b", t):
            return ["time set sunrise"]
        m = re.search(r"\b(?:time|it(?:'s| is)? ?(?:to be)?|make it|set it|turn it|change it|let it be|be)\b.*?\b(daytime|nighttime|day|night|noon|midnight|sunrise|sunset|morning|dawn|dusk|evening|afternoon|midday)\b", t)
        if m and not re.search(r"\b(weather|rain|storm|thunder|give|clear my)\b", t) and re.search(r"\b(make|set|change|turn|time|let|be|should|skip)\b", t):
            return [f"time set {TIMES[m.group(1)]}"]
        m = re.search(r"\btime\b.*?\b(\d{1,6})\b", t) or re.match(r"^set time (\d{1,6})$", t)
        if m and re.search(r"\b(set|change|make)\b", t):
            return [f"time set {int(m.group(1))}"]
        if re.search(r"\b(freeze|stop|pause|lock)\b.*\b(time|day|sun|daylight)\b", t):
            return ["gamerule doDaylightCycle false"]
        if re.search(r"\b(unfreeze|resume|restart|start)\b.*\b(time|day|sun|daylight)\b", t):
            return ["gamerule doDaylightCycle true"]

    # weather
    if re.search(r"\b(weather|rain|raining|rainy|storm|stormy|thunder|thunderstorm|sunny|sun|skies|sky|clear)\b", t) \
            and not re.search(r"\b(inventory|effects?|chat|my|drops?|items?|mobs?)\b", t.replace("clear my", "clear_my")) \
            or re.match(r"^clear (?:the )?(?:weather|skies|sky)$", t):
        if re.search(r"\b(thunder|thunderstorm|storm|stormy|lightning)\b", t) and not re.search(r"\b(stop|end|no|clear|cancel|without|remove|off|get rid)\b", t):
            return ["weather thunder"]
        if re.search(r"\b(rain|raining|rainy|wet|shower|drizzle)\b", t) and not re.search(r"\b(stop|end|no|clear|cancel|without|remove|off|get rid|dry)\b", t):
            return ["weather rain"]
        if re.search(r"\b(clear|sunny|sun|fair|stop|end|no|cancel|remove|off|get rid|skies|sky|dry|good weather|nice weather)\b", t):
            return ["weather clear"]
        if re.search(r"\bweather\b", t) and re.search(r"\b(rain|thunder|storm)\b", t):
            return ["weather rain"]

    # difficulty
    m = re.search(r"\b(peaceful|easy|normal|hard|medium)\b", t)
    if m and re.search(r"\b(difficulty|mode|make (?:it|the game)|set|turn)\b", t) and not re.search(r"\b(give|gamemode|effect)\b", t):
        return [f"difficulty {DIFFICULTIES[m.group(1)]}"]

    # gamerules: "turn on keep inventory", "disable mob griefing", "gamerule keepinventory true"
    m = re.match(r"^gamerule\s+(\w+)\s+(true|false|\d+)$", t)
    if m:
        return [f"gamerule {m.group(1)} {m.group(2)}"]
    for name, rule in sorted(GAMERULES.items(), key=lambda kv: -len(kv[0])):
        if name in t:
            off = re.search(r"\b(off|disable|disabled|stop|no|false|don'?t|prevent|turn off|without)\b", t)
            on = re.search(r"\b(on|enable|enabled|allow|true|start|keep|turn on|with)\b", t)
            if off or on:
                return [f"gamerule {rule} {'false' if off and not (on and on.group(0) not in ('keep', 'with')) else 'true'}"]

    # teleport
    m = re.match(rf"^(?:tp|teleport|take|send|bring|warp|move)\s+(me|us|myself|everyone|everybody|you|yourself|{re.escape(bot.lower())}|\w+)?\s*(?:to|at)?\s*(-?\d+(?:\.\d+)?)[\s,]+(-?\d+(?:\.\d+)?)[\s,]+(-?\d+(?:\.\d+)?)$", t)
    if m:
        subj = m.group(1) or "me"
        target = "@a" if subj in ("us", "everyone", "everybody") else _sel(bot) if subj in ("you", "yourself", bot.lower()) else _sel(sender) if subj in ("me", "myself", "to") else _sel(subj)
        return [f"tp {target} {m.group(2)} {m.group(3)} {m.group(4)}"]
    m = re.match(rf"^(?:tp|teleport|take|send|bring|warp|move)\s+(me|myself|us|everyone|everybody|you|yourself|{re.escape(bot.lower())}|\w+)\s+to\s+(me|myself|spawn|world spawn|\w+)$", t)
    if m:
        a, b = m.group(1), m.group(2)
        who_a = "@a" if a in ("us", "everyone", "everybody") else _sel(bot) if a in ("you", "yourself", bot.lower()) else _sel(sender) if a in ("me", "myself") else _sel(a)
        who_b = _sel(sender) if b in ("me", "myself") else _sel(b)
        return [f"tp {who_a} {who_b}"] if who_a != who_b else None
    m = re.match(rf"^(?:tp|teleport|warp)\s+(?:me\s+)?to\s+(\w+)$", t)
    if m:
        return [f"tp {_sel(sender)} {_sel(m.group(1))}"]
    m = re.match(r"^(?:tp|teleport|take me|warp)\s+(?:me\s+)?(?:to\s+)?(up|down|the surface)$", t)
    if m:
        return [f"tp {_sel(sender)} ~ ~{50 if m.group(1) == 'up' else -20} ~"] if m.group(1) in ("up", "down") else None

    # kill
    m = re.match(r"^(?:kill|remove|clear|get rid of|delete|despawn|slay|murder|exterminate|wipe out)\s+(?:all |every |the |nearby |all the |every single )*(.+)$", t)
    if m:
        what = m.group(1).strip()
        if what in ("me", "myself"):
            return [f"kill {_sel(sender)}"]
        if re.match(r"^(?:hostile |hostiles|monsters?|enemies|bad guys|hostile mobs?|mobs?)$", what) or what in ("hostile", "hostile mobs", "monsters", "enemies", "mobs"):
            return ["kill @e[family=monster]"]
        if what in ("items", "item", "drops", "dropped items", "loot", "the items on the ground", "item drops", "litter"):
            return ["kill @e[type=item]"]
        if what in ("xp", "xp orbs", "experience orbs", "orbs"):
            return ["kill @e[type=xp_orb]"]
        if what in ("arrows",):
            return ["kill @e[type=arrow]"]
        mob = _mob(what)
        if mob:
            return [f"kill @e[type={mob}]"]
    # clear inventory
    if re.match(r"^(?:clear|empty|wipe)\s+(?:my |the |your )?(?:whole |entire )?(?:inventory|pack|backpack|items)$", t):
        return [f"clear {_sel(bot) if re.search(r'your', t) else who}"]

    # heal / feed
    if re.search(r"\b(heal|full health|restore (?:my )?health|fix my health|revive)\b", t) and not re.search(r"\b(effect|potion)\b", t):
        return [f"effect {who} instant_health 1 255 true", f"effect {who} regeneration 10 4 true"]
    if re.search(r"\b(feed|fill (?:my )?(?:hunger|food)|i'?m (?:so )?(?:hungry|starving)|full hunger|no hunger|restore (?:my )?(?:hunger|food))\b", t):
        return [f"effect {who} saturation 5 255 true"]

    # xp
    m = re.search(r"\b(?:give|gimme|add|i want|i need|get)\b.*?(\d+)\s*(?:xp )?(levels?|lvls?|xp|experience|exp)\b", t)
    if m:
        lv = m.group(2).startswith("l")
        return [f"xp {m.group(1)}{'L' if lv else ''} {who}"]
    if re.search(r"\b(max|full)\b.*\b(level|xp|levels)\b", t):
        return [f"xp 100L {who}"]

    # spawn point
    if re.search(r"\b(set|make)\b.*\b(my )?(?:respawn|spawn ?point|spawn)\b.*\b(here|there|now)?$", t) and not re.search(r"\b(zombie|mob|spawn (?:a|an|\d))\b", t) and "world" not in t:
        return [f"spawnpoint {who}"]
    if re.search(r"\bset (?:the )?world spawn\b", t):
        return [f"execute as {_sel(sender)} at @s run setworldspawn ~ ~ ~"]

    # summon: "spawn 3 zombies", "summon a creeper"
    m = re.match(r"^(?:summon|spawn|create|make|add|put|give me)\s+(?:me )?(\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten)?\s*(.+?)(?:\s+(?:here|near me|next to me|around me|by me))?$", t)
    if m:
        mob = _mob(m.group(2))
        if mob:
            n = min(_count(m.group(1)), 20)
            return [f"execute as {_sel(sender)} at @s run summon {mob} ~ ~ ~"] * n

    # give: "give me 3 diamonds", "i need a diamond pickaxe", "give 64 cobblestone to steve"
    m = re.match(rf"^{GIVE_VERBS}\s+(?:(me|us|everyone|everybody|myself|you|yourself)\s+)?(.+?)(?:\s+to\s+(\w+))?$", t)
    if m or last_give:
        if m:
            target = m.group(3) if m.group(3) and m.group(3) not in ("me", "myself") else None
            who_g = _sel(target) if target else "@a" if m.group(1) in ("us", "everyone", "everybody") else _sel(bot) if m.group(1) in ("you", "yourself") else _sel(sender)
            body = m.group(2)
        else:
            who_g, body = last_give, t
        out = []
        for part in [p for p in re.split(r"\s*(?:,|\band\b|&)\s*", body) if p.strip()]:
            it = _parse_item_phrase(part)
            if not it:
                return None if not out else out
            n, item = it
            out.append(f"give {who_g} {item} {min(n, 2304)}")
        return out[:MAX_CHAIN] or None
    return None


def split_chain(text: str) -> list[str]:
    """"make it day and clear weather" -> two clauses (a give list stays whole: "3 diamonds and a shield")."""
    t = " ".join(text.strip().split())
    m = re.match(rf"^(?:please |can you |could you )?{GIVE_VERBS}\b", t, re.I)
    if m and not re.search(r"\b(and|then|also)\s+(make|set|clear|change|turn|kill|tp|teleport|summon|heal|feed|give me (?:speed|haste|strength|regeneration|night vision))\b", t, re.I):
        return [t]
    return [c for c in SPLIT.split(t) if c.strip()]


def translate(text: str, sender: str, bot: str = "Scout", other=None) -> tuple[list, list[str]]:
    """(items, clauses nobody could read). An item is a command string, or, if `other(clause)` (the
    bot's own grammar) read the clause, the list of bot actions it made. Order is kept: "come here and
    make it day". Items following a give or a kill carry on it ("3 diamonds and a shield", "kill
    zombies and creepers")."""
    items: list = []
    unknown: list[str] = []
    last_give: str | None = None
    last_verb: str | None = None
    for clause in split_chain(text):
        acts = other(clause) if other else None
        if acts:
            items.append(acts)
            last_give = last_verb = None
            continue
        r = translate_clause(clause, sender, bot, last_give)
        if r is None and last_verb:
            r = translate_clause(f"{last_verb} {clause}", sender, bot)
        if r:
            items.extend(c for c in r if validate(c))
            m = re.match(r"^give (\S+|\"[^\"]+\") ", r[-1])
            last_give = m.group(1) if m else None
            v = re.match(r"^(kill|summon|spawn)\b", " ".join(clause.lower().split()))
            last_verb = v.group(1) if v else None
        else:
            unknown.append(clause)
            last_give = last_verb = None
    return items[: MAX_CHAIN * 3], unknown
